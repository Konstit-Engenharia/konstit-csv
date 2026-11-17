#include "field_transforms.hpp"
#include "regex.hpp"
#include <ankerl/unordered_dense.h>
#include <hwy/highway.h>

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#if defined(__aarch64__)
#include <arm_neon.h>
#endif

#if defined(_WIN32)
#define CSV_EXPORT extern "C" __declspec(dllexport)
#else
#define CSV_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace csv_native {

namespace hn = hwy::HWY_NAMESPACE;

// Internal prepared-count ABI reserves UINT64_MAX, outside JavaScript's safe count range, for errors.
constexpr uint64_t prepared_count_error = std::numeric_limits<uint64_t>::max();

enum class csv_encoding : int {
  utf8 = 0,
  latin1 = 1,
};

enum class batch_layout { utf8, latin1, latin1_quoted_spans };

enum class output_mode {
  batch,
  count,
};

enum class row_filter_kind : uint8_t {
  none = 0,
  equals = 1,
  in = 2,
  starts_with = 3,
  regex = 4,
  neq = 5,
  noin = 6,
  all_of = 7,
  any_of = 8,
  negate = 9,
};

enum class filter_truth : uint8_t {
  unknown,
  false_value,
  true_value,
};

bool is_boolean_operator(row_filter_kind kind) {
  return kind == row_filter_kind::all_of || kind == row_filter_kind::any_of || kind == row_filter_kind::negate;
}

struct row_filter {
  bool enabled = false;
  row_filter_kind kind = row_filter_kind::none;
  uint32_t column = 0;
  const uint8_t* value = nullptr;
  size_t value_len = 0;
  const uint8_t* values_data = nullptr;
  const uint32_t* value_offsets = nullptr;
  size_t value_count = 0;
};

struct csv_batch {
  std::vector<uint64_t> row_offsets{0};
  std::vector<uint64_t> field_offsets{0};
  std::vector<uint8_t> quoted_rows;
  std::string data;

  void reserve(size_t input_len, csv_encoding encoding) {
    const size_t data_capacity = encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    field_offsets.reserve((input_len / 6) + 32);
    row_offsets.reserve((input_len / 160) + 32);
  }

  void reserve_fixed(size_t input_len, csv_encoding encoding, uint32_t fixed_columns) {
    const size_t data_capacity = encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    const size_t rows_hint = (input_len / 160) + 32;
    field_offsets.reserve(rows_hint * static_cast<size_t>(fixed_columns) + 1);
    row_offsets.reserve(rows_hint + 1);
  }
};

struct csv_split_offsets_batch {
  std::vector<uint64_t> offsets;
};

constexpr size_t npos = std::numeric_limits<size_t>::max();
constexpr unsigned quoted_record_miss_limit = 4;
constexpr uint32_t max_column_index = 2024;
constexpr uint64_t max_projection_length = 2024;
constexpr uint16_t no_selected_output = std::numeric_limits<uint16_t>::max();
static_assert(max_projection_length <= no_selected_output);
constexpr uint64_t max_filter_count = 2024;
constexpr uint64_t max_filter_program_length = 4096;
constexpr uint64_t max_regex_filter_count = 32;

struct csv_structural_state {
  bool in_quotes = false;
  bool pending_quote = false;
  bool at_field_start = true;
  bool previous_was_cr = false;
  bool saw_row_data = false;
  uint64_t deferred_cr_row_end = 0;
};

struct csv_row_counter {
  uint64_t& emitted_rows;
  size_t& current_column;

  bool operator()(uint64_t) const {
    ++emitted_rows;
    current_column = 0;
    return true;
  }

  void add_plain_lf_rows(uint64_t count) const {
    emitted_rows += count;
    if (count != 0) {
      current_column = 0;
    }
  }
};

template <bool defer_crlf, bool count_plain_lf_blocks = false, typename OnRowEnd>
HWY_ATTR bool scan_csv_row_ends(const uint8_t* data, size_t len, uint8_t delimiter, uint64_t base_offset,
                                csv_structural_state& state, OnRowEnd&& on_row_end, size_t* column = nullptr) {
  // BitsFromMask exposes one bit per lane in a uint64_t, so keep blocks at most 64 bytes wide.
  const hn::CappedTag<uint8_t, 64> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto quote_v = hn::Set(du8, static_cast<uint8_t>('"'));
  const auto lf_v = hn::Set(du8, static_cast<uint8_t>('\n'));
  const auto cr_v = hn::Set(du8, static_cast<uint8_t>('\r'));

  for (size_t block_start = 0; block_start < len; block_start += lanes) {
    const size_t block_size = std::min(lanes, len - block_start);
    const auto bytes =
        block_size == lanes ? hn::LoadU(du8, data + block_start) : hn::LoadN(du8, data + block_start, block_size);
    const auto quote_mask = hn::Eq(bytes, quote_v);
    const auto lf_mask = hn::Eq(bytes, lf_v);
    const auto cr_mask = hn::Eq(bytes, cr_v);
    const auto row_end_mask = hn::Or(lf_mask, cr_mask);
    // Only quotes and record terminators need individual state transitions.
    const auto special_mask = hn::Or(quote_mask, row_end_mask);
    const uint64_t valid_bits =
        block_size == 64 ? std::numeric_limits<uint64_t>::max() : (uint64_t{1} << block_size) - 1;
    const uint64_t quote_bits = hn::BitsFromMask(du8, quote_mask) & valid_bits;
    const uint64_t special_bits = hn::BitsFromMask(du8, special_mask) & valid_bits;
    uint64_t delimiters = 0;
    if (column != nullptr) {
      delimiters = hn::BitsFromMask(du8, hn::Eq(bytes, hn::Set(du8, delimiter))) & valid_bits;
    }

    if constexpr (count_plain_lf_blocks) {
      if (!state.in_quotes && !state.pending_quote && !state.previous_was_cr && quote_bits == 0 &&
          hn::AllFalse(du8, cr_mask)) {
        on_row_end.add_plain_lf_rows(static_cast<uint64_t>(hn::CountTrue(du8, lf_mask)));
        const uint8_t last = data[block_start + block_size - 1];
        state.saw_row_data = last != '\n';
        state.at_field_start = last == '\n' || last == delimiter;
        state.previous_was_cr = false;
        continue;
      }
    }

    size_t cursor = 0;

    while (cursor < block_size) {
      if (state.in_quotes) {
        if (state.pending_quote) {
          if (data[block_start + cursor] == '"') {
            state.pending_quote = false;
            state.saw_row_data = true;
            state.at_field_start = false;
            ++cursor;
            continue;
          }
          state.pending_quote = false;
          state.in_quotes = false;
          continue;
        }

        const uint64_t candidates = quote_bits & (std::numeric_limits<uint64_t>::max() << cursor);
        state.saw_row_data = true;
        state.at_field_start = false;
        if (candidates == 0) {
          cursor = block_size;
          continue;
        }

        cursor = hwy::Num0BitsBelowLS1Bit_Nonzero64(candidates) + 1;
        state.pending_quote = true;
        continue;
      }

      if (state.previous_was_cr) {
        state.previous_was_cr = false;
        if (data[block_start + cursor] == '\n') {
          if constexpr (defer_crlf) {
            const uint64_t row_end = state.deferred_cr_row_end + 1;
            state.deferred_cr_row_end = 0;
            if (!on_row_end(row_end)) {
              return false;
            }
          }
          ++cursor;
          continue;
        }
        if constexpr (defer_crlf) {
          const uint64_t row_end = state.deferred_cr_row_end;
          state.deferred_cr_row_end = 0;
          if (!on_row_end(row_end)) {
            return false;
          }
        }
      }

      const uint64_t candidates = special_bits & (std::numeric_limits<uint64_t>::max() << cursor);
      if (column != nullptr) {
        // With no event left, the mask covers the rest of the block.
        const uint64_t before_event = (candidates & -candidates) - 1;
        *column += std::popcount((delimiters & before_event) >> cursor);
      }
      if (candidates == 0) {
        state.saw_row_data = true;
        state.at_field_start = data[block_start + block_size - 1] == delimiter;
        cursor = block_size;
        continue;
      }

      const size_t event = hwy::Num0BitsBelowLS1Bit_Nonzero64(candidates);
      if (event > cursor) {
        state.saw_row_data = true;
        state.at_field_start = data[block_start + event - 1] == delimiter;
      }

      const uint8_t byte = data[block_start + event];
      cursor = event + 1;
      if (byte == '"') {
        if (state.at_field_start) {
          state.in_quotes = true;
          state.pending_quote = false;
        }
        state.saw_row_data = true;
        state.at_field_start = false;
        continue;
      }
      state.saw_row_data = false;
      state.at_field_start = true;
      state.previous_was_cr = byte == '\r';
      const uint64_t row_end = base_offset + block_start + event + 1;
      if constexpr (defer_crlf) {
        // Safe file splits must include a following LF instead of landing inside a CRLF pair.
        if (state.previous_was_cr) {
          state.deferred_cr_row_end = row_end;
          continue;
        }
      }
      if (!on_row_end(row_end)) {
        return false;
      }
    }
  }

  return true;
}

HWY_ATTR uint64_t count_trusted_newlines(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) {
    return 0;
  }

  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto newline = hn::Set(du8, static_cast<uint8_t>('\n'));
  uint64_t rows = 0;
  size_t i = 0;
  for (; i + lanes <= len; i += lanes) {
    const auto bytes = hn::LoadU(du8, data + i);
    rows += static_cast<uint64_t>(hn::CountTrue(du8, hn::Eq(bytes, newline)));
  }
  for (; i < len; ++i) {
    rows += data[i] == '\n' ? 1 : 0;
  }
  if (data[len - 1] != '\n' && data[len - 1] != '\r') {
    ++rows;
  }
  return rows;
}

std::unique_ptr<csv_split_offsets_batch> find_csv_safe_split_offsets(const char* path, size_t shard_count,
                                                                     uint8_t delimiter) {
  if (path == nullptr || path[0] == '\0' || shard_count == 0 || delimiter == 0 || delimiter == '\n' ||
      delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }

  std::FILE* file = std::fopen(path, "rb");
  if (file == nullptr) {
    return nullptr;
  }

  if (std::fseek(file, 0, SEEK_END) != 0) {
    std::fclose(file);
    return nullptr;
  }
  const int64_t size_long = std::ftell(file);
  if (size_long < 0) {
    std::fclose(file);
    return nullptr;
  }
  const uint64_t file_size = static_cast<uint64_t>(size_long);
  if (std::fseek(file, 0, SEEK_SET) != 0) {
    std::fclose(file);
    return nullptr;
  }

  auto batch = std::make_unique<csv_split_offsets_batch>();
  batch->offsets.reserve(shard_count + 1);
  batch->offsets.push_back(0);
  if (file_size == 0) {
    std::fclose(file);
    return batch;
  }

  std::vector<uint64_t> targets;
  targets.reserve(shard_count > 1 ? shard_count - 1 : 0);
  for (size_t shard_index = 1; shard_index < shard_count; ++shard_index) {
    targets.push_back((file_size * static_cast<uint64_t>(shard_index)) / static_cast<uint64_t>(shard_count));
  }
  if (targets.empty()) {
    batch->offsets.push_back(file_size);
    std::fclose(file);
    return batch;
  }

  std::vector<uint8_t> buffer(8 * 1024 * 1024);
  size_t target_index = 0;
  uint64_t absolute = 0;
  csv_structural_state state;
  const auto on_row_end = [&](uint64_t row_end) {
    bool crossed_target = false;
    while (target_index < targets.size() && row_end >= targets[target_index]) {
      crossed_target = true;
      ++target_index;
    }
    if (crossed_target && row_end > batch->offsets.back()) {
      batch->offsets.push_back(row_end);
    }
    return target_index < targets.size();
  };

  while (target_index < targets.size()) {
    const size_t bytes_read = std::fread(buffer.data(), 1, buffer.size(), file);
    if (bytes_read == 0) {
      break;
    }

    if (!scan_csv_row_ends<true>(buffer.data(), bytes_read, delimiter, absolute, state, on_row_end)) {
      break;
    }
    absolute += static_cast<uint64_t>(bytes_read);
  }

  if (target_index < targets.size() && state.previous_was_cr) {
    state.previous_was_cr = false;
    const uint64_t row_end = state.deferred_cr_row_end;
    state.deferred_cr_row_end = 0;
    on_row_end(row_end);
  }

  std::fclose(file);

  if (batch->offsets.back() != file_size) {
    batch->offsets.push_back(file_size);
  }
  return batch;
}

bool is_ascii(const uint8_t* data, size_t len) {
  uint8_t combined = 0;
  for (size_t i = 0; i < len; ++i) {
    combined |= data[i];
  }
  return combined < 0x80;
}

bool quoted_record_may_need_trim(const uint8_t* data, size_t len) {
  // A space or control byte beside a quote may require per-field trimming.
  // The first opening quote and the final LF are syntax.
  uint8_t edge_space = 0;
  for (size_t i = 1; i + 1 < len; ++i) {
    edge_space |= (data[i] <= ' ') & ((data[i - 1] == '"') | (data[i + 1] == '"'));
  }
  return edge_space != 0;
}

void append_latin1_scalar(std::string& out, const uint8_t* data, size_t len) {
  size_t ascii_start = 0;
  for (size_t i = 0; i < len; ++i) {
    const uint8_t byte = data[i];
    if (byte < 0x80) {
      continue;
    }
    if (i > ascii_start) {
      out.append(reinterpret_cast<const char*>(data + ascii_start), i - ascii_start);
    }
    out.push_back(static_cast<char>(0xC0 | (byte >> 6)));
    out.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
    ascii_start = i + 1;
  }
  if (ascii_start < len) {
    out.append(reinterpret_cast<const char*>(data + ascii_start), len - ascii_start);
  }
}

void append_latin1_scalar_byte(std::string& out, uint8_t byte) {
  if (byte < 0x80) {
    out.push_back(static_cast<char>(byte));
  } else {
    out.push_back(static_cast<char>(0xC0 | (byte >> 6)));
    out.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
  }
}

HWY_ATTR void append_latin1(std::string& out, const uint8_t* data, size_t len) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto limit = hn::Set(du8, static_cast<uint8_t>(0x80));
  const auto leading_bits = hn::Set(du8, static_cast<uint8_t>(0xC0));
  const auto trailing_mask = hn::Set(du8, static_cast<uint8_t>(0x3F));
  const auto trailing_bits = hn::Set(du8, static_cast<uint8_t>(0x80));
  size_t i = 0;

  while (i < len) {
    if (i + lanes <= len) {
      const auto bytes = hn::LoadU(du8, data + i);
      const auto ascii = hn::Lt(bytes, limit);
      if (hn::AllTrue(du8, ascii)) {
        out.append(reinterpret_cast<const char*>(data + i), lanes);
        i += lanes;
        continue;
      }

      if (hn::AllFalse(du8, ascii)) {
        const auto leading = hn::Or(hn::ShiftRight<6>(bytes), leading_bits);
        const auto trailing = hn::Or(hn::And(bytes, trailing_mask), trailing_bits);
        const size_t offset = out.size();
        out.resize(offset + lanes * 2);
        hn::StoreInterleaved2(leading, trailing, du8, reinterpret_cast<uint8_t*>(out.data() + offset));
        i += lanes;
        continue;
      }

      const intptr_t first_non_ascii = hn::FindFirstTrue(du8, hn::Not(ascii));
      if (first_non_ascii > 0) {
        out.append(reinterpret_cast<const char*>(data + i), static_cast<size_t>(first_non_ascii));
        i += static_cast<size_t>(first_non_ascii);
        continue;
      }
      if (first_non_ascii == 0) {
        append_latin1_scalar_byte(out, data[i]);
        ++i;
        continue;
      }
    }

    append_latin1_scalar(out, data + i, len - i);
    break;
  }
}

