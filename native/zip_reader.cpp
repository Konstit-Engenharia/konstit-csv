#ifdef CSV_USE_APPLE_ZLIB
#include <zlib.h>
using zip_inflate_stream = z_stream;
#define CSV_ZLIB(name) name
#else
#include <zlib-ng.h>
using zip_inflate_stream = zng_stream;
#define CSV_ZLIB(name) zng_##name
#endif

#include <algorithm>
#include <array>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <pthread.h>
#include <string>
#include <string_view>
#include <sys/types.h>
#include <vector>

#if defined(_WIN32)
#define CSV_EXPORT extern "C" __declspec(dllexport)
#else
#define CSV_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace csv_native {

namespace {

constexpr uint32_t local_file_header_signature = 0x04034b50;
constexpr uint32_t central_directory_header_signature = 0x02014b50;
constexpr uint32_t end_of_central_directory_signature = 0x06054b50;
constexpr uint32_t zip64_end_of_central_directory_signature = 0x06064b50;
constexpr uint32_t zip64_end_of_central_directory_locator_signature = 0x07064b50;
constexpr uint16_t zip64_extra_field_id = 0x0001;
constexpr uint16_t stored_method = 0;
constexpr uint16_t deflate_method = 8;
constexpr uint16_t encrypted_flag = 1U << 0;
constexpr uint16_t strong_encryption_flag = 1U << 6;
constexpr uint16_t masked_header_values_flag = 1U << 13;
constexpr size_t local_file_header_size = 30;
constexpr size_t central_directory_header_size = 46;
constexpr size_t end_of_central_directory_size = 22;
constexpr size_t maximum_zip_comment_size = 65'535;
constexpr size_t inflate_input_size = 256 * 1024;

uint16_t read_u16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) | static_cast<uint16_t>(static_cast<uint16_t>(data[1]) << 8U);
}

uint32_t read_u32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8U) |
         (static_cast<uint32_t>(data[2]) << 16U) | (static_cast<uint32_t>(data[3]) << 24U);
}

uint64_t read_u64(const uint8_t* data) {
  return static_cast<uint64_t>(read_u32(data)) | (static_cast<uint64_t>(read_u32(data + 4)) << 32U);
}

bool add_within(uint64_t left, uint64_t right, uint64_t upper_bound, uint64_t& result) {
  if (right > upper_bound || left > upper_bound - right) {
    return false;
  }
  result = left + right;
  return result <= upper_bound;
}

bool is_os_metadata_entry(std::string_view name) {
  for (size_t separator = name.find('/'); separator != std::string_view::npos; separator = name.find('/')) {
    const std::string_view directory = name.substr(0, separator);
    if (directory == "__MACOSX" || directory == ".AppleDouble") {
      return true;
    }
    name.remove_prefix(separator + 1);
  }
  if (name.starts_with("._")) {
    return true;
  }

  constexpr std::array<std::string_view, 5> metadata_names = {".ds_store", "thumbs.db", "ehthumbs.db",
                                                              "ehthumbs_vista.db", "desktop.ini"};
  return std::any_of(metadata_names.begin(), metadata_names.end(), [name](std::string_view metadata_name) {
    return std::equal(name.begin(), name.end(), metadata_name.begin(), metadata_name.end(),
                      [](char character, char expected) {
                        if (character >= 'A' && character <= 'Z') {
                          character = static_cast<char>(character + ('a' - 'A'));
                        }
                        return character == expected;
                      });
  });
}

enum class zip_reader_status : int {
  reading = 0,
  done = 1,
  error = 2,
};

struct zip_entry_metadata {
  uint16_t flags = 0;
  uint16_t method = 0;
  uint32_t expected_crc32 = 0;
  uint64_t compressed_size = 0;
  uint64_t uncompressed_size = 0;
  uint64_t local_header_offset = 0;
};

struct zip_read_ahead {
  std::unique_ptr<uint8_t[]> buffer;
  uint32_t capacity = 0;
  uint32_t offset = 0;
  uint32_t size = 0;
  std::mutex mutex;
  std::condition_variable changed;
  bool ready = false;
  bool stopping = false;
  pthread_t thread{};
  // Only the consumer updates this. A prefetched EOF or error belongs to its own chunk.
  zip_reader_status delivered_status = zip_reader_status::reading;
};

} // namespace

