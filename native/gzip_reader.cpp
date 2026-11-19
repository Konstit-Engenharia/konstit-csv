#include "chunk_read_ahead.hpp"
#include "zlib_compat.hpp"

#include <array>
#include <cerrno>
#include <fcntl.h>
#include <limits>
#include <unistd.h>

namespace csv_native {
namespace {

class gzip_reader {
public:
  explicit gzip_reader(int fd) : fd_(fcntl(fd, F_DUPFD_CLOEXEC, 0)) {
    if (fd_ < 0) {
      error_ = "failed to duplicate gzip file descriptor";
    } else if (CSV_ZLIB(inflateInit2)(&stream_, MAX_WBITS + 16) != Z_OK) {
      error_ = "failed to initialize gzip decoder";
    } else {
      initialized_ = true;
    }
  }

  ~gzip_reader() {
    ahead_.reset();
    if (initialized_) {
      CSV_ZLIB(inflateEnd)(&stream_);
    }
    if (fd_ >= 0) {
      close(fd_);
    }
  }

  gzip_reader(const gzip_reader&) = delete;
  gzip_reader& operator=(const gzip_reader&) = delete;

  void enable_read_ahead(uint32_t chunk_size) {
    if (ahead_ || error_ || done_) {
      return;
    }
    // Small parser chunks can share one producer handoff.
    const uint32_t capacity = std::max(chunk_size, uint32_t{64 * 1024});
    ahead_ =
        chunk_read_ahead::start(capacity, this, [](void* self, uint8_t* output, uint32_t size, const auto& stopping) {
          return static_cast<gzip_reader*>(self)->inflate_chunk(output, size, &stopping);
        });
  }

  int64_t read(uint8_t* output, uint64_t capacity) {
    if (!output || capacity == 0 || capacity > std::numeric_limits<uint32_t>::max()) {
      return -1;
    }
    const auto bounded_capacity = static_cast<uint32_t>(capacity);
    if (ahead_) {
      if (ahead_->status() != chunk_status::reading) {
        return ahead_->status() == chunk_status::error ? -1 : 0;
      }
      const auto size = ahead_->read(output, bounded_capacity);
      return ahead_->status() == chunk_status::error ? int64_t{-1} : size;
    }

    const auto result = inflate_chunk(output, bounded_capacity, nullptr);
    stream_.next_out = nullptr;
    return result.status == chunk_status::error ? int64_t{-1} : result.size;
  }

  const char* last_error() const {
    // A prefetched error is published under the producer mutex before it becomes visible here.
    return !ahead_ || ahead_->status() == chunk_status::error ? error_ : nullptr;
  }

private:
  chunk_result fail(const char* message) {
    error_ = message;
    return {0, chunk_status::error};
  }

  chunk_result inflate_chunk(uint8_t* output, uint32_t capacity, const std::atomic<bool>* stopping) {
    if (error_) {
      return {0, chunk_status::error};
    }
    if (done_) {
      return {0, chunk_status::done};
    }
    stream_.next_out = output;
    stream_.avail_out = capacity;
    while (stream_.avail_out > 0) {
      if (stopping && stopping->load(std::memory_order_relaxed)) {
        return {0, chunk_status::done};
      }
      if (stream_.avail_in == 0 && !input_ended_) {
        // Positional reads keep the decoder independent of the descriptor used for format detection.
        const auto size = pread(fd_, input_.data(), input_.size(), offset_);
        if (size < 0) {
          if (errno == EINTR) {
            continue;
          }
          return fail("failed to read gzip file");
        }
        if (size > std::numeric_limits<off_t>::max() - offset_) {
          return fail("gzip offset exceeds the platform file limit");
        }
        offset_ += size;
        input_ended_ = size == 0;
        stream_.avail_in = static_cast<uint32_t>(size);
        stream_.next_in = input_.data();
      }

      if (member_ended_) {
        if (stream_.avail_in == 0 && input_ended_) {
          done_ = true;
          break;
        }
        if (CSV_ZLIB(inflateReset)(&stream_) != Z_OK) {
          return fail("failed to reset gzip decoder");
        }
        member_ended_ = false;
      }
      const int result = CSV_ZLIB(inflate)(&stream_, Z_NO_FLUSH);
      if (result == Z_STREAM_END) {
        member_ended_ = true;
      } else if (result != Z_OK) {
        return fail(result == Z_BUF_ERROR && input_ended_ ? "unexpected end of file" : "inflate failed");
      }
    }
    return {capacity - stream_.avail_out, done_ ? chunk_status::done : chunk_status::reading};
  }

  int fd_;
  off_t offset_ = 0;
  csv_zlib_stream stream_{};
  std::array<uint8_t, 256 * 1024> input_;
  std::unique_ptr<chunk_read_ahead> ahead_;
  const char* error_ = nullptr;
  bool initialized_ = false;
  bool input_ended_ = false;
  bool member_ended_ = false;
  bool done_ = false;
};

} // namespace
} // namespace csv_native

#define CSV_EXPORT extern "C" __attribute__((visibility("default")))

CSV_EXPORT void* csv_gzip_reader_create(int fd) { return new (std::nothrow) csv_native::gzip_reader(fd); }

CSV_EXPORT void csv_gzip_reader_destroy(void* reader) { delete static_cast<csv_native::gzip_reader*>(reader); }

CSV_EXPORT void csv_gzip_reader_enable_read_ahead(void* reader, uint32_t chunk_size) {
  if (reader != nullptr) {
    static_cast<csv_native::gzip_reader*>(reader)->enable_read_ahead(chunk_size);
  }
}

CSV_EXPORT int64_t csv_gzip_reader_read(void* reader, uint8_t* output, uint64_t capacity) {
  return reader == nullptr ? -1 : static_cast<csv_native::gzip_reader*>(reader)->read(output, capacity);
}

CSV_EXPORT const char* csv_gzip_reader_last_error(void* reader) {
  return reader == nullptr ? nullptr : static_cast<csv_native::gzip_reader*>(reader)->last_error();
}