HWY_ATTR size_t find_byte_simd(const uint8_t* data, size_t len, uint8_t needle) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto wanted = hn::Set(du8, needle);
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    const intptr_t found = hn::FindFirstTrue(du8, hn::Eq(bytes, wanted));
    if (found >= 0) {
      return i + static_cast<size_t>(found);
    }
    i += lanes;
  }

  for (; i < len; ++i) {
    if (data[i] == needle) {
      return i;
    }
  }
  return npos;
}

HWY_ATTR size_t find_plain_special_simd(const uint8_t* data, size_t len, uint8_t delimiter) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto delimiter_v = hn::Set(du8, delimiter);
  const auto lf_v = hn::Set(du8, static_cast<uint8_t>('\n'));
  const auto cr_v = hn::Set(du8, static_cast<uint8_t>('\r'));
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    const auto delimiter_mask = hn::Eq(bytes, delimiter_v);
    const auto newline_mask = hn::Or(hn::Eq(bytes, lf_v), hn::Eq(bytes, cr_v));
    const intptr_t found = hn::FindFirstTrue(du8, hn::Or(delimiter_mask, newline_mask));
    if (found >= 0) {
      return i + static_cast<size_t>(found);
    }
    i += lanes;
  }

  for (; i < len; ++i) {
    const uint8_t byte = data[i];
    if (byte == delimiter || byte == '\n' || byte == '\r') {
      return i;
    }
  }
  return npos;
}

HWY_ATTR size_t find_strict_plain_special_simd(const uint8_t* data, size_t len, uint8_t delimiter) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto delimiter_v = hn::Set(du8, delimiter);
  const auto quote_v = hn::Set(du8, static_cast<uint8_t>('"'));
  const auto lf_v = hn::Set(du8, static_cast<uint8_t>('\n'));
  const auto cr_v = hn::Set(du8, static_cast<uint8_t>('\r'));
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    const auto delimiter_mask = hn::Eq(bytes, delimiter_v);
    const auto quote_mask = hn::Eq(bytes, quote_v);
    const auto newline_mask = hn::Or(hn::Eq(bytes, lf_v), hn::Eq(bytes, cr_v));
    const intptr_t found = hn::FindFirstTrue(du8, hn::Or(hn::Or(delimiter_mask, quote_mask), newline_mask));
    if (found >= 0) {
      return i + static_cast<size_t>(found);
    }
    i += lanes;
  }

  for (; i < len; ++i) {
    const uint8_t byte = data[i];
    if (byte == delimiter || byte == '"' || byte == '\n' || byte == '\r') {
      return i;
    }
  }
  return npos;
}

bool is_quoted_field_terminator(uint8_t byte, uint8_t delimiter) {
  return byte == delimiter || byte == '\n' || byte == '\r';
}

uint64_t clear_mask_bits_through(uint64_t bits, size_t lane) {
  if (lane >= 63) {
    return 0;
  }
  return bits & (~0ull << (lane + 1));
}

class csv_parser {
public:
  csv_parser(csv_encoding encoding, uint8_t delimiter, batch_layout layout = batch_layout::utf8,
             uint32_t fixed_columns = 0)
      : encoding_(encoding), delimiter_(delimiter), layout_(layout), fixed_columns_(fixed_columns) {}

  void set_row_selection(uint64_t skip, uint64_t limit, bool capture_header) {
    initial_skip_ = skip;
    rows_to_skip_ = skip;
    initial_limit_ = limit;
    rows_left_ = limit;
    capture_header_ = capture_header;
  }

  bool limit_reached() const { return rows_left_ == 0; }

  csv_batch* take_skipped_header() { return skipped_header_.release(); }
  uint64_t skipped_rows() const { return initial_skip_ - rows_to_skip_; }

  bool add_transform(uint32_t column, uint32_t kind, std::optional<std::string_view> default_value = std::nullopt) {
    return !configuration_initialized_ && column <= max_column_index && transforms_.add(column, kind, default_value);
  }
  bool add_transform_pair(uint32_t column, std::string_view key, std::string_view value) {
    return !configuration_initialized_ && transforms_.add_pair(column, key, value, error_);
  }

  void enable_transformed_quoted_spans() {
    if (prepared_quoted_records_ && transform_matched_rows_ && filters_.empty()) {
      transforms_.prepare_ascii_cleanup();
    }
  }

  // Strict schema validation reads the original batch before the caller requests its transformed copy.
  csv_batch* transform_validated_batch(const csv_batch& source) {
    auto result = std::make_unique<csv_batch>();
    result->row_offsets = source.row_offsets;
    result->field_offsets.reserve(source.field_offsets.size());
    result->data.reserve(source.data.size());
    const std::string_view data(source.data);
    for (size_t row = 1; row < source.row_offsets.size(); ++row) {
      const auto start = source.row_offsets[row - 1];
      for (size_t i = start; i < source.row_offsets[row]; ++i) {
        const auto field = data.substr(source.field_offsets[i], source.field_offsets[i + 1] - source.field_offsets[i]);
        if (!transforms_.append(result->data, i - start, field)) {
          set_error("invalid field transform");
          return nullptr;
        }
        result->field_offsets.push_back(result->data.size());
      }
    }
    return result.release();
  }

  bool prepare_configuration(const uint32_t* selected_columns, size_t selected_columns_len,
                             std::vector<row_filter> filters, const uint8_t* values_data, size_t values_data_len,
                             const uint32_t* value_offsets, size_t total_value_count) {
    if (configuration_initialized_) {
      set_error("prepared configuration requires a new or reset parser");
      return false;
    }

    // Keep every pointer in the prepared filters and projection owned by this
    // parser. The caller's FFI buffers may be released as soon as preparation ends.
    owned_selected_columns_.resize(std::max<size_t>(selected_columns_len, 1));
    if (selected_columns_len != 0) {
      std::copy_n(selected_columns, selected_columns_len, owned_selected_columns_.begin());
    }
    owned_filter_values_.resize(std::max<size_t>(values_data_len, 1));
    if (values_data_len != 0) {
      std::copy_n(values_data, values_data_len, owned_filter_values_.begin());
    }
    owned_filter_offsets_.assign(value_offsets, value_offsets + total_value_count + 1);
    for (auto& filter : filters) {
      if (is_boolean_operator(filter.kind)) {
        continue;
      }
      if (filter.kind == row_filter_kind::in || filter.kind == row_filter_kind::noin) {
        const auto first_value = filter.value_offsets - value_offsets;
        filter.values_data = owned_filter_values_.data();
        filter.value_offsets = owned_filter_offsets_.data() + first_value;
      } else {
        const auto start = filter.value == nullptr ? 0 : filter.value - values_data;
        filter.value = owned_filter_values_.data() + start;
      }
    }

    mode_ = output_mode::batch;
    transform_matched_rows_ = !transforms_.empty();
    deferred_batch_row_ = transform_matched_rows_;
    allow_direct_projection_ = !transform_matched_rows_;
    if (!configure(selected_columns == nullptr ? nullptr : owned_selected_columns_.data(), selected_columns_len,
                   filters.data(), filters.size())) {
      return false;
    }
    prepared_configuration_ = true;
    prepared_direct_projection_ = direct_projection_;
    prepared_quoted_records_ = supports_quoted_records();
    return true;
  }

  csv_batch* write_prepared_batch(const uint8_t* data, size_t len, bool final) {
    if (!prepared_configuration_) {
      set_error("parser has no prepared configuration");
      return nullptr;
    }
    auto batch = std::make_unique<csv_batch>();
    select_input(data, len, false);
    if (filters_.empty()) {
      batch->reserve(len, encoding_);
    } else {
      reserve_filtered_batch(*batch, len);
    }
    mode_ = output_mode::batch;
    batch_ = batch.get();
    direct_projection_ = prepared_direct_projection_;
    parse_projected_batch(data, len, final, prepared_quoted_records_);
    if (!batch->quoted_rows.empty()) {
      batch->quoted_rows.resize(batch->row_offsets.size() - 1, 0);
    }
    if (!parse_failed_ && !filters_.empty() && len != 0) {
      filtered_batch_input_len_ = len;
      filtered_batch_data_size_ = batch->data.size();
      filtered_batch_field_count_ = batch->field_offsets.size() - 1;
      filtered_batch_row_count_ = batch->row_offsets.size() - 1;
    }
    batch_ = nullptr;
    return parse_failed_ ? nullptr : batch.release();
  }

  uint64_t write_prepared_count(const uint8_t* data, size_t len, bool final) {
    if (!prepared_configuration_) {
      set_error("parser has no prepared configuration");
      return prepared_count_error;
    }
    mode_ = output_mode::count;
    direct_projection_ = false;
    emitted_rows_ = 0;
    select_input(data, len, false);
    parse(data, len);
    if (final && !parse_failed_ && !limit_reached()) {
      finish_stream();
    }
    return error_.empty() ? emitted_rows_ : prepared_count_error;
  }

  csv_batch* write_batch(const uint8_t* data, size_t len, bool final) {
    if (encoding_ == csv_encoding::latin1) {
      return write_latin1_batch_impl(data, len, final, false);
    }
    return write_batch_impl(data, len, final, false);
  }

  csv_batch* write_strict_batch(const uint8_t* data, size_t len, bool final) {
    if (encoding_ == csv_encoding::latin1) {
      return write_latin1_batch_impl(data, len, final, true);
    }
    return write_batch_impl(data, len, final, true);
  }

  csv_batch* write_fixed_batch(const uint8_t* data, size_t len, bool final, uint32_t fixed_columns) {
    return write_fixed_batch_impl(data, len, final, fixed_columns, false);
  }

  csv_batch* write_strict_fixed_batch(const uint8_t* data, size_t len, bool final, uint32_t fixed_columns) {
    return write_fixed_batch_impl(data, len, final, fixed_columns, true);
  }

  csv_batch* write_fixed_batch_impl(const uint8_t* data, size_t len, bool final, uint32_t fixed_columns, bool strict) {
    if (fixed_columns == 0) {
      set_error("fixed columns must be greater than zero");
      return nullptr;
    }

    select_input(data, len, true);
    auto batch = std::make_unique<csv_batch>();
    batch->reserve_fixed(len, encoding_, fixed_columns);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    configure(nullptr, 0, row_filter{});
    fixed_columns_ = fixed_columns;
    strict_quote_syntax_ = strict;
    parse_failed_ = false;
    emitted_rows_ = 0;
    parse<true>(data, len);
    if (!parse_failed_ && final && !limit_reached()) {
      finish_stream();
    } else if (!parse_failed_) {
      spill_unfinished_batch_row();
    }
    fixed_columns_ = 0;
    strict_quote_syntax_ = false;
    batch_ = nullptr;
    if (parse_failed_) {
      return nullptr;
    }
    return batch.release();
  }

  csv_batch* write_projected_batch(const uint8_t* data, size_t len, bool final, const uint32_t* selected_columns,
                                   size_t selected_columns_len, row_filter filter) {
    return write_projected_batch_where_all(data, len, final, selected_columns, selected_columns_len,
                                           filter.enabled ? &filter : nullptr, filter.enabled ? 1 : 0);
  }

  csv_batch* write_projected_batch_where_all(const uint8_t* data, size_t len, bool final,
                                             const uint32_t* selected_columns, size_t selected_columns_len,
                                             const row_filter* filters, size_t filter_count) {
    select_input(data, len, false);
    auto batch = std::make_unique<csv_batch>();
    batch->reserve(len, encoding_);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    allow_direct_projection_ = true;
    if (!configure(selected_columns, selected_columns_len, filters, filter_count)) {
      batch_ = nullptr;
      return nullptr;
    }
    parse_projected_batch(data, len, final);
    batch_ = nullptr;
    return parse_failed_ ? nullptr : batch.release();
  }

  csv_batch* finish_batch() { return write_batch(nullptr, 0, true); }

  csv_batch* finish_strict_batch() { return write_strict_batch(nullptr, 0, true); }

  csv_batch* finish_fixed_batch(uint32_t fixed_columns) { return write_fixed_batch(nullptr, 0, true, fixed_columns); }

  csv_batch* finish_strict_fixed_batch(uint32_t fixed_columns) {
    return write_strict_fixed_batch(nullptr, 0, true, fixed_columns);
  }

  csv_batch* finish_projected_batch(const uint32_t* selected_columns, size_t selected_columns_len, row_filter filter) {
    return write_projected_batch(nullptr, 0, true, selected_columns, selected_columns_len, filter);
  }

  csv_batch* finish_projected_batch_where_all(const uint32_t* selected_columns, size_t selected_columns_len,
                                              const row_filter* filters, size_t filter_count) {
    return write_projected_batch_where_all(nullptr, 0, true, selected_columns, selected_columns_len, filters,
                                           filter_count);
  }

  uint64_t write_count(const uint8_t* data, size_t len, bool final) {
    return write_count_where(data, len, final, row_filter{});
  }