class zip_reader {
public:
  zip_reader(const char* path, const uint8_t* entry_name, size_t entry_name_len, uint64_t maximum_output_size,
             uint32_t maximum_compression_ratio)
      : maximum_output_size_(maximum_output_size), maximum_compression_ratio_(maximum_compression_ratio) {
    if (path == nullptr) {
      fail("ZIP path is null");
      return;
    }
    if (entry_name == nullptr || entry_name_len == 0) {
      fail("ZIP entry name must not be empty");
      return;
    }
    if (maximum_output_size == 0) {
      fail("ZIP maximum decompressed byte count must be positive");
      return;
    }
    if (maximum_compression_ratio == 0) {
      fail("ZIP maximum compression ratio must be positive");
      return;
    }

    entry_name_.assign(reinterpret_cast<const char*>(entry_name), entry_name_len);
    if (entry_name_.back() == '/') {
      fail("ZIP entry is a directory");
      return;
    }

    file_ = std::fopen(path, "rb");
    if (file_ == nullptr) {
      fail("failed to open ZIP file");
      return;
    }
    if (!find_file_size() || !locate_entry() || !open_entry()) {
      return;
    }
  }

  ~zip_reader() {
    stop_read_ahead();
    close_inflate();
    if (file_ != nullptr) {
      std::fclose(file_);
    }
  }

  zip_reader(const zip_reader&) = delete;
  zip_reader& operator=(const zip_reader&) = delete;

  void enable_read_ahead(uint32_t chunk_size) {
    // Amortize the handoff even for consumers requesting a few bytes at a time.
    const uint32_t capacity = std::max(chunk_size, uint32_t{64 * 1024});
    if (ahead_ || status_ != zip_reader_status::reading || entry_.uncompressed_size <= capacity) {
      return;
    }
    ahead_.reset(new (std::nothrow) zip_read_ahead);
    if (!ahead_) {
      return;
    }
    ahead_->capacity = capacity;
    ahead_->buffer.reset(new (std::nothrow) uint8_t[capacity]);
    // Continue reading synchronously if a spare buffer or thread is unavailable.
    const auto produce = [](void* self) -> void* {
      static_cast<zip_reader*>(self)->produce_chunks();
      return nullptr;
    };
    if (!ahead_->buffer || pthread_create(&ahead_->thread, nullptr, produce, this) != 0) {
      ahead_.reset();
    }
  }

  uint64_t read(uint8_t* output, uint64_t output_capacity) {
    if (status() != zip_reader_status::reading) {
      return 0;
    }
    if (output == nullptr || output_capacity == 0) {
      stop_read_ahead();
      fail("ZIP output buffer must not be empty");
      return 0;
    }

    const uint32_t bounded_capacity =
        static_cast<uint32_t>(std::min<uint64_t>(output_capacity, std::numeric_limits<uint32_t>::max()));
    if (!ahead_) {
      return read_entry(output, bounded_capacity);
    }
    auto& ahead = *ahead_;
    std::unique_lock lock(ahead.mutex);
    ahead.changed.wait(lock, [&] { return ahead.ready; });
    const uint32_t size = std::min(bounded_capacity, ahead.size - ahead.offset);
    // The producer owns its buffer and never holds a pointer into the Bun heap.
    std::memcpy(output, ahead.buffer.get() + ahead.offset, size);
    ahead.offset += size;
    if (ahead.offset == ahead.size) {
      ahead.delivered_status = status_;
      ahead.ready = false;
      lock.unlock();
      ahead.changed.notify_one();
    }
    return size;
  }

  zip_reader_status status() const { return ahead_ ? ahead_->delivered_status : status_; }

  const char* last_error() const { return status() == zip_reader_status::error ? error_.c_str() : ""; }

private:
  uint64_t read_entry(uint8_t* output, uint32_t capacity) {
    return entry_.method == stored_method ? read_stored(output, capacity) : read_deflated(output, capacity);
  }