  uint64_t write_count_where_equals(const uint8_t* data, size_t len, bool final, row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::equals : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where_in(const uint8_t* data, size_t len, bool final, row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::in : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where_starts_with(const uint8_t* data, size_t len, bool final, row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::starts_with : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where(const uint8_t* data, size_t len, bool final, row_filter filter) {
    return write_count_where_all(data, len, final, filter.enabled ? &filter : nullptr, filter.enabled ? 1 : 0);
  }

  uint64_t write_count_where_all(const uint8_t* data, size_t len, bool final, const row_filter* filters,
                                 size_t filter_count) {
    mode_ = output_mode::count;
    if (!configure(nullptr, 0, filters, filter_count)) {
      return 0;
    }
    emitted_rows_ = 0;
    select_input(data, len, false);
    parse(data, len);
    if (final && !limit_reached()) {
      finish_stream();
    }
    return emitted_rows_;
  }

  uint64_t finish_count() { return write_count(nullptr, 0, true); }

  uint64_t finish_count_where_equals(row_filter filter) { return write_count_where_equals(nullptr, 0, true, filter); }

  uint64_t finish_count_where_in(row_filter filter) { return write_count_where_in(nullptr, 0, true, filter); }

  uint64_t finish_count_where_starts_with(row_filter filter) {
    return write_count_where_starts_with(nullptr, 0, true, filter);
  }

  uint64_t finish_count_where_all(const row_filter* filters, size_t filter_count) {
    return write_count_where_all(nullptr, 0, true, filters, filter_count);
  }

  void reset_stream() {
    skipped_header_.reset();
    rows_to_skip_ = initial_skip_;
    rows_left_ = initial_limit_;
    skip_state_ = {};
    reset_row_state();
    field_.clear();
    error_.clear();
    batch_ = nullptr;
    parse_failed_ = false;
    strict_expected_columns_ = 0;
    strict_expected_columns_seen_ = false;
    in_quotes_ = false;
    pending_quote_ = false;
    at_field_start_ = true;
    saw_row_data_ = false;
    previous_was_cr_ = false;
    emitted_rows_ = 0;
    filtered_batch_input_len_ = 0;
    filtered_batch_data_size_ = 0;
    filtered_batch_field_count_ = 0;
    filtered_batch_row_count_ = 0;
    field_in_arena_ = false;
    complete_quoted_field_has_escape_ = false;
  }

  void reset() {
    transforms_ = {};
    transform_matched_rows_ = false;
    reset_stream();
    configuration_initialized_ = false;
    prepared_configuration_ = false;
    prepared_direct_projection_ = false;
    prepared_quoted_records_ = false;
    owned_selected_columns_.clear();
    owned_filter_values_.clear();
    owned_filter_offsets_.clear();
    projected_fields_.clear();
    selected_columns_ = nullptr;
    selected_columns_len_ = 0;
    projection_enabled_ = false;
    filters_.clear();
    first_filter_by_column_.clear();
    next_filter_.clear();
    in_filter_caches_.clear();
    regex_filter_caches_.clear();
    row_filter_seen_.clear();
    row_filter_matched_.clear();
    filter_truth_stack_.clear();
    conjunctive_filters_ = true;
    direct_projection_ = false;
    allow_direct_projection_ = false;
  }

  const char* last_error() const { return error_.empty() ? "" : error_.c_str(); }

  void set_error(const char* value) { error_ = value; }

private:
  void reserve_filtered_batch(csv_batch& batch, size_t input_len, size_t sample_input_len = 0) const {
    constexpr size_t initial_input_hint = 32 * 1024;
    const size_t initial_len = std::min(input_len, initial_input_hint);
    const size_t data_multiplier = encoding_ == csv_encoding::latin1 ? 2 : 1;
    const size_t data_limit = std::min(input_len, batch.data.max_size() / data_multiplier) * data_multiplier;
    const size_t field_limit = (input_len / 6) + 32;
    const size_t row_limit = (input_len / 160) + 32;
    const size_t observed_input_len = sample_input_len != 0 ? sample_input_len : filtered_batch_input_len_;
    const size_t observed_fields = sample_input_len != 0 ? batch.row_offsets.back() : filtered_batch_field_count_;
    const size_t observed_data =
        sample_input_len != 0 ? batch.field_offsets[observed_fields] : filtered_batch_data_size_;
    const size_t observed_rows = sample_input_len != 0 ? batch.row_offsets.size() - 1 : filtered_batch_row_count_;

    // Use committed output from a first-write sample or the last chunk, with
    // headroom for changing match density. Input-based caps bound guesses after
    // a large carried row; normal growth handles denser chunks and wide rows.
    const auto capacity_hint = [&](size_t observed_size, size_t initial_size, size_t minimum, size_t maximum) {
      if (observed_input_len == 0) {
        return std::min(initial_size, maximum);
      }
      // A short prefix may miss a large row that is still being parsed.
      const double headroom = sample_input_len != 0 ? 2.0 : 1.25;
      const double estimate = static_cast<double>(observed_size) / static_cast<double>(observed_input_len) *
                              static_cast<double>(input_len) * headroom;
      if (estimate >= static_cast<double>(maximum)) {
        return maximum;
      }
      return std::max(std::min(minimum, maximum), static_cast<size_t>(estimate));
    };
    batch.data.reserve(capacity_hint(observed_data, initial_len * data_multiplier, 4096, data_limit));
    batch.field_offsets.reserve(capacity_hint(observed_fields, (initial_len / 6) + 32, 256, field_limit));
    batch.row_offsets.reserve(capacity_hint(observed_rows, (initial_len / 160) + 32, 32, row_limit));
  }

  // Unvalidated prefixes need only structural scanning. Strict and fixed-width
  // writes parse from the first record so skipped rows participate in validation.
  void select_input(const uint8_t*& data, size_t& len, bool validate_rows) {
    if (limit_reached()) {
      len = 0;
      return;
    }
    if (rows_to_skip_ == 0 || validate_rows || fixed_columns_ != 0 || data == nullptr || len == 0) {
      return;
    }
    size_t consumed = len;
    scan_csv_row_ends<false>(data, len, delimiter_, 0, skip_state_, [&](uint64_t end) {
      if (--rows_to_skip_ != 0) {
        return true;
      }
      consumed = static_cast<size_t>(end);
      previous_was_cr_ = skip_state_.previous_was_cr;
      return false;
    });
    data += consumed;
    len -= consumed;
  }

  void record_emitted_row() {
    ++emitted_rows_;
    if (rows_left_ != std::numeric_limits<uint64_t>::max()) {
      --rows_left_;
    }
  }

  void parse_projected_batch(const uint8_t* data, size_t len, bool final, bool try_quoted_records = false) {
    parse_failed_ = false;
    emitted_rows_ = 0;
    if (prepared_configuration_ && !filters_.empty() && filtered_batch_input_len_ == 0 && len > 256 * 1024) {
      const size_t sample_len = std::clamp<size_t>(len / 64, 64 * 1024, 256 * 1024);
      if (try_quoted_records) {
        parse<true>(data, sample_len);
      } else {
        parse(data, sample_len);
      }
      if (parse_failed_) {
        return;
      }
      // Continue the same row and batch without finalizing the sampled prefix.
      // A limit reached within the sample must also stop the remaining input.
      if (!limit_reached()) {
        reserve_filtered_batch(*batch_, len, sample_len);
        data += sample_len;
        len -= sample_len;
      }
    }
    if (!limit_reached()) {
      if (try_quoted_records) {
        parse<true>(data, len);
      } else {
        parse(data, len);
      }
    }
    if (parse_failed_) {
      return;
    }
    if (final && !limit_reached()) {
      finish_stream();
    } else {
      spill_unfinished_direct_projection_row();
      spill_unfinished_batch_row();
    }
  }

  csv_batch* write_latin1_batch_impl(const uint8_t* data, size_t len, bool final, bool strict) {
    select_input(data, len, strict);
    auto batch = std::make_unique<csv_batch>();
    batch->reserve(len, csv_encoding::latin1);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    allow_direct_projection_ = final && !saw_row_data_;
    configure(nullptr, 0, row_filter{});
    strict_quote_syntax_ = strict;
    parse_failed_ = false;
    emitted_rows_ = 0;
    parse_latin1_batch(data, len, strict);
    if (final && !limit_reached()) {
      finish_latin1_batch_stream(strict);
    } else {
      spill_unfinished_batch_row();
    }
    strict_quote_syntax_ = false;
    batch_ = nullptr;
    if (parse_failed_) {
      return nullptr;
    }
    return batch.release();
  }

  csv_batch* write_batch_impl(const uint8_t* data, size_t len, bool final, bool strict) {
    select_input(data, len, strict);
    auto batch = std::make_unique<csv_batch>();
    batch->reserve(len, encoding_);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    allow_direct_projection_ = final && !saw_row_data_;
    configure(nullptr, 0, row_filter{});
    strict_quote_syntax_ = strict;
    parse_failed_ = false;
    emitted_rows_ = 0;
    parse<true>(data, len);
    if (final && !limit_reached()) {
      finish_stream();
    } else {
      spill_unfinished_batch_row();
    }
    strict_quote_syntax_ = false;
    batch_ = nullptr;
    if (parse_failed_) {
      return nullptr;
    }
    return batch.release();
  }

  struct in_filter_cache {
    in_filter_cache() = default;
    in_filter_cache(const in_filter_cache&) = delete;
    in_filter_cache& operator=(const in_filter_cache&) = delete;
    in_filter_cache(in_filter_cache&&) noexcept = default;
    in_filter_cache& operator=(in_filter_cache&&) noexcept = default;

    std::vector<std::string> values;
    // Views refer to values after the vector has been fully populated.
    ankerl::unordered_dense::set<std::string_view> value_set;
    bool use_set = false;
  };

  struct regex_filter_cache {
    std::string source;
    std::unique_ptr<re2::RE2> expression;
  };

  bool configure(const uint32_t* selected_columns, size_t selected_columns_len, row_filter filter) {
    return configure(selected_columns, selected_columns_len, filter.enabled ? &filter : nullptr,
                     filter.enabled ? 1 : 0);
  }

  bool configure(const uint32_t* selected_columns, size_t selected_columns_len, const row_filter* filters,
                 size_t filter_count) {
    configuration_initialized_ = true;
    prepared_configuration_ = false;
    selected_columns_ = selected_columns;
    selected_columns_len_ = selected_columns_len;
    projection_enabled_ = selected_columns != nullptr;
    filters_.clear();
    if (filter_count != 0) {
      filters_.assign(filters, filters + filter_count);
    }
    // Nested ALL groups are still a conjunction. Check each leaf once instead of
    // re-evaluating the whole program after every column in wide filtered rows.
    conjunctive_filters_ = std::none_of(filters_.begin(), filters_.end(), [](const row_filter& filter) {
      return filter.kind == row_filter_kind::any_of || filter.kind == row_filter_kind::negate;
    });
    prepare_in_filters();
    if (!prepare_regex_filters()) {
      return false;
    }
    prepare_filter_lookup();
    if (filter_truth_stack_.size() < filter_count) {
      filter_truth_stack_.resize(filter_count);
    }
    if (row_filter_seen_.size() != filter_count) {
      row_filter_seen_.assign(filter_count, false);
      row_filter_matched_.assign(filter_count, false);
      filter_program_truth_ = filter_truth::unknown;
    }
    flat_filter_rejected_ = false;
    if (!conjunctive_filters_) {
      filter_program_truth_ = evaluate_filter_program();
    } else {
      for (size_t index = 0; index < filter_count; ++index) {
        if (row_filter_seen_[index] && !row_filter_matched_[index]) {
          flat_filter_rejected_ = true;
          break;
        }
      }
    }
    selected_output_by_column_.clear();

    if (projection_enabled_) {
      uint32_t max_column = 0;
      for (size_t i = 0; i < selected_columns_len_; ++i) {
        if (selected_columns_[i] > max_column) {
          max_column = selected_columns_[i];
        }
      }
      selected_output_by_column_.assign(static_cast<size_t>(max_column) + 1, no_selected_output);
      // Projection validation gives each physical column exactly one output slot.
      for (size_t i = 0; i < selected_columns_len_; ++i) {
        const uint32_t column = selected_columns_[i];
        selected_output_by_column_[column] = static_cast<uint16_t>(i);
      }
    }
    direct_projection_ = can_use_direct_projection();
    if (projection_enabled_ && !direct_projection_ && mode_ == output_mode::batch) {
      if (projected_fields_.size() != selected_columns_len_) {
        projected_fields_.assign(selected_columns_len_, std::string{});
      }
    } else if (!saw_row_data_) {
      // A per-write mode change may still have deferred fields in the current row.
      projected_fields_.clear();
    }
    if (!direct_projection_ && mode_ == output_mode::batch) {
      defer_direct_projection_carry();
    }
    return true;
  }

  void prepare_filter_lookup() {
    first_filter_by_column_.clear();
    next_filter_.clear();
    if (filters_.empty()) {
      return;
    }

    uint32_t max_column = 0;
    for (const auto& filter : filters_) {
      if (is_boolean_operator(filter.kind)) {
        continue;
      }
      max_column = std::max(max_column, filter.column);
    }
    first_filter_by_column_.assign(static_cast<size_t>(max_column) + 1, std::numeric_limits<uint32_t>::max());
    next_filter_.resize(filters_.size());
    for (size_t index = 0; index < filters_.size(); ++index) {
      if (is_boolean_operator(filters_[index].kind)) {
        next_filter_[index] = std::numeric_limits<uint32_t>::max();
        continue;
      }
      const uint32_t filter_index = checked_u32(index);
      const uint32_t column = filters_[index].column;
      next_filter_[index] = first_filter_by_column_[column];
      first_filter_by_column_[column] = filter_index;
    }
  }

  void prepare_in_filters() {
    in_filter_caches_.resize(filters_.size());
    for (size_t index = 0; index < filters_.size(); ++index) {
      prepare_in_filter(filters_[index], in_filter_caches_[index]);
    }
  }

  bool prepare_regex_filters() {
    regex_filter_caches_.resize(filters_.size());
    for (size_t index = 0; index < filters_.size(); ++index) {
      const auto& filter = filters_[index];
      auto& cache = regex_filter_caches_[index];
      if (!filter.enabled || filter.kind != row_filter_kind::regex) {
        cache.source.clear();
        cache.expression.reset();
        continue;
      }

      std::string source;
      if (filter.value_len != 0) {
        source.assign(reinterpret_cast<const char*>(filter.value), filter.value_len);
      }
      if (cache.expression != nullptr && cache.source == source) {
        continue;
      }

      std::string message;
      auto expression = compile_regex(source, false, message);
      if (!expression) {
        set_error(message.c_str());
        return false;
      }
      cache.source = std::move(source);
      cache.expression = std::move(expression);
    }
    return true;
  }

  void prepare_in_filter(const row_filter& filter, in_filter_cache& cache) {
    constexpr size_t hash_filter_threshold = 8;
    if (!filter.enabled || (filter.kind != row_filter_kind::in && filter.kind != row_filter_kind::noin) ||
        filter.value_count < hash_filter_threshold) {
      cache.use_set = false;
      return;
    }

    bool unchanged = cache.values.size() == filter.value_count;
    for (size_t index = 0; unchanged && index < filter.value_count; ++index) {
      const uint32_t start = filter.value_offsets[index];
      const uint32_t end = filter.value_offsets[index + 1];
      const size_t len = end - start;
      const auto& cached = cache.values[index];
      unchanged =
          cached.size() == len && (len == 0 || std::memcmp(cached.data(), filter.values_data + start, len) == 0);
    }
    if (unchanged) {
      cache.use_set = true;
      return;
    }

    cache.value_set.clear();
    cache.values.clear();
    cache.values.reserve(filter.value_count);
    for (size_t index = 0; index < filter.value_count; ++index) {
      const uint32_t start = filter.value_offsets[index];
      const uint32_t end = filter.value_offsets[index + 1];
      if (end == start) {
        cache.values.emplace_back();
      } else {
        cache.values.emplace_back(reinterpret_cast<const char*>(filter.values_data + start), end - start);
      }
    }

    cache.value_set.reserve(filter.value_count);
    for (const auto& value : cache.values) {
      cache.value_set.insert(value);
    }
    cache.use_set = true;
  }

  void parse_latin1_batch(const uint8_t* data, size_t len, bool strict) {
    if (data == nullptr || len == 0) {
      return;
    }

    size_t i = 0;
    unsigned misses_left = quoted_record_miss_limit;
    while (i < len) {
      if (in_quotes_) {
        if (pending_quote_) {
          if (data[i] == '"') {
            append_latin1_batch_byte('"');
            pending_quote_ = false;
            saw_row_data_ = true;
            at_field_start_ = false;
            ++i;
            continue;
          }
          if (strict && !is_quoted_field_terminator(data[i], delimiter_)) {
            fail_parse("strict CSV quote syntax error: unescaped quote in "
                       "quoted field");
            return;
          }
          pending_quote_ = false;
          in_quotes_ = false;
          continue;
        }

        const size_t quote = find_byte_simd(data + i, len - i, '"');
        const size_t span = quote == npos ? len - i : quote;
        append_latin1_batch_span(data + i, span);
        i += span;

        if (i < len && data[i] == '"') {
          pending_quote_ = true;
          ++i;
        }
        continue;
      }

      const uint8_t byte = data[i];
      if (previous_was_cr_ && byte == '\n') {
        previous_was_cr_ = false;
        ++i;
        continue;
      }
      previous_was_cr_ = false;

      if (byte == delimiter_) {
        finish_latin1_batch_field();
        saw_row_data_ = true;
        ++i;
        continue;
      }

      if (byte == '\n' || byte == '\r') {
        finish_latin1_batch_row(strict);
        if (limit_reached() || parse_failed_) {
          return;
        }
        previous_was_cr_ = byte == '\r';
        ++i;
        continue;
      }

      if (byte == '"' && at_field_start_) {
        if (!saw_row_data_ && current_column_ == 0 && misses_left != 0) {
          const size_t consumed = try_quoted_record(data + i, len - i);
          if (consumed != 0) {
            if (parse_failed_ || limit_reached()) {
              return;
            }
            i += consumed;
            misses_left = quoted_record_miss_limit;
            continue;
          }
          --misses_left;
        }
        const size_t close_quote = find_complete_quoted_field_close(data + i, len - i);
        if (close_quote != npos) {
          append_latin1_batch_quoted_field(data + i, close_quote);
          const size_t terminator_index = i + close_quote + 1;
          const uint8_t terminator = data[terminator_index];
          if (terminator == delimiter_) {
            finish_latin1_batch_field();
            saw_row_data_ = true;
            i = terminator_index + 1;
            continue;
          }
          if (terminator == '\n' || terminator == '\r') {
            finish_latin1_batch_row(strict);
            if (limit_reached() || parse_failed_) {
              return;
            }
            previous_was_cr_ = terminator == '\r';
            i = terminator_index + 1;
            continue;
          }
          i = terminator_index;
          continue;
        }

        in_quotes_ = true;
        at_field_start_ = false;
        saw_row_data_ = true;
        ++i;
        continue;
      }

      if (strict && byte == '"') {
        fail_parse("strict CSV quote syntax error: unescaped quote in unquoted field");
        return;
      }

      const size_t found = strict ? find_strict_plain_special_simd(data + i, len - i, delimiter_)
                                  : find_plain_special_simd(data + i, len - i, delimiter_);
      const size_t span = found == npos ? len - i : found;
      append_latin1_batch_span(data + i, span);
      i += span;
    }
  }

  // Return bytes consumed for a complete LF-terminated record of simple quoted fields.
  // Zero leaves all parser and batch state at the record start for the general parser.
  HWY_ATTR size_t try_quoted_record(const uint8_t* data, size_t available) {
    const size_t len = std::min<size_t>(available, std::numeric_limits<uint16_t>::max());
    std::array<uint16_t, 64> ends;
#if defined(__aarch64__)
    constexpr size_t lanes = 64;
    auto quote_mask = [](const uint8_t* input) {
      // The interleaved load groups four consecutive bytes at each lane index.
      const auto bytes = vld4q_u8(input);
      const auto quote = vdupq_n_u8('"');
      const auto bit0 = vandq_u8(vceqq_u8(bytes.val[0], quote), vdupq_n_u8(1));
      const auto bit1 = vandq_u8(vceqq_u8(bytes.val[1], quote), vdupq_n_u8(2));
      const auto bit2 = vandq_u8(vceqq_u8(bytes.val[2], quote), vdupq_n_u8(4));
      const auto bit3 = vandq_u8(vceqq_u8(bytes.val[3], quote), vdupq_n_u8(8));
      const auto nibbles = vreinterpretq_u16_u8(vorrq_u8(vorrq_u8(bit0, bit1), vorrq_u8(bit2, bit3)));
      // Pack adjacent nibbles into bytes in input order on little-endian ARM64.
      const auto packed = vmovn_u16(vorrq_u16(nibbles, vshrq_n_u16(nibbles, 4)));
      return vget_lane_u64(vreinterpret_u64_u8(packed), 0);
    };
#else
    const hn::CappedTag<uint8_t, 64> du8;
    const size_t lanes = hn::Lanes(du8);
    auto quote_mask = [du8](const uint8_t* input) HWY_ATTR {
      const auto quote = hn::Set(du8, static_cast<uint8_t>('"'));
      return hn::BitsFromMask(du8, hn::Eq(hn::LoadU(du8, input), quote));
    };
#endif
    size_t block = 0;
    size_t next_block = 0;
    uint64_t bits = 0;
    auto next_quote = [&]() -> size_t {
      while (bits == 0) {
        block = next_block;
        if (len - block < lanes) {
          while (next_block < len) {
            const size_t index = next_block++;
            if (data[index] == '"') {
              return index;
            }
          }
          return len;
        }
        bits = quote_mask(data + block);
        next_block += lanes;
      }
      const size_t lane = hwy::Num0BitsBelowLS1Bit_Nonzero64(bits);
      bits &= bits - 1;
      return block + lane;
    };

    size_t field_count = 0;
    size_t cursor = 0;
    while (true) {
      if (field_count == ends.size() || cursor >= len || next_quote() != cursor) {
        return 0;
      }
      const size_t end = next_quote();
      if (end + 1 >= len) {
        return 0;
      }
      ends[field_count++] = static_cast<uint16_t>(end);
      cursor = end + 2;
      if (data[end + 1] == '\n') {
        break;
      }
      if (data[end + 1] != delimiter_) {
        return 0;
      }
    }

    // Let finish_row report the physical width mismatch, even if a filter would reject this record.
    if (fixed_columns_ != 0 && field_count != fixed_columns_) {
      return 0;
    }
    if (rows_to_skip_ != 0) {
      // Strict reads validate skipped widths and may capture the original header.
      if (strict_quote_syntax_) {
        return 0;
      }
      --rows_to_skip_;
      return cursor;
    }

    const auto field_at = [&](size_t column) {
      // A closing quote, delimiter and opening quote separate consecutive payloads.
      const size_t start = column == 0 ? 1 : ends[column - 1] + 3;
      return std::string_view(reinterpret_cast<const char*>(data + start), ends[column] - start);
    };
    for (const auto& filter : filters_) {
      if (filter.kind == row_filter_kind::all_of) {
        continue;
      }
      // A missing physical column fails every leaf predicate, including inequality.
      if (filter.column >= field_count) {
        return cursor;
      }
      const bool equal = field_equals_filter(field_at(filter.column), filter.value, filter.value_len);
      if (equal != (filter.kind == row_filter_kind::equals)) {
        return cursor;
      }
    }

    size_t output = batch_->data.size();
    if (transform_matched_rows_) {
      if (!append_transformed_quoted_record(data, cursor, field_count, ends, field_at)) {
        fail_parse("invalid field transform");
        return cursor;
      }
    } else if (layout_ == batch_layout::latin1_quoted_spans && prepared_configuration_) {
      batch_->data.append(reinterpret_cast<const char*>(data), cursor);
      finish_quoted_spans(output, ends, field_count);
    } else if (encoding_ == csv_encoding::latin1 && !is_ascii(data, cursor)) {
      for (size_t column = 0; column < field_count; ++column) {
        const auto field = field_at(column);
        append_latin1(batch_->data, reinterpret_cast<const uint8_t*>(field.data()), field.size());
        batch_->field_offsets.push_back(batch_->data.size());
      }
    } else {
      const size_t payload_size = cursor - 3 * field_count;
      batch_->data.resize(output + payload_size);
      const size_t first = batch_->field_offsets.size();
      batch_->field_offsets.resize(first + field_count);
      for (size_t column = 0; column < field_count; ++column) {
        const auto field = field_at(column);
        if (!field.empty()) {
          std::memcpy(batch_->data.data() + output, field.data(), field.size());
        }
        output += field.size();
        batch_->field_offsets[first + column] = output;
      }
    }
    finish_batch_row();
    if (!parse_failed_) {
      record_emitted_row();
    }
    return cursor;
  }

  void finish_quoted_spans(size_t output, const std::array<uint16_t, 64>& ends, size_t field_count) {
    // Each span includes its opening quote, closing quote and one terminator.
    const size_t first = batch_->field_offsets.size();
    batch_->field_offsets.resize(first + field_count);
    for (size_t column = 0; column < field_count; ++column) {
      batch_->field_offsets[first + column] = output + ends[column] + 2;
    }
    batch_->quoted_rows.resize(batch_->row_offsets.size(), 0);
    batch_->quoted_rows.back() = 1;
  }

  bool append_transformed_quoted_record(const uint8_t* data, size_t len, size_t field_count,
                                        const std::array<uint16_t, 64>& ends, const auto& field_at) {
    const auto* uniform = transforms_.uniform_ascii_cleanup(field_count);
    const bool ascii = is_ascii(data, len);
    if (ascii && uniform != nullptr && (!uniform->trim || !quoted_record_may_need_trim(data, len))) {
      const size_t output = batch_->data.size();
      // The materializer skips syntax bytes, so alphabetic delimiters may be cased too.
      if (uniform->casing.has_value()) {
        const uint8_t first = *uniform->casing == transform_kind::upper ? 'a' : 'A';
        const uint8_t last = first + ('z' - 'a');
        batch_->data.resize(output + len);
        char* copied = batch_->data.data() + output;
        for (size_t i = 0; i < len; ++i) {
          copied[i] = data[i] >= first && data[i] <= last ? data[i] ^ ('a' ^ 'A') : data[i];
        }
      } else {
        batch_->data.append(reinterpret_cast<const char*>(data), len);
      }
      finish_quoted_spans(output, ends, field_count);
      return true;
    }
    if (ascii && transforms_.only_ascii_cleanup()) {
      // Each field has two quotes and a terminator. Trim and ASCII casing fit in the original payload.
      size_t output = batch_->data.size();
      batch_->data.resize(output + (len - 3 * field_count));
      const size_t first = batch_->field_offsets.size();
      batch_->field_offsets.resize(first + field_count);
      for (size_t column = 0; column < field_count; ++column) {
        output += transforms_.write_ascii(batch_->data.data() + output, column, field_at(column));
        batch_->field_offsets[first + column] = output;
      }
      batch_->data.resize(output);
      return true;
    }
    std::string decoded;
    for (size_t column = 0; column < field_count; ++column) {
      auto field = field_at(column);
      if (!ascii && encoding_ == csv_encoding::latin1) {
        decoded.clear();
        append_latin1(decoded, reinterpret_cast<const uint8_t*>(field.data()), field.size());
        field = decoded;
      }
      if (!transforms_.append(batch_->data, column, field, ascii))
        return false;
      batch_->field_offsets.push_back(batch_->data.size());
    }
    return true;
  }

  bool supports_quoted_records() const {
    if ((transform_matched_rows_ && layout_ != batch_layout::utf8) || !conjunctive_filters_ || projection_enabled_) {
      return false;
    }
    for (const auto& filter : filters_) {
      if (filter.kind == row_filter_kind::all_of) {
        continue;
      }
      if (filter.kind != row_filter_kind::equals && filter.kind != row_filter_kind::neq) {
        return false;
      }
      // ASCII predicate bytes compare identically against UTF-8 and the raw Latin-1 field.
      for (size_t i = 0; i < filter.value_len; ++i) {
        if (filter.value[i] >= 128) {
          return false;
        }
      }
    }
    return true;
  }

  template <bool try_quoted_records = false> void parse(const uint8_t* data, size_t len) {
    // Choose once per input span so unfiltered fields skip the borrowing checks.
    if (!filters_.empty() && encoding_ == csv_encoding::utf8) {
      parse_fields<try_quoted_records, true>(data, len);
    } else {
      parse_fields<try_quoted_records, false>(data, len);
    }
  }

  template <bool try_quoted_records, bool can_borrow_fields> void parse_fields(const uint8_t* data, size_t len) {
    if (data == nullptr || len == 0) {
      return;
    }

    // A fixed-width count with an empty projection carries only the physical column across writes.
    if (mode_ == output_mode::count && filters_.empty() &&
        (fixed_columns_ == 0 || (projection_enabled_ && selected_columns_len_ == 0))) {
      parse_count_only(data, len);
      return;
    }

    size_t i = 0;
    // Skipping a rejected tail ignores delimiters, which fixed-width validation needs to count.
    const bool can_skip_rejected_tail = !strict_quote_syntax_ && fixed_columns_ == 0;
    unsigned misses_left = quoted_record_miss_limit;
    const auto finish_borrowed_field = [this, data, len, can_skip_rejected_tail](std::string_view field,
                                                                                 size_t terminator_index) -> size_t {
      saw_row_data_ = true;
      at_field_start_ = false;
      const uint8_t terminator = data[terminator_index];
      size_t next_index = terminator_index + 1;
      if (terminator == delimiter_) {
        finish_field(field);
        if (can_skip_rejected_tail && row_filter_rejected()) {
          next_index += skip_rejected_row_tail(data + next_index, len - next_index);
        }
        return next_index;
      }

      finish_row(field);
      if (!parse_failed_ && !limit_reached()) {
        previous_was_cr_ = terminator == '\r';
      }
      return next_index;
    };
    if (can_skip_rejected_tail && row_filter_rejected()) {
      i = skip_rejected_row_tail(data, len);
    }
    while (i < len) {
      if (in_quotes_) {
        if (pending_quote_) {
          if (data[i] == '"') {
            append_decoded_byte('"');
            pending_quote_ = false;
            saw_row_data_ = true;
            at_field_start_ = false;
            ++i;
            continue;
          }
          if (strict_quote_syntax_ && !is_quoted_field_terminator(data[i], delimiter_)) {
            fail_parse("strict CSV quote syntax error: unescaped quote in "
                       "quoted field");
            return;
          }
          pending_quote_ = false;
          in_quotes_ = false;
          continue;
        }

        const size_t quote = find_byte_simd(data + i, len - i, '"');
        const size_t span = quote == npos ? len - i : quote;
        append_decoded_span(data + i, span);
        i += span;

        if (i < len && data[i] == '"') {
          pending_quote_ = true;
          ++i;
        }
        continue;
      }

      const uint8_t byte = data[i];
      if (previous_was_cr_ && byte == '\n') {
        previous_was_cr_ = false;
        ++i;
        continue;
      }
      previous_was_cr_ = false;

      if (byte == delimiter_) {
        finish_field(field_);
        saw_row_data_ = true;
        ++i;
        if (can_skip_rejected_tail && row_filter_rejected()) {
          i += skip_rejected_row_tail(data + i, len - i);
        }
        continue;
      }

      if (byte == '\n' || byte == '\r') {
        finish_row(field_);
        if (parse_failed_ || limit_reached()) {
          return;
        }
        previous_was_cr_ = byte == '\r';
        ++i;
        continue;
      }

      if (byte == '"' && at_field_start_) {
        if constexpr (try_quoted_records) {
          if (!saw_row_data_ && current_column_ == 0) {
            const size_t consumed = try_quoted_record(data + i, len - i);
            if (consumed != 0) {
              if (parse_failed_ || limit_reached()) {
                return;
              }
              misses_left = quoted_record_miss_limit;
              i += consumed;
              continue;
            }
            // Repeated misses would scan escaped or mixed-format records twice.
            // Resume at this record in the general loop until the next chunk.
            if (--misses_left == 0) {
              return parse_fields<false, can_borrow_fields>(data + i, len - i);
            }
          }
        }
        const size_t close_quote = find_complete_quoted_field_close(data + i, len - i);
        if (close_quote != npos) {
          const size_t terminator_index = i + close_quote + 1;
          if (can_borrow_fields && !complete_quoted_field_has_escape_ && can_borrow_current_filter_field()) {
            const std::string_view field(reinterpret_cast<const char*>(data + i + 1), close_quote - 1);
            i = finish_borrowed_field(field, terminator_index);
            if (parse_failed_ || limit_reached()) {
              return;
            }
            continue;
          }

          append_complete_quoted_field(data + i, close_quote);
          const uint8_t terminator = data[terminator_index];
          if (terminator == delimiter_) {
            finish_field(field_);
            saw_row_data_ = true;
            i = terminator_index + 1;
            if (can_skip_rejected_tail && row_filter_rejected()) {
              i += skip_rejected_row_tail(data + i, len - i);
            }
            continue;
          }
          if (terminator == '\n' || terminator == '\r') {
            finish_row(field_);
            if (parse_failed_ || limit_reached()) {
              return;
            }
            previous_was_cr_ = terminator == '\r';
            i = terminator_index + 1;
            continue;
          }
          i = terminator_index;
          continue;
        }

        in_quotes_ = true;
        at_field_start_ = false;
        saw_row_data_ = true;
        ++i;
        continue;
      }

      if (strict_quote_syntax_ && byte == '"') {
        fail_parse("strict CSV quote syntax error: unescaped quote in unquoted field");
        return;
      }

      const size_t span = find_plain_span(data + i, len - i);
      if (can_borrow_fields && can_borrow_current_filter_field() && span < len - i &&
          is_quoted_field_terminator(data[i + span], delimiter_)) {
        const std::string_view field(reinterpret_cast<const char*>(data + i), span);
        i = finish_borrowed_field(field, i + span);
        if (parse_failed_ || limit_reached()) {
          return;
        }
        continue;
      }
      append_plain_span(data + i, span, len - i);
      i += span;
    }
  }

  size_t skip_rejected_row_tail(const uint8_t* data, size_t len) {
    // A definitive false result cannot be changed by later fields. Retain the tolerant
    // quote state while skipping their boundaries; strict syntax still uses parse().
    csv_structural_state state{
        .in_quotes = in_quotes_,
        .pending_quote = pending_quote_,
        .at_field_start = at_field_start_,
        .previous_was_cr = previous_was_cr_,
        .saw_row_data = saw_row_data_,
    };
    size_t consumed = len;
    const bool unfinished = scan_csv_row_ends<false>(data, len, delimiter_, 0, state, [&](uint64_t row_end) {
      consumed = static_cast<size_t>(row_end);
      return false;
    });
    in_quotes_ = state.in_quotes;
    pending_quote_ = state.pending_quote;
    at_field_start_ = state.at_field_start;
    previous_was_cr_ = state.previous_was_cr;
    saw_row_data_ = state.saw_row_data;
    if (!unfinished) {
      finish_row(field_);
    }
    return consumed;
  }

  void parse_count_only(const uint8_t* data, size_t len) {
    csv_structural_state state{
        .in_quotes = in_quotes_,
        .pending_quote = pending_quote_,
        .at_field_start = at_field_start_,
        .previous_was_cr = previous_was_cr_,
        .saw_row_data = saw_row_data_,
    };
    if (fixed_columns_ != 0) {
      scan_csv_row_ends<false>(
          data, len, delimiter_, 0, state,
          [&](uint64_t) {
            if (current_column_ != fixed_columns_ - 1) {
              fail_parse("fixed row column count mismatch");
              return false;
            }
            current_column_ = 0;
            if (rows_to_skip_ != 0) {
              --rows_to_skip_;
            } else {
              record_emitted_row();
            }
            return !limit_reached();
          },
          &current_column_);
    } else if (rows_left_ == std::numeric_limits<uint64_t>::max()) {
      csv_row_counter on_row_end{emitted_rows_, current_column_};
      scan_csv_row_ends<false, true>(data, len, delimiter_, 0, state, on_row_end);
    } else {
      scan_csv_row_ends<false>(data, len, delimiter_, 0, state, [&](uint64_t) {
        current_column_ = 0;
        record_emitted_row();
        return !limit_reached();
      });
    }
    in_quotes_ = state.in_quotes;
    pending_quote_ = state.pending_quote;
    at_field_start_ = state.at_field_start;
    previous_was_cr_ = state.previous_was_cr;
    saw_row_data_ = state.saw_row_data;
  }

  size_t find_plain_span(const uint8_t* data, size_t len) const {
    const size_t found = strict_quote_syntax_ ? find_strict_plain_special_simd(data, len, delimiter_)
                                              : find_plain_special_simd(data, len, delimiter_);
    return found == npos ? len : found;
  }

  HWY_ATTR size_t find_complete_quoted_field_close(const uint8_t* data, size_t len) const {
    complete_quoted_field_has_escape_ = false;

    const hn::CappedTag<uint8_t, 64> du8;
    const size_t lanes = hn::Lanes(du8);
    const auto quote_v = hn::Set(du8, static_cast<uint8_t>('"'));
    size_t i = 1;

    while (i + lanes <= len) {
      const auto bytes = hn::LoadU(du8, data + i);
      uint64_t quote_bits = hn::BitsFromMask(du8, hn::Eq(bytes, quote_v));
      if (quote_bits == 0) {
        i += lanes;
        continue;
      }

      while (quote_bits != 0) {
        const size_t lane = hwy::Num0BitsBelowLS1Bit_Nonzero64(quote_bits);
        const size_t quote = i + lane;
        if (quote + 1 >= len) {
          return npos;
        }

        const uint8_t next = data[quote + 1];
        if (next == '"') {
          complete_quoted_field_has_escape_ = true;
          if (quote + 2 > i + lanes) {
            i = quote + 2;
            goto continue_outer;
          }
          quote_bits = clear_mask_bits_through(quote_bits, lane + 1);
          continue;
        }
        if (is_quoted_field_terminator(next, delimiter_)) {
          return quote;
        }
        return npos;
      }

      i += lanes;
    continue_outer:
      continue;
    }

    while (i < len) {
      if (data[i] != '"') {
        ++i;
        continue;
      }

      if (i + 1 >= len) {
        return npos;
      }

      const uint8_t next = data[i + 1];
      if (next == '"') {
        complete_quoted_field_has_escape_ = true;
        i += 2;
        continue;
      }
      if (is_quoted_field_terminator(next, delimiter_)) {
        return i;
      }
      return npos;
    }

    return npos;
  }

  void append_latin1_batch_span(const uint8_t* data, size_t len) {
    if (len == 0) {
      return;
    }
    saw_row_data_ = true;
    at_field_start_ = false;
    append_latin1(field_, data, len);
  }

  void append_latin1_batch_byte(uint8_t byte) {
    saw_row_data_ = true;
    at_field_start_ = false;
    field_.push_back(static_cast<char>(byte));
  }

  void append_latin1_batch_quoted_field(const uint8_t* data, size_t close_quote) {
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!complete_quoted_field_has_escape_) {
      append_latin1(field_, data + 1, close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        append_latin1(field_, data + segment_start, i - segment_start);
        field_.push_back('"');
        ++i;
        segment_start = i + 1;
      }
    }
    append_latin1(field_, data + segment_start, close_quote - segment_start);
  }

  void append_decoded_byte(uint8_t byte) { append_decoded_span(&byte, 1); }

  bool can_borrow_current_filter_field() const {
    return is_filter_column(current_column_) && encoding_ == csv_encoding::utf8 && at_field_start_ && field_.empty() &&
           !field_in_arena_ && !row_filter_rejected();
  }

  void append_plain_span(const uint8_t* data, size_t len, size_t remaining) {
    if (can_append_complete_plain_field_to_arena(len, remaining)) {
      append_utf8_span_to_arena(data, len);
      return;
    }

    append_decoded_span(data, len);
  }

  void append_decoded_span(const uint8_t* data, size_t len) {
    if (len == 0) {
      return;
    }
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!should_capture_current_field()) {
      return;
    }

    if (encoding_ == csv_encoding::utf8) {
      field_.append(reinterpret_cast<const char*>(data), len);
      return;
    }

    append_latin1(field_, data, len);
  }

  bool can_append_complete_plain_field_to_arena(size_t len, size_t remaining) const {
    return mode_ == output_mode::batch && encoding_ == csv_encoding::utf8 && batch_ != nullptr &&
           (!use_deferred_rows() || can_append_direct_projection_to_arena()) && at_field_start_ && field_.empty() &&
           !field_in_arena_ && len < remaining;
  }

  bool can_append_direct_projection_to_arena() const {
    return direct_projection_ && !row_filter_rejected() && should_store_current_field() &&
           !is_filter_column(current_column_);
  }

  void append_utf8_span_to_arena(const uint8_t* data, size_t len) {
    saw_row_data_ = true;
    at_field_start_ = false;
    field_in_arena_ = true;
    if (len != 0) {
      batch_->data.append(reinterpret_cast<const char*>(data), len);
    }
  }

  void append_complete_quoted_field(const uint8_t* data, size_t close_quote) {
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!should_capture_current_field()) {
      return;
    }

    if (encoding_ == csv_encoding::utf8 && mode_ == output_mode::batch && batch_ != nullptr &&
        (!use_deferred_rows() || can_append_direct_projection_to_arena()) && field_.empty() && !field_in_arena_) {
      append_quoted_field_to_arena(data, close_quote);
      return;
    }

    append_quoted_field_to_field_buffer(data, close_quote);
  }

  void append_quoted_field_to_arena(const uint8_t* data, size_t close_quote) {
    field_in_arena_ = true;
    if (!complete_quoted_field_has_escape_) {
      batch_->data.append(reinterpret_cast<const char*>(data + 1), close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        batch_->data.append(reinterpret_cast<const char*>(data + segment_start), i - segment_start);
        batch_->data.push_back('"');
        ++i;
        segment_start = i + 1;
      }
    }
    batch_->data.append(reinterpret_cast<const char*>(data + segment_start), close_quote - segment_start);
  }

  void append_quoted_field_to_field_buffer(const uint8_t* data, size_t close_quote) {
    if (!complete_quoted_field_has_escape_) {
      append_decoded_span(data + 1, close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        append_decoded_span(data + segment_start, i - segment_start);
        append_decoded_byte('"');
        ++i;
        segment_start = i + 1;
      }
    }
    append_decoded_span(data + segment_start, close_quote - segment_start);
  }

  void finish_latin1_batch_field() {
    if (deferred_batch_row_) {
      row_fields_.push_back(field_);
    } else {
      batch_->data.append(field_);
      batch_->field_offsets.push_back(batch_->data.size());
    }
    field_.clear();
    field_in_arena_ = false;
    at_field_start_ = true;
    ++current_column_;
  }