  void produce_chunks() {
    auto& ahead = *ahead_;
    std::unique_lock lock(ahead.mutex);
    while (true) {
      ahead.changed.wait(lock, [&] { return !ahead.ready || ahead.stopping; });
      if (ahead.stopping) {
        return;
      }
      const auto written = read_entry(ahead.buffer.get(), ahead.capacity);
      ahead.size = status_ == zip_reader_status::error ? 0 : static_cast<uint32_t>(written);
      ahead.offset = 0;
      ahead.ready = true;
      ahead.changed.notify_one();
      if (status_ != zip_reader_status::reading) {
        return;
      }
    }
  }

  void stop_read_ahead() {
    if (ahead_) {
      {
        std::lock_guard lock(ahead_->mutex);
        ahead_->stopping = true;
      }
      ahead_->changed.notify_one();
      pthread_join(ahead_->thread, nullptr);
      ahead_.reset();
    }
  }

  bool find_file_size() {
    if (::fseeko(file_, 0, SEEK_END) != 0) {
      return fail("failed to seek ZIP file");
    }
    const off_t end = ::ftello(file_);
    if (end < 0) {
      return fail("failed to determine ZIP file size");
    }
    file_size_ = static_cast<uint64_t>(end);
    return true;
  }

  bool seek(uint64_t offset) {
    if (offset > static_cast<uint64_t>(std::numeric_limits<off_t>::max())) {
      return fail("ZIP offset exceeds the platform file limit");
    }
    if (::fseeko(file_, static_cast<off_t>(offset), SEEK_SET) != 0) {
      return fail("failed to seek ZIP file");
    }
    return true;
  }

  bool read_exact_at(uint64_t offset, uint8_t* output, size_t length) {
    uint64_t end = 0;
    if (!add_within(offset, length, file_size_, end)) {
      return fail("ZIP structure points outside the file");
    }
    if (!seek(offset)) {
      return false;
    }
    if (length != 0 && std::fread(output, 1, length, file_) != length) {
      return fail("failed to read ZIP structure");
    }
    return true;
  }