  void finish_latin1_batch_offsets(bool strict) {
    if (strict) {
      const uint64_t row_start = batch_->row_offsets.back();
      const size_t row_end = batch_->field_offsets.size() - 1;
      const uint32_t field_count = checked_u32(row_end - row_start);
      if (!strict_expected_columns_seen_) {
        strict_expected_columns_ = field_count;
        strict_expected_columns_seen_ = true;
      } else if (field_count != strict_expected_columns_) {
        set_error("strict CSV row column count mismatch");
        parse_failed_ = true;
        return;
      }
    }

    batch_->row_offsets.push_back(batch_->field_offsets.size() - 1);
  }

  void finish_latin1_batch_row(bool strict) {
    if (!saw_row_data_) {
      at_field_start_ = true;
    }

    finish_latin1_batch_field();
    if (deferred_batch_row_) {
      for (const auto& field : row_fields_) {
        batch_->data.append(field);
        batch_->field_offsets.push_back(batch_->data.size());
      }
    }
    finish_latin1_batch_offsets(strict);
    if (parse_failed_) {
      return;
    }
    if (rows_to_skip_ != 0) {
      --rows_to_skip_;
      discard_batch_row();
    } else {
      record_emitted_row();
    }
    reset_row_state();
    saw_row_data_ = false;
    at_field_start_ = true;
  }

  void finish_latin1_batch_stream(bool strict) {
    if (pending_quote_) {
      pending_quote_ = false;
      in_quotes_ = false;
    }
    if (in_quotes_) {
      if (strict) {
        fail_parse("strict CSV quote syntax error: unterminated quoted field");
        return;
      }
      in_quotes_ = false;
    }
    if (saw_row_data_) {
      finish_latin1_batch_row(strict);
    } else if (rows_to_skip_ != 0 && skip_state_.saw_row_data) {
      --rows_to_skip_;
      skip_state_ = {};
    }
  }

  template <typename Field> void finish_field(const Field& field) {
    if (use_deferred_rows()) {
      finish_deferred_field(field);
    } else if (mode_ == output_mode::batch && batch_ != nullptr) {
      if (!field_in_arena_) {
        batch_->data.append(field);
      }
      batch_->field_offsets.push_back(batch_->data.size());
    }
    field_.clear();
    field_in_arena_ = false;
    at_field_start_ = true;
    ++current_column_;
  }

  template <typename Field> void finish_row(const Field& field) {
    if (!saw_row_data_) {
      at_field_start_ = true;
    }

    finish_field(field);
    // Count every physical field before deciding whether to emit the row.
    if (fixed_columns_ != 0 && current_column_ != fixed_columns_) {
      fail_parse("fixed row column count mismatch");
    } else {
      emit_matching_row();
    }
    reset_row_state();
    saw_row_data_ = false;
    at_field_start_ = true;
  }

  void emit_matching_row() {
    const bool skipping = rows_to_skip_ != 0;
    if (skipping) {
      --rows_to_skip_;
    }
    // Strict width validation inspects the completed batch row, including a skipped header.
    const bool emit_row = (!skipping || strict_quote_syntax_) && row_matches_filters();
    if (mode_ == output_mode::batch && emit_row) {
      if (direct_projection_) {
        finish_direct_projection_row();
      } else if (use_deferred_rows()) {
        commit_deferred_batch_row();
      } else {
        finish_batch_row();
      }
      if (skipping && !parse_failed_) {
        discard_batch_row();
      }
    } else if (mode_ == output_mode::batch && (skipping || direct_projection_)) {
      discard_uncommitted_fields();
    }
    if (emit_row && !skipping) {
      record_emitted_row();
    }
  }

  void discard_batch_row() {
    if (capture_header_ && skipped_rows() == 1) {
      // Schema validation needs the original header even when no row is returned.
      skipped_header_ = std::make_unique<csv_batch>();
      skipped_header_->data.swap(batch_->data);
      skipped_header_->row_offsets.swap(batch_->row_offsets);
      skipped_header_->field_offsets.swap(batch_->field_offsets);
      return;
    }
    batch_->row_offsets.pop_back();
    discard_uncommitted_fields();
  }

  void discard_uncommitted_fields() {
    batch_->field_offsets.resize(batch_->row_offsets.back() + 1);
    batch_->data.resize(batch_->field_offsets.back());
  }

  bool use_deferred_rows() const { return projection_enabled_ || !filters_.empty() || deferred_batch_row_; }

  bool should_capture_current_field() const {
    if (row_filter_rejected()) {
      return false;
    }

    if (mode_ == output_mode::count) {
      return is_filter_column(current_column_);
    }

    if (!use_deferred_rows()) {
      return true;
    }

    return should_store_current_field() || is_filter_column(current_column_);
  }

  bool is_filter_column(size_t column) const {
    return column < first_filter_by_column_.size() &&
           first_filter_by_column_[column] != std::numeric_limits<uint32_t>::max();
  }

  bool should_store_current_field() const {
    return !projection_enabled_ || selected_output_index(current_column_) != no_selected_output;
  }

  bool row_filter_rejected() const {
    return conjunctive_filters_ ? flat_filter_rejected_ : filter_program_truth_ == filter_truth::false_value;
  }

  bool can_use_direct_projection() const {
    if (!allow_direct_projection_ || mode_ != output_mode::batch) {
      return false;
    }

    if (!projection_enabled_) {
      return !filters_.empty();
    }

    if (selected_columns_len_ == 0) {
      return false;
    }

    uint32_t previous = 0;
    for (size_t i = 0; i < selected_columns_len_; ++i) {
      const uint32_t column = selected_columns_[i];
      if (i != 0 && column <= previous) {
        return false;
      }
      previous = column;
    }
    return true;
  }

  uint16_t selected_output_index(size_t column) const {
    return column < selected_output_by_column_.size() ? selected_output_by_column_[column] : no_selected_output;
  }

  template <typename Field> void finish_deferred_field(const Field& field) {
    if (direct_projection_) {
      finish_direct_projection_field(field);
      return;
    }

    evaluate_current_field_filters(field);

    if (mode_ != output_mode::batch) {
      return;
    }

    if (row_filter_rejected()) {
      return;
    }

    if (!projection_enabled_) {
      row_fields_.emplace_back(field);
      return;
    }

    const uint16_t output_index = selected_output_index(current_column_);
    if (output_index != no_selected_output) {
      projected_fields_[output_index] = field;
    }
  }

  template <typename Field> void finish_direct_projection_field(const Field& field) {
    evaluate_current_field_filters(field);

    if (batch_ == nullptr || row_filter_rejected() || !should_store_current_field()) {
      return;
    }

    if (!field_in_arena_) {
      // A buffered field can extend the carried prefix until the first field is written to this batch.
      if (!direct_projection_carry_offsets_.empty() && batch_->field_offsets.size() == 1) {
        direct_projection_carry_data_.append(field);
        direct_projection_carry_offsets_.push_back(direct_projection_carry_data_.size());
        return;
      }
      batch_->data.append(field);
    }
    batch_->field_offsets.push_back(batch_->data.size());
  }

  void finish_direct_projection_row() {
    if (!direct_projection_carry_offsets_.empty()) {
      // A row carried from a preceding write is the first row in this batch.
      // Fields completed in this write already occupy its suffix.
      batch_->data.insert(0, direct_projection_carry_data_);
      for (size_t index = 1; index < batch_->field_offsets.size(); ++index) {
        batch_->field_offsets[index] += direct_projection_carry_data_.size();
      }
      batch_->field_offsets.insert(batch_->field_offsets.begin() + 1, direct_projection_carry_offsets_.begin(),
                                   direct_projection_carry_offsets_.end());
    }
    const size_t field_count = batch_->field_offsets.size() - 1 - batch_->row_offsets.back();
    for (size_t index = field_count; index < selected_columns_len_; ++index) {
      batch_->field_offsets.push_back(batch_->data.size());
    }
    finish_batch_row();
  }

  void defer_direct_projection_carry() {
    if (direct_projection_carry_offsets_.empty()) {
      return;
    }

    // Per-write configuration can switch a carried row to the general deferred path.
    size_t start = 0;
    for (size_t index = 0; index < direct_projection_carry_offsets_.size(); ++index) {
      const size_t end = direct_projection_carry_offsets_[index];
      if (projection_enabled_) {
        if (index < projected_fields_.size()) {
          projected_fields_[index].assign(direct_projection_carry_data_.data() + start, end - start);
        }
      } else {
        row_fields_.emplace_back(direct_projection_carry_data_.data() + start, end - start);
      }
      start = end;
    }
    if (!projection_enabled_) {
      deferred_batch_row_ = true;
    }
    direct_projection_carry_data_.clear();
    direct_projection_carry_offsets_.clear();
  }

  template <typename Field> void evaluate_current_field_filters(const Field& field) {
    if (row_filter_rejected()) {
      return;
    }
    if (!is_filter_column(current_column_)) {
      return;
    }

    // Private row materialization stores Latin1 bytes, but predicates always consume UTF-8.
    if (layout_ != batch_layout::utf8) {
      utf8_filter_field_.clear();
      append_latin1(utf8_filter_field_, reinterpret_cast<const uint8_t*>(field.data()), field.size());
    }
    const std::string_view filter_field =
        layout_ != batch_layout::utf8 ? std::string_view(utf8_filter_field_) : std::string_view(field);
    bool changed = false;
    for (uint32_t filter_index = first_filter_by_column_[current_column_];
         filter_index != std::numeric_limits<uint32_t>::max(); filter_index = next_filter_[filter_index]) {
      const bool matched = field_matches_filter(filter_index, filter_field);
      changed = changed || !row_filter_seen_[filter_index] || row_filter_matched_[filter_index] != matched;
      row_filter_seen_[filter_index] = true;
      row_filter_matched_[filter_index] = matched;
      if (conjunctive_filters_ && !matched) {
        flat_filter_rejected_ = true;
      }
    }
    if (changed && !conjunctive_filters_ && filter_program_truth_ == filter_truth::unknown) {
      filter_program_truth_ = evaluate_filter_program();
    }
  }

  bool row_matches_filters() {
    if (!conjunctive_filters_) {
      if (filter_program_truth_ == filter_truth::unknown) {
        filter_program_truth_ = evaluate_filter_program();
      }
      return filter_program_truth_ == filter_truth::true_value;
    }
    for (size_t index = 0; index < filters_.size(); ++index) {
      if (is_boolean_operator(filters_[index].kind)) {
        continue;
      }
      if (!row_filter_seen_[index] || !row_filter_matched_[index]) {
        return false;
      }
    }
    return true;
  }

  filter_truth evaluate_filter_program() {
    size_t depth = 0;
    for (size_t index = 0; index < filters_.size(); ++index) {
      const auto kind = filters_[index].kind;
      if (!is_boolean_operator(kind)) {
        filter_truth_stack_[depth++] = !row_filter_seen_[index]     ? filter_truth::unknown
                                       : row_filter_matched_[index] ? filter_truth::true_value
                                                                    : filter_truth::false_value;
        continue;
      }

      const size_t operand_count = filters_[index].column;
      const size_t first_operand = depth - operand_count;
      if (kind == row_filter_kind::negate) {
        auto& value = filter_truth_stack_[first_operand];
        if (value == filter_truth::true_value) {
          value = filter_truth::false_value;
        } else if (value == filter_truth::false_value) {
          value = filter_truth::true_value;
        }
        depth = first_operand + 1;
        continue;
      }

      filter_truth result = kind == row_filter_kind::all_of ? filter_truth::true_value : filter_truth::false_value;
      for (size_t operand = first_operand; operand < depth; ++operand) {
        const auto value = filter_truth_stack_[operand];
        if (kind == row_filter_kind::all_of) {
          if (value == filter_truth::false_value) {
            result = filter_truth::false_value;
            break;
          }
          if (value == filter_truth::unknown) {
            result = filter_truth::unknown;
          }
          continue;
        }
        if (value == filter_truth::true_value) {
          result = filter_truth::true_value;
          break;
        }
        if (value == filter_truth::unknown) {
          result = filter_truth::unknown;
        }
      }
      filter_truth_stack_[first_operand] = result;
      depth = first_operand + 1;
    }
    return filter_truth_stack_[0];
  }

  bool field_matches_filter(size_t filter_index, std::string_view field) const {
    const auto& filter = filters_[filter_index];
    switch (filter.kind) {
    case row_filter_kind::equals:
      return field_equals_filter(field, filter.value, filter.value_len);
    case row_filter_kind::in:
      return field_in_filter(field, filter, in_filter_caches_[filter_index]);
    case row_filter_kind::neq:
      return !field_equals_filter(field, filter.value, filter.value_len);
    case row_filter_kind::noin:
      return !field_in_filter(field, filter, in_filter_caches_[filter_index]);
    case row_filter_kind::starts_with:
      return field_starts_with_filter(field, filter);
    case row_filter_kind::regex: {
      const auto& expression = regex_filter_caches_[filter_index].expression;
      return expression != nullptr &&
             re2::RE2::PartialMatch(absl::string_view(field.data(), field.size()), *expression);
    }
    case row_filter_kind::none:
      return true;
    case row_filter_kind::all_of:
    case row_filter_kind::any_of:
    case row_filter_kind::negate:
      return false;
    }
    return false;
  }

  bool field_equals_filter(std::string_view field, const uint8_t* value, size_t value_len) const {
    if (field.size() != value_len) {
      return false;
    }
    if (value_len == 0) {
      return true;
    }
    return std::memcmp(field.data(), value, value_len) == 0;
  }

  bool field_in_filter(std::string_view field, const row_filter& filter, const in_filter_cache& cache) const {
    if (filter.value_offsets == nullptr) {
      return false;
    }
    if (cache.use_set) {
      return cache.value_set.find(field) != cache.value_set.end();
    }
    for (size_t index = 0; index < filter.value_count; ++index) {
      const uint32_t start = filter.value_offsets[index];
      const uint32_t end = filter.value_offsets[index + 1];
      const uint8_t* value = filter.values_data == nullptr ? nullptr : filter.values_data + start;
      if (field_equals_filter(field, value, end - start)) {
        return true;
      }
    }
    return false;
  }

  bool field_starts_with_filter(std::string_view field, const row_filter& filter) const {
    if (field.size() < filter.value_len) {
      return false;
    }
    if (filter.value_len == 0) {
      return true;
    }
    return std::memcmp(field.data(), filter.value, filter.value_len) == 0;
  }

  void commit_deferred_batch_row() {
    if (batch_ == nullptr) {
      return;
    }

    if (transform_matched_rows_) {
      const auto& fields = projection_enabled_ ? projected_fields_ : row_fields_;
      for (size_t i = 0; i < fields.size(); ++i) {
        const size_t column = projection_enabled_ ? selected_columns_[i] : i;
        if (column < current_column_ && !transforms_.append(batch_->data, column, fields[i])) {
          fail_parse("invalid field transform");
          return;
        }
        batch_->field_offsets.push_back(batch_->data.size());
      }
      finish_batch_row();
    } else if (projection_enabled_) {
      commit_fields(projected_fields_);
    } else {
      commit_fields(row_fields_);
    }
  }

  void commit_fields(const std::vector<std::string>& fields) {
    if (batch_ == nullptr) {
      return;
    }

    for (const auto& field : fields) {
      batch_->data.append(field);
      batch_->field_offsets.push_back(batch_->data.size());
    }
    finish_batch_row();
  }

  void reset_row_state() {
    current_column_ = 0;
    std::fill(row_filter_seen_.begin(), row_filter_seen_.end(), false);
    std::fill(row_filter_matched_.begin(), row_filter_matched_.end(), false);
    row_fields_.clear();
    for (auto& field : projected_fields_) {
      field.clear();
    }
    deferred_batch_row_ = transform_matched_rows_;
    if (!direct_projection_carry_offsets_.empty()) {
      direct_projection_carry_data_.clear();
      direct_projection_carry_offsets_.clear();
    }
    filter_program_truth_ = filter_truth::unknown;
    flat_filter_rejected_ = false;
  }

  void spill_unfinished_direct_projection_row() {
    if (batch_ == nullptr || !saw_row_data_ || !direct_projection_) {
      return;
    }
    const size_t field_start = batch_->row_offsets.back() + 1;
    if (field_start == batch_->field_offsets.size()) {
      return;
    }
    // Save only fields completed since the last write. The committed row and
    // field offsets identify the unfinished suffix for both spill and rollback.
    const size_t data_start = batch_->field_offsets[field_start - 1];
    const size_t carried_size = direct_projection_carry_data_.size();
    direct_projection_carry_data_.append(batch_->data.data() + data_start, batch_->data.size() - data_start);
    for (size_t index = field_start; index < batch_->field_offsets.size(); ++index) {
      direct_projection_carry_offsets_.push_back(carried_size + (batch_->field_offsets[index] - data_start));
    }
    discard_uncommitted_fields();
  }

  void spill_unfinished_batch_row() {
    if (batch_ == nullptr || !saw_row_data_ || projection_enabled_ || !filters_.empty() || deferred_batch_row_) {
      return;
    }

    const size_t row_start = batch_->row_offsets.back();
    if (row_start >= batch_->field_offsets.size()) {
      return;
    }

    const size_t row_data_start = batch_->field_offsets[row_start];
    const size_t completed_field_count = batch_->field_offsets.size() - 1;
    row_fields_.clear();
    row_fields_.reserve(completed_field_count - row_start);
    for (size_t field_index = row_start; field_index < completed_field_count; ++field_index) {
      const size_t start = batch_->field_offsets[field_index];
      const size_t end = batch_->field_offsets[field_index + 1];
      row_fields_.emplace_back(batch_->data.data() + start, end - start);
    }

    if (field_in_arena_) {
      const size_t start = batch_->field_offsets.back();
      const size_t end = batch_->data.size();
      field_.assign(batch_->data.data() + start, end - start);
      field_in_arena_ = false;
    }

    batch_->data.resize(row_data_start);
    batch_->field_offsets.resize(row_start + 1);
    deferred_batch_row_ = true;
  }

  void finish_batch_row() {
    if (batch_ == nullptr) {
      return;
    }

    if (strict_quote_syntax_ && fixed_columns_ == 0) {
      const uint64_t row_start = batch_->row_offsets.back();
      const size_t row_end = batch_->field_offsets.size() - 1;
      const uint32_t field_count = checked_u32(row_end - row_start);
      if (!strict_expected_columns_seen_) {
        strict_expected_columns_ = field_count;
        strict_expected_columns_seen_ = true;
      } else if (field_count != strict_expected_columns_) {
        set_error("strict CSV row column count mismatch");
        parse_failed_ = true;
        return;
      }
    }

    batch_->row_offsets.push_back(batch_->field_offsets.size() - 1);
  }