  bool locate_entry() {
    if (file_size_ < end_of_central_directory_size) {
      return fail("ZIP file is too small");
    }

    const uint64_t tail_size = std::min<uint64_t>(file_size_, end_of_central_directory_size + maximum_zip_comment_size);
    const uint64_t tail_offset = file_size_ - tail_size;
    std::vector<uint8_t> tail(static_cast<size_t>(tail_size));
    if (!read_exact_at(tail_offset, tail.data(), tail.size())) {
      return false;
    }

    size_t end_record_index = tail.size();
    for (size_t index = tail.size() - end_of_central_directory_size + 1; index-- > 0;) {
      if (read_u32(tail.data() + index) != end_of_central_directory_signature) {
        continue;
      }
      const uint16_t comment_size = read_u16(tail.data() + index + 20);
      if (index + end_of_central_directory_size + comment_size == tail.size()) {
        end_record_index = index;
        break;
      }
    }
    if (end_record_index == tail.size()) {
      return fail("ZIP end-of-central-directory record was not found");
    }

    const uint8_t* end_record = tail.data() + end_record_index;
    const uint64_t end_record_offset = tail_offset + end_record_index;
    const uint16_t disk_number = read_u16(end_record + 4);
    const uint16_t central_directory_disk = read_u16(end_record + 6);
    const uint16_t entries_on_disk_16 = read_u16(end_record + 8);
    const uint16_t entry_count_16 = read_u16(end_record + 10);
    const uint32_t central_directory_size_32 = read_u32(end_record + 12);
    const uint32_t central_directory_offset_32 = read_u32(end_record + 16);

    uint64_t entry_count = entry_count_16;
    uint64_t central_directory_size = central_directory_size_32;
    uint64_t central_directory_offset = central_directory_offset_32;
    const bool needs_zip64 = entries_on_disk_16 == std::numeric_limits<uint16_t>::max() ||
                             entry_count_16 == std::numeric_limits<uint16_t>::max() ||
                             central_directory_size_32 == std::numeric_limits<uint32_t>::max() ||
                             central_directory_offset_32 == std::numeric_limits<uint32_t>::max();

    if (needs_zip64) {
      if (end_record_offset < 20) {
        return fail("ZIP64 locator is missing");
      }
      std::array<uint8_t, 20> locator{};
      if (!read_exact_at(end_record_offset - locator.size(), locator.data(), locator.size())) {
        return false;
      }
      if (read_u32(locator.data()) != zip64_end_of_central_directory_locator_signature) {
        return fail("ZIP64 locator is invalid");
      }
      if (read_u32(locator.data() + 4) != 0 || read_u32(locator.data() + 16) != 1) {
        return fail("multi-disk ZIP archives are not supported");
      }

      const uint64_t zip64_end_offset = read_u64(locator.data() + 8);
      std::array<uint8_t, 56> zip64_end{};
      if (!read_exact_at(zip64_end_offset, zip64_end.data(), zip64_end.size())) {
        return false;
      }
      if (read_u32(zip64_end.data()) != zip64_end_of_central_directory_signature ||
          read_u64(zip64_end.data() + 4) < 44) {
        return fail("ZIP64 end-of-central-directory record is invalid");
      }
      if (read_u32(zip64_end.data() + 16) != 0 || read_u32(zip64_end.data() + 20) != 0 ||
          read_u64(zip64_end.data() + 24) != read_u64(zip64_end.data() + 32)) {
        return fail("multi-disk ZIP archives are not supported");
      }
      entry_count = read_u64(zip64_end.data() + 32);
      central_directory_size = read_u64(zip64_end.data() + 40);
      central_directory_offset = read_u64(zip64_end.data() + 48);
    } else if (disk_number != 0 || central_directory_disk != 0 || entries_on_disk_16 != entry_count_16) {
      return fail("multi-disk ZIP archives are not supported");
    }

    uint64_t central_directory_end = 0;
    if (!add_within(central_directory_offset, central_directory_size, end_record_offset, central_directory_end)) {
      return fail("ZIP central directory is outside the file");
    }
    if (entry_count > central_directory_size / central_directory_header_size) {
      return fail("ZIP central directory entry count is invalid");
    }

    const bool select_only_file = entry_name_ == "*";
    bool found = false;
    uint64_t cursor = central_directory_offset;
    for (uint64_t entry_index = 0; entry_index < entry_count; ++entry_index) {
      std::array<uint8_t, central_directory_header_size> header{};
      if (!read_exact_at(cursor, header.data(), header.size())) {
        return false;
      }
      if (read_u32(header.data()) != central_directory_header_signature) {
        return fail("ZIP central directory header is invalid");
      }

      const uint16_t name_size = read_u16(header.data() + 28);
      const uint16_t extra_size = read_u16(header.data() + 30);
      const uint16_t comment_size = read_u16(header.data() + 32);
      uint64_t variable_size = static_cast<uint64_t>(name_size) + extra_size + comment_size;
      uint64_t next_cursor = 0;
      if (!add_within(cursor, central_directory_header_size + variable_size, central_directory_end, next_cursor)) {
        return fail("ZIP central directory entry is truncated");
      }

      std::vector<uint8_t> name(name_size);
      if (!read_exact_at(cursor + central_directory_header_size, name.data(), name.size())) {
        return false;
      }
      const bool is_file = !name.empty() && name.back() != '/';
      const bool matches =
          select_only_file
              ? is_file &&
                    !is_os_metadata_entry(std::string_view(reinterpret_cast<const char*>(name.data()), name.size()))
              : name.size() == entry_name_.size() && std::memcmp(name.data(), entry_name_.data(), name.size()) == 0;
      if (matches) {
        if (found) {
          if (select_only_file) {
            return fail("ZIP entry '*' requires exactly one file in the archive");
          }
          return fail("ZIP contains duplicate entries with the requested name");
        }
        std::vector<uint8_t> extra(extra_size);
        if (!read_exact_at(cursor + central_directory_header_size + name_size, extra.data(), extra.size())) {
          return false;
        }
        if (!parse_entry_metadata(header, extra)) {
          return false;
        }
        if (select_only_file) {
          entry_name_.assign(reinterpret_cast<const char*>(name.data()), name.size());
        }
        found = true;
      }
      cursor = next_cursor;
    }

    if (!found) {
      if (select_only_file) {
        return fail("ZIP entry '*' requires exactly one file in the archive");
      }
      return fail("requested ZIP entry was not found");
    }
    central_directory_offset_ = central_directory_offset;
    return true;
  }