  void finish_stream() {
    if (pending_quote_) {
      pending_quote_ = false;
      in_quotes_ = false;
    }
    if (in_quotes_) {
      if (strict_quote_syntax_) {
        fail_parse("strict CSV quote syntax error: unterminated quoted field");
        return;
      }
      in_quotes_ = false;
    }
    if (saw_row_data_) {
      finish_row(field_);
    } else if (rows_to_skip_ != 0 && skip_state_.saw_row_data) {
      --rows_to_skip_;
      skip_state_ = {};
    }
  }

  void fail_parse(const char* message) {
    set_error(message);
    parse_failed_ = true;
  }

  static uint32_t checked_u32(size_t value) {
    if (value > std::numeric_limits<uint32_t>::max()) {
      return std::numeric_limits<uint32_t>::max();
    }
    return static_cast<uint32_t>(value);
  }

  csv_encoding encoding_;
  uint8_t delimiter_;
  const batch_layout layout_;
  std::string utf8_filter_field_;
  output_mode mode_ = output_mode::batch;
  csv_batch* batch_ = nullptr;
  bool configuration_initialized_ = false;
  bool prepared_configuration_ = false;
  field_transforms transforms_;
  bool transform_matched_rows_ = false;
  bool prepared_direct_projection_ = false;
  bool prepared_quoted_records_ = false;
  size_t filtered_batch_input_len_ = 0;
  size_t filtered_batch_data_size_ = 0;
  size_t filtered_batch_field_count_ = 0;
  size_t filtered_batch_row_count_ = 0;
  std::vector<uint32_t> owned_selected_columns_;
  std::vector<uint8_t> owned_filter_values_;
  std::vector<uint32_t> owned_filter_offsets_;
  const uint32_t* selected_columns_ = nullptr;
  size_t selected_columns_len_ = 0;
  std::vector<uint16_t> selected_output_by_column_;
  bool projection_enabled_ = false;
  bool direct_projection_ = false;
  bool strict_quote_syntax_ = false;
  uint32_t fixed_columns_ = 0;
  uint32_t strict_expected_columns_ = 0;
  bool strict_expected_columns_seen_ = false;
  bool parse_failed_ = false;
  std::string direct_projection_carry_data_;
  std::vector<size_t> direct_projection_carry_offsets_;
  std::vector<row_filter> filters_;
  std::vector<uint32_t> first_filter_by_column_;
  std::vector<uint32_t> next_filter_;
  std::string field_;
  std::vector<std::string> row_fields_;
  std::vector<std::string> projected_fields_;
  std::vector<in_filter_cache> in_filter_caches_;
  std::vector<regex_filter_cache> regex_filter_caches_;
  std::string error_;
  bool in_quotes_ = false;
  bool pending_quote_ = false;
  bool at_field_start_ = true;
  bool saw_row_data_ = false;
  bool previous_was_cr_ = false;
  size_t current_column_ = 0;
  std::vector<bool> row_filter_seen_;
  std::vector<bool> row_filter_matched_;
  std::vector<filter_truth> filter_truth_stack_;
  filter_truth filter_program_truth_ = filter_truth::unknown;
  bool flat_filter_rejected_ = false;
  bool conjunctive_filters_ = true;
  bool field_in_arena_ = false;
  mutable bool complete_quoted_field_has_escape_ = false;
  bool allow_direct_projection_ = false;
  bool deferred_batch_row_ = false;
  uint64_t emitted_rows_ = 0;
  uint64_t initial_skip_ = 0;
  uint64_t initial_limit_ = std::numeric_limits<uint64_t>::max();
  uint64_t rows_to_skip_ = 0;
  uint64_t rows_left_ = std::numeric_limits<uint64_t>::max();
  csv_structural_state skip_state_;
  bool capture_header_ = false;
  std::unique_ptr<csv_batch> skipped_header_;
};

csv_parser* checked_parser(void* parser) { return static_cast<csv_parser*>(parser); }

csv_batch* checked_batch(void* batch) { return static_cast<csv_batch*>(batch); }

csv_split_offsets_batch* checked_split_offsets_batch(void* batch) {
  return static_cast<csv_split_offsets_batch*>(batch);
}

bool valid_value_offsets(const uint32_t* offsets, size_t value_count, uint64_t values_data_len) {
  if (value_count == 0 || offsets == nullptr) {
    return false;
  }
  uint32_t previous = offsets[0];
  if (previous != 0 || previous > values_data_len) {
    return false;
  }
  for (size_t index = 0; index < value_count; ++index) {
    const uint32_t next = offsets[index + 1];
    if (next < previous || next > values_data_len) {
      return false;
    }
    previous = next;
  }
  return true;
}

bool valid_column_index(csv_parser& parser, uint32_t column) {
  if (column <= max_column_index) {
    return true;
  }
  parser.set_error("column index exceeds maximum of 2024");
  return false;
}

bool valid_projection(csv_parser& parser, const uint32_t* selected_columns, uint64_t selected_columns_len) {
  if (selected_columns_len > max_projection_length) {
    parser.set_error("selected columns length exceeds maximum of 2024");
    return false;
  }
  if (selected_columns == nullptr) {
    parser.set_error("selected columns are null");
    return false;
  }

  std::array<bool, max_column_index + 1> seen{};
  for (size_t index = 0; index < selected_columns_len; ++index) {
    const uint32_t column = selected_columns[index];
    if (!valid_column_index(parser, column)) {
      return false;
    }
    if (seen[column]) {
      parser.set_error("selected columns must not contain duplicates");
      return false;
    }
    seen[column] = true;
  }
  return true;
}

bool build_row_filters(csv_parser& parser, const uint32_t* descriptors, uint64_t filter_count,
                       const uint8_t* values_data, uint64_t values_data_len, const uint32_t* value_offsets,
                       uint64_t total_value_count, std::vector<row_filter>& filters) {
  if (filter_count > max_filter_program_length) {
    parser.set_error("filter program length exceeds maximum of 4096");
    return false;
  }
  if (filter_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max() / 4)) {
    parser.set_error("filter descriptor length exceeds platform limits");
    return false;
  }
  if (filter_count != 0 && descriptors == nullptr) {
    parser.set_error("filter descriptors are null");
    return false;
  }
  if (values_data_len > std::numeric_limits<uint32_t>::max() ||
      values_data_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    parser.set_error("filter values data length exceeds supported limits");
    return false;
  }
  if (values_data == nullptr && values_data_len != 0) {
    parser.set_error("filter values data is null");
    return false;
  }
  if (total_value_count > std::numeric_limits<uint32_t>::max() ||
      total_value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    parser.set_error("filter value count exceeds supported limits");
    return false;
  }
  if (value_offsets == nullptr) {
    parser.set_error("filter value offsets are null");
    return false;
  }

  uint32_t previous = value_offsets[0];
  if (previous != 0) {
    parser.set_error("filter value offsets must start at zero");
    return false;
  }
  for (size_t index = 0; index < static_cast<size_t>(total_value_count); ++index) {
    const uint32_t next = value_offsets[index + 1];
    if (next < previous || next > values_data_len) {
      parser.set_error("filter value offsets are invalid");
      return false;
    }
    previous = next;
  }
  if (previous != values_data_len) {
    parser.set_error("filter value offsets do not cover the values data");
    return false;
  }

  filters.clear();
  filters.reserve(static_cast<size_t>(filter_count));
  uint64_t leaf_filter_count = 0;
  uint64_t regex_filter_count = 0;
  size_t expression_stack_depth = 0;
  bool has_boolean_operators = false;
  for (size_t index = 0; index < static_cast<size_t>(filter_count); ++index) {
    const size_t descriptor_offset = index * 4;
    const uint32_t raw_kind = descriptors[descriptor_offset];
    const uint32_t column = descriptors[descriptor_offset + 1];
    const uint32_t first_value_index = descriptors[descriptor_offset + 2];
    const uint32_t value_count = descriptors[descriptor_offset + 3];

    if (raw_kind < static_cast<uint32_t>(row_filter_kind::equals) ||
        raw_kind > static_cast<uint32_t>(row_filter_kind::negate)) {
      parser.set_error("filter kind is invalid");
      return false;
    }

    const auto kind = static_cast<row_filter_kind>(raw_kind);
    if (is_boolean_operator(kind)) {
      // Boolean descriptors form a postfix program and store their arity in the column slot.
      has_boolean_operators = true;
      if (first_value_index != 0 || value_count != 0 || column == 0 ||
          (kind == row_filter_kind::negate && column != 1) || column > expression_stack_depth) {
        parser.set_error("filter Boolean operator is invalid");
        return false;
      }
      expression_stack_depth -= static_cast<size_t>(column) - 1;
      filters.push_back(row_filter{
          .enabled = true,
          .kind = kind,
          .column = column,
      });
      continue;
    }

    ++leaf_filter_count;
    if (leaf_filter_count > max_filter_count) {
      parser.set_error("filter count exceeds maximum of 2024");
      return false;
    }
    ++expression_stack_depth;
    if (!valid_column_index(parser, column)) {
      return false;
    }
    if (first_value_index > total_value_count || value_count > total_value_count - first_value_index) {
      parser.set_error("filter descriptor value range is invalid");
      return false;
    }
    if (kind != row_filter_kind::in && kind != row_filter_kind::noin && value_count != 1) {
      parser.set_error("equals, neq, starts-with, and regex filters require exactly one value");
      return false;
    }
    if (kind == row_filter_kind::regex) {
      ++regex_filter_count;
      if (regex_filter_count > max_regex_filter_count) {
        parser.set_error("regex filter count exceeds maximum of 32");
        return false;
      }
      const uint32_t pattern_start = value_offsets[first_value_index];
      const uint32_t pattern_end = value_offsets[first_value_index + 1];
      if (pattern_end - pattern_start > max_regex_pattern_size) {
        parser.set_error("regular expression exceeds 4096 UTF-8 bytes");
        return false;
      }
    }

    row_filter filter{
        .enabled = true,
        .kind = kind,
        .column = column,
    };
    if (kind == row_filter_kind::in || kind == row_filter_kind::noin) {
      filter.values_data = values_data;
      filter.value_offsets = value_offsets + first_value_index;
      filter.value_count = value_count;
    } else {
      const uint32_t start = value_offsets[first_value_index];
      const uint32_t end = value_offsets[first_value_index + 1];
      filter.value = values_data == nullptr ? nullptr : values_data + start;
      filter.value_len = end - start;
    }
    filters.push_back(filter);
  }
  if (has_boolean_operators && expression_stack_depth != 1) {
    parser.set_error("filter Boolean program must produce one result");
    return false;
  }
  return true;
}

} // namespace csv_native

CSV_EXPORT bool csv_parser_add_transform(void* parser, uint32_t column, uint32_t kind) {
  return parser && csv_native::checked_parser(parser)->add_transform(column, kind);
}

CSV_EXPORT bool csv_parser_add_transform_with_default(void* parser, uint32_t column, uint32_t kind,
                                                      const uint8_t* value, uint64_t value_len) {
  if (!parser || (!value && value_len))
    return false;
  using csv_native::transform_kind;
  if (kind != static_cast<uint32_t>(transform_kind::lookup) &&
      kind != static_cast<uint32_t>(transform_kind::date_ymd) &&
      kind != static_cast<uint32_t>(transform_kind::date_dmy) &&
      kind != static_cast<uint32_t>(transform_kind::date_dmy_slash))
    return false;
  const std::string_view fallback(value ? reinterpret_cast<const char*>(value) : "", value_len);
  return csv_native::checked_parser(parser)->add_transform(column, kind, fallback);
}

CSV_EXPORT bool csv_parser_add_map_with_default(void* parser, uint32_t column, const uint8_t* value,
                                                uint64_t value_len) {
  return csv_parser_add_transform_with_default(
      parser, column, static_cast<uint32_t>(csv_native::transform_kind::lookup), value, value_len);
}

CSV_EXPORT bool csv_parser_transform_pair(void* parser, uint32_t column, const uint8_t* key, uint64_t key_len,
                                          const uint8_t* value, uint64_t value_len) {
  if (!parser || (!key && key_len) || (!value && value_len))
    return false;
  return csv_native::checked_parser(parser)->add_transform_pair(
      column, {key ? reinterpret_cast<const char*>(key) : "", key_len},
      {value ? reinterpret_cast<const char*>(value) : "", value_len});
}

CSV_EXPORT void* csv_parser_transform_validated_batch(void* parser, const void* batch) {
  if (!parser || !batch)
    return nullptr;
  return csv_native::checked_parser(parser)->transform_validated_batch(
      *static_cast<const csv_native::csv_batch*>(batch));
}

CSV_EXPORT const char* csv_regex_validate(const uint8_t* pattern, uint64_t pattern_len) {
  static thread_local std::string error;
  error.clear();
  if (pattern_len > csv_native::max_regex_pattern_size ||
      pattern_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    error = "regular expression exceeds 4096 UTF-8 bytes";
    return error.c_str();
  }
  if (pattern == nullptr && pattern_len != 0) {
    error = "regular expression data is null";
    return error.c_str();
  }

  std::string source;
  if (pattern_len != 0) {
    source.assign(reinterpret_cast<const char*>(pattern), static_cast<size_t>(pattern_len));
  }
  csv_native::compile_regex(source, false, error);
  return error.c_str();
}

CSV_EXPORT void* csv_parser_create(int encoding, uint8_t delimiter) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }
  const auto selected = encoding == 1 ? csv_native::csv_encoding::latin1 : csv_native::csv_encoding::utf8;
  return new csv_native::csv_parser(selected, delimiter);
}

// Internal materialization entry point. Its batches contain Latin1 and must never escape as public UTF-8 batches.
CSV_EXPORT void* csv_parser_create_latin1_rows_with_fixed_columns(uint8_t delimiter, uint32_t fixed_columns) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }
  return new csv_native::csv_parser(csv_native::csv_encoding::utf8, delimiter, csv_native::batch_layout::latin1,
                                    fixed_columns);
}

CSV_EXPORT void* csv_parser_create_latin1_rows(uint8_t delimiter) {
  return csv_parser_create_latin1_rows_with_fixed_columns(delimiter, 0);
}

CSV_EXPORT void* csv_parser_create_latin1_quoted_rows(uint8_t delimiter, uint32_t fixed_columns) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }
  return new csv_native::csv_parser(csv_native::csv_encoding::utf8, delimiter,
                                    csv_native::batch_layout::latin1_quoted_spans, fixed_columns);
}

CSV_EXPORT void* csv_parser_create_latin1_rows_with_quoted_spans(uint8_t delimiter) {
  return csv_parser_create_latin1_quoted_rows(delimiter, 0);
}

// Internal materialization path. Ordinary batch callers need packed UTF-8 offsets.
CSV_EXPORT void csv_parser_enable_transformed_quoted_spans(void* parser) {
  if (parser != nullptr) {
    csv_native::checked_parser(parser)->enable_transformed_quoted_spans();
  }
}