  bool parse_entry_metadata(const std::array<uint8_t, central_directory_header_size>& header,
                            const std::vector<uint8_t>& extra) {
    entry_.flags = read_u16(header.data() + 8);
    entry_.method = read_u16(header.data() + 10);
    entry_.expected_crc32 = read_u32(header.data() + 16);
    const uint32_t compressed_size_32 = read_u32(header.data() + 20);
    const uint32_t uncompressed_size_32 = read_u32(header.data() + 24);
    const uint16_t disk_start_16 = read_u16(header.data() + 34);
    const uint32_t local_header_offset_32 = read_u32(header.data() + 42);
    entry_.compressed_size = compressed_size_32;
    entry_.uncompressed_size = uncompressed_size_32;
    entry_.local_header_offset = local_header_offset_32;
    uint32_t disk_start = disk_start_16;

    const bool needs_zip64 = compressed_size_32 == std::numeric_limits<uint32_t>::max() ||
                             uncompressed_size_32 == std::numeric_limits<uint32_t>::max() ||
                             local_header_offset_32 == std::numeric_limits<uint32_t>::max() ||
                             disk_start_16 == std::numeric_limits<uint16_t>::max();
    if (needs_zip64 && !parse_zip64_extra(extra, compressed_size_32, uncompressed_size_32, local_header_offset_32,
                                          disk_start_16, disk_start)) {
      return false;
    }

    if (disk_start != 0) {
      return fail("multi-disk ZIP archives are not supported");
    }
    return true;
  }

  bool parse_zip64_extra(const std::vector<uint8_t>& extra, uint32_t compressed_size_32, uint32_t uncompressed_size_32,
                         uint32_t local_header_offset_32, uint16_t disk_start_16, uint32_t& disk_start) {
    size_t cursor = 0;
    while (cursor + 4 <= extra.size()) {
      const uint16_t field_id = read_u16(extra.data() + cursor);
      const uint16_t field_size = read_u16(extra.data() + cursor + 2);
      cursor += 4;
      if (field_size > extra.size() - cursor) {
        return fail("ZIP extra field is truncated");
      }
      if (field_id != zip64_extra_field_id) {
        cursor += field_size;
        continue;
      }

      size_t field_cursor = cursor;
      const size_t field_end = cursor + field_size;
      if (uncompressed_size_32 == std::numeric_limits<uint32_t>::max()) {
        if (!read_zip64_u64(extra, field_cursor, field_end, entry_.uncompressed_size)) {
          return false;
        }
      }
      if (compressed_size_32 == std::numeric_limits<uint32_t>::max()) {
        if (!read_zip64_u64(extra, field_cursor, field_end, entry_.compressed_size)) {
          return false;
        }
      }
      if (local_header_offset_32 == std::numeric_limits<uint32_t>::max()) {
        if (!read_zip64_u64(extra, field_cursor, field_end, entry_.local_header_offset)) {
          return false;
        }
      }
      if (disk_start_16 == std::numeric_limits<uint16_t>::max()) {
        if (field_end - field_cursor < 4) {
          return fail("ZIP64 disk number is missing");
        }
        disk_start = read_u32(extra.data() + field_cursor);
      }
      return true;
    }
    return fail("ZIP64 extra field is missing");
  }

  bool read_zip64_u64(const std::vector<uint8_t>& extra, size_t& cursor, size_t end, uint64_t& value) {
    if (end - cursor < 8) {
      return fail("ZIP64 extra field is truncated");
    }
    value = read_u64(extra.data() + cursor);
    cursor += 8;
    return true;
  }

  bool open_entry() {
    if ((entry_.flags & (encrypted_flag | strong_encryption_flag | masked_header_values_flag)) != 0) {
      return fail("encrypted ZIP entries are not supported");
    }
    if (entry_.method != stored_method && entry_.method != deflate_method) {
      return fail("ZIP entry compression method is not supported");
    }
    if (entry_.uncompressed_size > maximum_output_size_) {
      return fail("ZIP entry exceeds the maximum decompressed byte count");
    }
    if (entry_.uncompressed_size != 0 && entry_.compressed_size == 0) {
      return fail("ZIP entry has an invalid compression ratio");
    }
    if (entry_.compressed_size <= std::numeric_limits<uint64_t>::max() / maximum_compression_ratio_ &&
        entry_.uncompressed_size > entry_.compressed_size * maximum_compression_ratio_) {
      return fail("ZIP entry exceeds the maximum compression ratio");
    }
    if (entry_.method == stored_method && entry_.compressed_size != entry_.uncompressed_size) {
      return fail("stored ZIP entry sizes do not match");
    }

    std::array<uint8_t, local_file_header_size> local_header{};
    if (!read_exact_at(entry_.local_header_offset, local_header.data(), local_header.size())) {
      return false;
    }
    if (read_u32(local_header.data()) != local_file_header_signature) {
      return fail("ZIP local file header is invalid");
    }
    const uint16_t local_flags = read_u16(local_header.data() + 6);
    const uint16_t local_method = read_u16(local_header.data() + 8);
    if (local_flags != entry_.flags || local_method != entry_.method) {
      return fail("ZIP local and central directory headers do not match");
    }

    const uint16_t local_name_size = read_u16(local_header.data() + 26);
    const uint16_t local_extra_size = read_u16(local_header.data() + 28);
    std::vector<uint8_t> local_name(local_name_size);
    if (!read_exact_at(entry_.local_header_offset + local_file_header_size, local_name.data(), local_name.size())) {
      return false;
    }
    if (local_name.size() != entry_name_.size() ||
        std::memcmp(local_name.data(), entry_name_.data(), local_name.size()) != 0) {
      return fail("ZIP local entry name does not match the central directory");
    }

    uint64_t data_offset = 0;
    if (!add_within(entry_.local_header_offset,
                    local_file_header_size + static_cast<uint64_t>(local_name_size) + local_extra_size, file_size_,
                    data_offset)) {
      return fail("ZIP local file header is truncated");
    }
    uint64_t data_end = 0;
    if (!add_within(data_offset, entry_.compressed_size, central_directory_offset_, data_end)) {
      return fail("ZIP entry data is outside the archive data region");
    }
    if (!seek(data_offset)) {
      return false;
    }

    compressed_remaining_ = entry_.compressed_size;
    crc32_ = 0;
    if (entry_.method == deflate_method) {
      const int result = CSV_ZLIB(inflateInit2)(&inflate_stream_, -MAX_WBITS);
      if (result != Z_OK) {
        return fail("failed to initialize ZIP DEFLATE decoder");
      }
      inflate_initialized_ = true;
    }
    return true;
  }

  uint64_t read_stored(uint8_t* output, uint32_t output_capacity) {
    const auto requested = static_cast<uint32_t>(std::min<uint64_t>(output_capacity, compressed_remaining_));
    if (requested != 0 && std::fread(output, 1, requested, file_) != requested) {
      fail("ZIP entry data is truncated");
      return 0;
    }
    compressed_remaining_ -= requested;
    if (!account_output(output, requested)) {
      return 0;
    }
    if (compressed_remaining_ == 0) {
      finish_entry();
    }
    return requested;
  }

  uint64_t read_deflated(uint8_t* output, uint32_t output_capacity) {
    inflate_stream_.next_out = output;
    inflate_stream_.avail_out = output_capacity;
    uint64_t written = 0;

    while (inflate_stream_.avail_out != 0 && status_ == zip_reader_status::reading) {
      // The final input byte may leave a pending match or end marker in the inflater.
      if (inflate_stream_.avail_in == 0 && compressed_remaining_ != 0 && !fill_inflate_input()) {
        break;
      }

      const uint32_t input_before = inflate_stream_.avail_in;
      const uint32_t output_before = inflate_stream_.avail_out;
      const int result = CSV_ZLIB(inflate)(&inflate_stream_, Z_NO_FLUSH);
      const uint32_t produced = output_before - inflate_stream_.avail_out;
      if (!account_output(output + written, produced)) {
        return 0;
      }
      written += produced;

      if (result == Z_STREAM_END) {
        if (compressed_remaining_ != 0 || inflate_stream_.avail_in != 0) {
          fail("ZIP entry compressed size does not match the DEFLATE stream");
          return 0;
        }
        finish_entry();
        break;
      }
      if (result != Z_OK && result != Z_BUF_ERROR) {
        fail("ZIP DEFLATE stream is invalid");
        return 0;
      }
      if (input_before == inflate_stream_.avail_in && produced == 0) {
        fail(compressed_remaining_ == 0 ? "ZIP DEFLATE stream is truncated" : "ZIP DEFLATE decoder stalled");
        return 0;
      }
    }
    return written;
  }