CSV_EXPORT void csv_parser_destroy(void* parser) { delete csv_native::checked_parser(parser); }

CSV_EXPORT void csv_parser_set_row_selection(void* parser, uint64_t skip, uint64_t limit, bool capture_header) {
  if (parser != nullptr) {
    csv_native::checked_parser(parser)->set_row_selection(skip, limit, capture_header);
  }
}

CSV_EXPORT void* csv_parser_take_skipped_header(void* parser) {
  return parser == nullptr ? nullptr : csv_native::checked_parser(parser)->take_skipped_header();
}

CSV_EXPORT uint64_t csv_parser_skipped_rows(void* parser) {
  return parser == nullptr ? 0 : csv_native::checked_parser(parser)->skipped_rows();
}

CSV_EXPORT void* csv_parser_create_prepared(int encoding, uint8_t delimiter, uint32_t fixed_columns) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }
  const auto selected = encoding == 1 ? csv_native::csv_encoding::latin1 : csv_native::csv_encoding::utf8;
  return new csv_native::csv_parser(selected, delimiter, csv_native::batch_layout::utf8, fixed_columns);
}

// The parser owns the projection and predicate buffers after preparation.
CSV_EXPORT bool csv_parser_prepare(void* parser, bool has_projection, const uint32_t* selected_columns,
                                   uint64_t selected_columns_len, const uint32_t* filter_descriptors,
                                   uint64_t filter_count, const uint8_t* values_data, uint64_t values_data_len,
                                   const uint32_t* value_offsets, uint64_t total_value_count) {
  if (parser == nullptr) {
    return false;
  }
  auto* typed = csv_native::checked_parser(parser);
  if (has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) {
    return false;
  }
  std::vector<csv_native::row_filter> filters;
  if (!csv_native::build_row_filters(*typed, filter_descriptors, filter_count, values_data, values_data_len,
                                     value_offsets, total_value_count, filters)) {
    return false;
  }
  return typed->prepare_configuration(has_projection ? selected_columns : nullptr,
                                      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
                                      std::move(filters), values_data, static_cast<size_t>(values_data_len),
                                      value_offsets, static_cast<size_t>(total_value_count));
}

CSV_EXPORT void* csv_parser_write_prepared_batch(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr) {
    return nullptr;
  }
  auto* typed = csv_native::checked_parser(parser);
  if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) || (data == nullptr && len != 0)) {
    typed->set_error("prepared parser input is invalid");
    return nullptr;
  }
  return typed->write_prepared_batch(data, static_cast<size_t>(len), final);
}

CSV_EXPORT uint64_t csv_parser_write_prepared_count(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr) {
    return csv_native::prepared_count_error;
  }
  auto* typed = csv_native::checked_parser(parser);
  if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) || (data == nullptr && len != 0)) {
    typed->set_error("prepared parser input is invalid");
    return csv_native::prepared_count_error;
  }
  return typed->write_prepared_count(data, static_cast<size_t>(len), final);
}

CSV_EXPORT void csv_parser_reset(void* parser) {
  if (parser == nullptr) {
    return;
  }
  csv_native::checked_parser(parser)->reset();
}

CSV_EXPORT void csv_parser_reset_stream(void* parser) {
  if (parser != nullptr) {
    csv_native::checked_parser(parser)->reset_stream();
  }
}

CSV_EXPORT void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_batch(data, static_cast<size_t>(len), final);
}

CSV_EXPORT void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_batch(data, static_cast<size_t>(len), final);
}

CSV_EXPORT void* csv_parser_finish_batch(void* parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_batch();
}

CSV_EXPORT void* csv_parser_finish_strict_batch(void* parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_batch();
}

CSV_EXPORT void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                              uint32_t fixed_columns) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_fixed_batch(data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void* csv_parser_write_strict_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                     uint32_t fixed_columns) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_fixed_batch(data, static_cast<size_t>(len), final,
                                                                      fixed_columns);
}

CSV_EXPORT void* csv_parser_finish_fixed_batch(void* parser, uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_fixed_batch(fixed_columns);
}

CSV_EXPORT void* csv_parser_finish_strict_fixed_batch(void* parser, uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_fixed_batch(fixed_columns);
}

CSV_EXPORT void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                  bool has_projection, const uint32_t* selected_columns,
                                                  uint64_t selected_columns_len, bool has_filter,
                                                  uint32_t filter_column, const uint8_t* filter_value,
                                                  uint64_t filter_value_len) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return nullptr;
  }

  auto* typed = csv_native::checked_parser(parser);
  if ((has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) ||
      (has_filter && !csv_native::valid_column_index(*typed, filter_column))) {
    return nullptr;
  }

  return typed->write_projected_batch(
      data, static_cast<size_t>(len), final, has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::row_filter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::row_filter_kind::equals : csv_native::row_filter_kind::none,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT void* csv_parser_finish_projected_batch(void* parser, bool has_projection, const uint32_t* selected_columns,
                                                   uint64_t selected_columns_len, bool has_filter,
                                                   uint32_t filter_column, const uint8_t* filter_value,
                                                   uint64_t filter_value_len) {
  if (parser == nullptr || filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return nullptr;
  }

  auto* typed = csv_native::checked_parser(parser);
  if ((has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) ||
      (has_filter && !csv_native::valid_column_index(*typed, filter_column))) {
    return nullptr;
  }

  return typed->finish_projected_batch(
      has_projection ? selected_columns : nullptr, has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::row_filter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::row_filter_kind::equals : csv_native::row_filter_kind::none,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT void* csv_parser_write_projected_batch_where_all(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                            bool has_projection, const uint32_t* selected_columns,
                                                            uint64_t selected_columns_len,
                                                            const uint32_t* filter_descriptors, uint64_t filter_count,
                                                            const uint8_t* values_data, uint64_t values_data_len,
                                                            const uint32_t* value_offsets, uint64_t total_value_count) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) {
    return nullptr;
  }

  std::vector<csv_native::row_filter> filters;
  if (!csv_native::build_row_filters(*typed, filter_descriptors, filter_count, values_data, values_data_len,
                                     value_offsets, total_value_count, filters)) {
    return nullptr;
  }

  return typed->write_projected_batch_where_all(
      data, static_cast<size_t>(len), final, has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0, filters.data(), filters.size());
}

CSV_EXPORT void*
csv_parser_finish_projected_batch_where_all(void* parser, bool has_projection, const uint32_t* selected_columns,
                                            uint64_t selected_columns_len, const uint32_t* filter_descriptors,
                                            uint64_t filter_count, const uint8_t* values_data, uint64_t values_data_len,
                                            const uint32_t* value_offsets, uint64_t total_value_count) {
  if (parser == nullptr) {
    return nullptr;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) {
    return nullptr;
  }

  std::vector<csv_native::row_filter> filters;
  if (!csv_native::build_row_filters(*typed, filter_descriptors, filter_count, values_data, values_data_len,
                                     value_offsets, total_value_count, filters)) {
    return nullptr;
  }

  return typed->finish_projected_batch_where_all(has_projection ? selected_columns : nullptr,
                                                 has_projection ? static_cast<size_t>(selected_columns_len) : 0,
                                                 filters.data(), filters.size());
}

CSV_EXPORT void csv_batch_destroy(void* batch) { delete static_cast<csv_native::csv_batch*>(batch); }

CSV_EXPORT uint64_t csv_batch_row_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto* typed = static_cast<const csv_native::csv_batch*>(batch);
  return typed->row_offsets.empty() ? 0 : typed->row_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_total_fields(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto* typed = static_cast<const csv_native::csv_batch*>(batch);
  return typed->field_offsets.empty() ? 0 : typed->field_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_data_len(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return static_cast<const csv_native::csv_batch*>(batch)->data.size();
}

CSV_EXPORT const uint8_t* csv_batch_data_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto* typed = static_cast<const csv_native::csv_batch*>(batch);
  return reinterpret_cast<const uint8_t*>(typed->data.data());
}

CSV_EXPORT const uint64_t* csv_batch_row_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::csv_batch*>(batch)->row_offsets.data();
}

CSV_EXPORT const uint64_t* csv_batch_field_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::csv_batch*>(batch)->field_offsets.data();
}

// Null for an all-decoded batch. Otherwise there is one 0/1 flag per output row.
CSV_EXPORT const uint8_t* csv_batch_quoted_rows_ptr(void* batch) {
  const auto* typed = csv_native::checked_batch(batch);
  return typed == nullptr || typed->quoted_rows.empty() ? nullptr : typed->quoted_rows.data();
}

CSV_EXPORT uint64_t csv_batch_count_where_equals(void* batch, uint32_t column, const uint8_t* value,
                                                 uint64_t value_len) {
  if (batch == nullptr || (value == nullptr && value_len != 0) ||
      value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }
  if (column > csv_native::max_column_index) {
    return 0;
  }

  const auto* typed = csv_native::checked_batch(batch);
  const auto needle_len = static_cast<size_t>(value_len);
  uint64_t count = 0;

  for (size_t row = 0; row + 1 < typed->row_offsets.size(); ++row) {
    const size_t row_begin = typed->row_offsets[row];
    const size_t row_end = typed->row_offsets[row + 1];
    const size_t field_index = row_begin + column;
    if (field_index >= row_end) {
      continue;
    }

    const size_t start = typed->field_offsets[field_index];
    const size_t end = typed->field_offsets[field_index + 1];
    const size_t len = end - start;
    if (len == needle_len && (len == 0 || std::memcmp(typed->data.data() + start, value, len) == 0)) {
      ++count;
    }
  }

  return count;
}

CSV_EXPORT uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_count(data, static_cast<size_t>(len), final);
}

CSV_EXPORT uint64_t csv_parser_count_trusted_newlines(const uint8_t* data, uint64_t len) {
  if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::count_trusted_newlines(data, static_cast<size_t>(len));
}

CSV_EXPORT void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter) {
  if (shard_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }
  auto batch = csv_native::find_csv_safe_split_offsets(path, static_cast<size_t>(shard_count), delimiter);
  return batch.release();
}

CSV_EXPORT void csv_split_offsets_batch_destroy(void* batch) { delete csv_native::checked_split_offsets_batch(batch); }

CSV_EXPORT uint64_t csv_split_offsets_batch_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_split_offsets_batch(batch)->offsets.size();
}

CSV_EXPORT const uint64_t* csv_split_offsets_batch_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_split_offsets_batch(batch)->offsets.data();
}

CSV_EXPORT uint64_t csv_parser_finish_count(void* parser) {
  if (parser == nullptr) {
    return 0;
  }

  return csv_native::checked_parser(parser)->finish_count();
}

CSV_EXPORT uint64_t csv_parser_write_count_where_all(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                     const uint32_t* filter_descriptors, uint64_t filter_count,
                                                     const uint8_t* values_data, uint64_t values_data_len,
                                                     const uint32_t* value_offsets, uint64_t total_value_count) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  std::vector<csv_native::row_filter> filters;
  if (!csv_native::build_row_filters(*typed, filter_descriptors, filter_count, values_data, values_data_len,
                                     value_offsets, total_value_count, filters)) {
    return 0;
  }

  return typed->write_count_where_all(data, static_cast<size_t>(len), final, filters.data(), filters.size());
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_all(void* parser, const uint32_t* filter_descriptors,
                                                      uint64_t filter_count, const uint8_t* values_data,
                                                      uint64_t values_data_len, const uint32_t* value_offsets,
                                                      uint64_t total_value_count) {
  if (parser == nullptr) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  std::vector<csv_native::row_filter> filters;
  if (!csv_native::build_row_filters(*typed, filter_descriptors, filter_count, values_data, values_data_len,
                                     value_offsets, total_value_count, filters)) {
    return 0;
  }

  return typed->finish_count_where_all(filters.data(), filters.size());
}

CSV_EXPORT uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                        uint32_t filter_column, const uint8_t* filter_value,
                                                        uint64_t filter_value_len) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->write_count_where_equals(data, static_cast<size_t>(len), final,
                                         csv_native::row_filter{
                                             .enabled = true,
                                             .kind = csv_native::row_filter_kind::equals,
                                             .column = filter_column,
                                             .value = filter_value,
                                             .value_len = static_cast<size_t>(filter_value_len),
                                         });
}

CSV_EXPORT uint64_t csv_parser_write_count_where_in(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                    uint32_t filter_column, const uint8_t* values_data,
                                                    uint64_t values_data_len, const uint32_t* value_offsets,
                                                    uint64_t value_count) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      values_data_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (values_data == nullptr && values_data_len != 0) ||
      !csv_native::valid_value_offsets(value_offsets, static_cast<size_t>(value_count), values_data_len)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->write_count_where_in(data, static_cast<size_t>(len), final,
                                     csv_native::row_filter{
                                         .enabled = true,
                                         .kind = csv_native::row_filter_kind::in,
                                         .column = filter_column,
                                         .values_data = values_data,
                                         .value_offsets = value_offsets,
                                         .value_count = static_cast<size_t>(value_count),
                                     });
}

CSV_EXPORT uint64_t csv_parser_write_count_where_starts_with(void* parser, const uint8_t* data, uint64_t len,
                                                             bool final, uint32_t filter_column,
                                                             const uint8_t* filter_value, uint64_t filter_value_len) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->write_count_where_starts_with(data, static_cast<size_t>(len), final,
                                              csv_native::row_filter{
                                                  .enabled = true,
                                                  .kind = csv_native::row_filter_kind::starts_with,
                                                  .column = filter_column,
                                                  .value = filter_value,
                                                  .value_len = static_cast<size_t>(filter_value_len),
                                              });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_equals(void* parser, uint32_t filter_column,
                                                         const uint8_t* filter_value, uint64_t filter_value_len) {
  if (parser == nullptr || filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->finish_count_where_equals(csv_native::row_filter{
      .enabled = true,
      .kind = csv_native::row_filter_kind::equals,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
  });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_in(void* parser, uint32_t filter_column, const uint8_t* values_data,
                                                     uint64_t values_data_len, const uint32_t* value_offsets,
                                                     uint64_t value_count) {
  if (parser == nullptr || values_data_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (values_data == nullptr && values_data_len != 0) ||
      !csv_native::valid_value_offsets(value_offsets, static_cast<size_t>(value_count), values_data_len)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->finish_count_where_in(csv_native::row_filter{
      .enabled = true,
      .kind = csv_native::row_filter_kind::in,
      .column = filter_column,
      .values_data = values_data,
      .value_offsets = value_offsets,
      .value_count = static_cast<size_t>(value_count),
  });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_starts_with(void* parser, uint32_t filter_column,
                                                              const uint8_t* filter_value, uint64_t filter_value_len) {
  if (parser == nullptr || filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->finish_count_where_starts_with(csv_native::row_filter{
      .enabled = true,
      .kind = csv_native::row_filter_kind::starts_with,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
  });
}

CSV_EXPORT const char* csv_parser_last_error(void* parser) {
  if (parser == nullptr) {
    return "parser is null";
  }
  return csv_native::checked_parser(parser)->last_error();
}