  bool fill_inflate_input() {
    const size_t requested = static_cast<size_t>(std::min<uint64_t>(inflate_input_.size(), compressed_remaining_));
    if (std::fread(inflate_input_.data(), 1, requested, file_) != requested) {
      return fail("ZIP entry data is truncated");
    }
    compressed_remaining_ -= requested;
    inflate_stream_.next_in = inflate_input_.data();
    inflate_stream_.avail_in = static_cast<uint32_t>(requested);
    return true;
  }

  bool account_output(const uint8_t* output, uint32_t length) {
    if (length > maximum_output_size_ - output_size_) {
      return fail("ZIP entry exceeds the maximum decompressed byte count");
    }
    crc32_ = static_cast<uint32_t>(CSV_ZLIB(crc32)(crc32_, output, length));
    output_size_ += length;
    return true;
  }

  void finish_entry() {
    if (output_size_ != entry_.uncompressed_size) {
      fail("ZIP entry decompressed size does not match the central directory");
      return;
    }
    if (crc32_ != entry_.expected_crc32) {
      fail("ZIP entry CRC32 check failed");
      return;
    }
    close_inflate();
    status_ = zip_reader_status::done;
  }

  void close_inflate() {
    if (inflate_initialized_) {
      CSV_ZLIB(inflateEnd)(&inflate_stream_);
      inflate_initialized_ = false;
    }
  }

  bool fail(const char* message) {
    if (status_ != zip_reader_status::error) {
      error_ = message;
      status_ = zip_reader_status::error;
    }
    return false;
  }

  std::unique_ptr<zip_read_ahead> ahead_;
  std::FILE* file_ = nullptr;
  std::string entry_name_;
  std::string error_;
  zip_entry_metadata entry_;
  zip_reader_status status_ = zip_reader_status::reading;
  uint64_t file_size_ = 0;
  uint64_t central_directory_offset_ = 0;
  uint64_t compressed_remaining_ = 0;
  uint64_t output_size_ = 0;
  uint64_t maximum_output_size_ = 0;
  uint32_t maximum_compression_ratio_ = 0;
  uint32_t crc32_ = 0;
  zip_inflate_stream inflate_stream_{};
  bool inflate_initialized_ = false;
  std::array<uint8_t, inflate_input_size> inflate_input_{};
};

} // namespace csv_native

CSV_EXPORT void* csv_zip_reader_create(const char* path, const uint8_t* entry_name, uint64_t entry_name_len,
                                       uint64_t maximum_output_size, uint32_t maximum_compression_ratio) {
  if (entry_name_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }
  return new (std::nothrow) csv_native::zip_reader(path, entry_name, static_cast<size_t>(entry_name_len),
                                                   maximum_output_size, maximum_compression_ratio);
}

CSV_EXPORT void csv_zip_reader_destroy(void* reader) { delete static_cast<csv_native::zip_reader*>(reader); }

CSV_EXPORT void csv_zip_reader_enable_read_ahead(void* reader, uint32_t chunk_size) {
  if (reader != nullptr) {
    static_cast<csv_native::zip_reader*>(reader)->enable_read_ahead(chunk_size);
  }
}

CSV_EXPORT uint64_t csv_zip_reader_read(void* reader, uint8_t* output, uint64_t output_capacity) {
  if (reader == nullptr) {
    return 0;
  }
  return static_cast<csv_native::zip_reader*>(reader)->read(output, output_capacity);
}

CSV_EXPORT int csv_zip_reader_status(void* reader) {
  if (reader == nullptr) {
    return 2;
  }
  return static_cast<int>(static_cast<csv_native::zip_reader*>(reader)->status());
}

CSV_EXPORT const char* csv_zip_reader_last_error(void* reader) {
  if (reader == nullptr) {
    return "ZIP reader is null";
  }
  return static_cast<csv_native::zip_reader*>(reader)->last_error();
}
