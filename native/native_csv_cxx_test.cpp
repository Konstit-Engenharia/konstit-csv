#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <limits>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

extern "C" {
int csv_runtime_supports_avx2();
void* csv_parser_create(int encoding, uint8_t delimiter);
void* csv_parser_create_latin1_rows(uint8_t delimiter);
void csv_parser_destroy(void* parser);
void csv_parser_reset(void* parser);
bool csv_parser_prepare(void* parser, bool has_projection, const uint32_t* selected_columns,
                        uint64_t selected_columns_len, const uint32_t* filter_descriptors, uint64_t filter_count,
                        const uint8_t* values_data, uint64_t values_data_len, const uint32_t* value_offsets,
                        uint64_t total_value_count);
void* csv_parser_write_prepared_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
uint64_t csv_parser_write_prepared_count(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_finish_batch(void* parser);
void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_finish_strict_batch(void* parser);
void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final, uint32_t fixed_columns);
void* csv_parser_finish_fixed_batch(void* parser, uint32_t fixed_columns);
void* csv_parser_write_strict_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                          uint32_t columns);
void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final, bool has_projection,
                                       const uint32_t* selected_columns, uint64_t selected_columns_len, bool has_filter,
                                       uint32_t filter_column, const uint8_t* filter_value, uint64_t filter_value_len);
void* csv_parser_write_projected_batch_where_all(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                 bool has_projection, const uint32_t* selected_columns,
                                                 uint64_t selected_columns_len, const uint32_t* filter_descriptors,
                                                 uint64_t filter_count, const uint8_t* values_data,
                                                 uint64_t values_data_len, const uint32_t* value_offsets,
                                                 uint64_t total_value_count);
void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter);
uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
uint64_t csv_parser_finish_count(void* parser);
uint64_t csv_parser_write_count_where_all(void* parser, const uint8_t* data, uint64_t len, bool final,
                                          const uint32_t* filter_descriptors, uint64_t filter_count,
                                          const uint8_t* values_data, uint64_t values_data_len,
                                          const uint32_t* value_offsets, uint64_t total_value_count);
uint64_t csv_parser_finish_count_where_all(void* parser, const uint32_t* filter_descriptors, uint64_t filter_count,
                                           const uint8_t* values_data, uint64_t values_data_len,
                                           const uint32_t* value_offsets, uint64_t total_value_count);
const char* csv_regex_validate(const uint8_t* pattern, uint64_t pattern_len);
uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
                                             uint32_t filter_column, const uint8_t* filter_value,
                                             uint64_t filter_value_len);
const char* csv_parser_last_error(void* parser);
void csv_batch_destroy(void* batch);
void csv_split_offsets_batch_destroy(void* batch);
uint64_t csv_batch_row_count(void* batch);
uint64_t csv_batch_total_fields(void* batch);
uint64_t csv_batch_data_len(void* batch);
const uint8_t* csv_batch_data_ptr(void* batch);
const uint64_t* csv_batch_row_offsets_ptr(void* batch);
const uint64_t* csv_batch_field_offsets_ptr(void* batch);
uint64_t csv_split_offsets_batch_count(void* batch);
const uint64_t* csv_split_offsets_batch_ptr(void* batch);
}

static_assert(std::is_same_v<decltype(csv_batch_row_offsets_ptr(nullptr)), const uint64_t*>);
static_assert(std::is_same_v<decltype(csv_batch_field_offsets_ptr(nullptr)), const uint64_t*>);

namespace {

uint32_t next_random(uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

void write_count_chunk(void* parser, std::string_view chunk, uint64_t& rows) {
  rows += csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(chunk.data()), chunk.size(), false);
}

uint64_t count_rows_in_chunks(std::string_view input, size_t chunk_size) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);

  uint64_t rows = 0;
  for (size_t offset = 0; offset < input.size(); offset += chunk_size) {
    write_count_chunk(parser, input.substr(offset, std::min(chunk_size, input.size() - offset)), rows);
  }
  rows += csv_parser_finish_count(parser);
  csv_parser_destroy(parser);
  return rows;
}

std::string decode_latin1_reference(const uint8_t* data, size_t len) {
  std::string decoded;
  decoded.reserve(len * 2);
  for (size_t index = 0; index < len; ++index) {
    const uint8_t byte = data[index];
    if (byte < 0x80) {
      decoded.push_back(static_cast<char>(byte));
    } else {
      decoded.push_back(static_cast<char>(0xC0 | (byte >> 6)));
      decoded.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
    }
  }
  return decoded;
}

std::string make_fuzz_bytes(uint32_t seed) {
  static constexpr uint8_t alphabet[] = {
      'a', 'b', 'c', '0', '1', ',', ';', '"', '\n', '\r', ' ', 0x80, 0xE1,
  };
  uint32_t state = seed;
  const size_t len = 1 + (next_random(state) % 256);
  std::string bytes;
  bytes.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    bytes.push_back(static_cast<char>(alphabet[next_random(state) % std::size(alphabet)]));
  }
  return bytes;
}

void destroy_batch_if_present(void* batch) {
  if (batch != nullptr) {
    csv_batch_destroy(batch);
  }
}

void* write_batch_mode(void* parser, bool strict, const uint8_t* data, size_t len, bool final) {
  return strict ? csv_parser_write_strict_batch(parser, data, len, final)
                : csv_parser_write_batch(parser, data, len, final);
}

void require_two_field_batch(void* batch, std::string_view first, std::string_view second) {
  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 1);
  REQUIRE(csv_batch_total_fields(batch) == 2);

  std::string expected(first);
  expected.append(second);
  REQUIRE(csv_batch_data_len(batch) == expected.size());
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(batch)), expected.size()) == expected);

  const uint64_t* row_offsets = csv_batch_row_offsets_ptr(batch);
  const uint64_t* field_offsets = csv_batch_field_offsets_ptr(batch);
  REQUIRE(row_offsets != nullptr);
  REQUIRE(field_offsets != nullptr);
  REQUIRE(row_offsets[0] == 0);
  REQUIRE(row_offsets[1] == 2);
  REQUIRE(field_offsets[0] == 0);
  REQUIRE(field_offsets[1] == first.size());
  REQUIRE(field_offsets[2] == expected.size());
}

void append_batch_rows(void* batch, std::vector<std::vector<std::string>>& rows) {
  REQUIRE(batch != nullptr);
  const uint64_t* row_offsets = csv_batch_row_offsets_ptr(batch);
  const uint64_t* field_offsets = csv_batch_field_offsets_ptr(batch);
  const uint8_t* data = csv_batch_data_ptr(batch);
  REQUIRE(row_offsets[0] == 0);
  REQUIRE(field_offsets[0] == 0);
  for (uint64_t row = 0; row < csv_batch_row_count(batch); ++row) {
    auto& fields = rows.emplace_back();
    REQUIRE(row_offsets[row] <= row_offsets[row + 1]);
    REQUIRE(row_offsets[row + 1] <= csv_batch_total_fields(batch));
    for (uint64_t field = row_offsets[row]; field < row_offsets[row + 1]; ++field) {
      const uint64_t start = field_offsets[field];
      const uint64_t end = field_offsets[field + 1];
      REQUIRE(start <= end);
      REQUIRE(end <= csv_batch_data_len(batch));
      fields.emplace_back(reinterpret_cast<const char*>(data + start), end - start);
    }
  }
  REQUIRE(row_offsets[csv_batch_row_count(batch)] == csv_batch_total_fields(batch));
  REQUIRE(field_offsets[csv_batch_total_fields(batch)] == csv_batch_data_len(batch));
  csv_batch_destroy(batch);
}

void fuzz_batch_mode(std::string_view input, bool strict) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);

  const size_t split = input.size() / 2;
  void* first =
      strict ? csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false)
             : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false);
  destroy_batch_if_present(first);
  if (first == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* second = strict ? csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + split),
                                                        input.size() - split, false)
                        : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + split),
                                                 input.size() - split, false);
  destroy_batch_if_present(second);
  if (second == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* end = strict ? csv_parser_finish_strict_batch(parser) : csv_parser_finish_batch(parser);
  destroy_batch_if_present(end);
  csv_parser_destroy(parser);
}

void fuzz_fixed_mode(std::string_view input) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch =
      csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, 3);
  destroy_batch_if_present(batch);
  csv_parser_destroy(parser);
}

void fuzz_count_mode(std::string_view input) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  const size_t split = input.size() / 3;
  uint64_t rows = csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false);
  rows += csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(input.data() + split), input.size() - split,
                                 false);
  rows += csv_parser_finish_count(parser);
  csv_parser_destroy(parser);

  parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true);
  csv_parser_destroy(parser);
  REQUIRE(batch != nullptr);
  REQUIRE(rows == csv_batch_row_count(batch));
  csv_batch_destroy(batch);
}

} // namespace

TEST_CASE("native C ABI reports AVX2 support") {
#if defined(__x86_64__)
  REQUIRE(csv_runtime_supports_avx2() == 1);
#else
  REQUIRE(csv_runtime_supports_avx2() == 0);
#endif
}

TEST_CASE("native C ABI counts chunked quoted rows") {
  void* parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);

  uint64_t rows = 0;
  write_count_chunk(parser, "\"id\";\"uf\"\n\"1\";\"SP\"\n\"2\";\"", rows);
  write_count_chunk(parser, "RJ\"\n\"3\";\"S\nP\"", rows);
  rows += csv_parser_finish_count(parser);

  csv_parser_destroy(parser);

  REQUIRE(rows == 4);
}

TEST_CASE("native C ABI count preserves plain row state across SIMD and chunk boundaries") {
  std::string input(15, 'a');
  input += "\n\n";
  input.append(14, 'b');
  input += '\n';
  input.append(31, 'c');
  input += "\n\n";
  input.append(32, 'd');
  input += ",tail";

  for (const size_t chunk_size : {input.size(), size_t{15}, size_t{16}, size_t{17}, size_t{31}, size_t{32}, size_t{33},
                                  size_t{63}, size_t{64}, size_t{65}}) {
    REQUIRE(count_rows_in_chunks(input, chunk_size) == 6);
  }
}

TEST_CASE("native C ABI count falls back for quote and CR state carried across chunks") {
  SECTION("pending closing quote") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);

    uint64_t rows = 0;
    write_count_chunk(parser, "\"quoted\nvalue\"", rows);
    write_count_chunk(parser, "\nplain\n\nnext", rows);
    rows += csv_parser_finish_count(parser);
    csv_parser_destroy(parser);

    REQUIRE(rows == 4);
  }

  SECTION("CRLF pair") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);

    uint64_t rows = 0;
    write_count_chunk(parser, "first\r", rows);
    write_count_chunk(parser, "\nsecond\n\nthird", rows);
    rows += csv_parser_finish_count(parser);
    csv_parser_destroy(parser);

    REQUIRE(rows == 4);
  }

  SECTION("escaped and unquoted quotes") {
    const std::string input = "unquoted\"quote\n\"escaped \"\" quote\ninside\",tail\nlast";
    for (const size_t chunk_size :
         {size_t{1}, size_t{15}, size_t{16}, size_t{17}, size_t{31}, size_t{32}, size_t{33}}) {
      REQUIRE(count_rows_in_chunks(input, chunk_size) == 3);
    }
  }
}

TEST_CASE("native C ABI finds csv-safe split offsets") {
  const std::string path = "/tmp/csv-native-split-offsets.csv";
  {
    std::FILE* file = std::fopen(path.c_str(), "wb");
    REQUIRE(file != nullptr);
    static constexpr char content[] = "id;name;notes\n"
                                      "1;ana;\"um;dois\"\n"
                                      "2;bob;\"linha\ninterna\"\n"
                                      "3;cai;ok\n"
                                      "4;dio;fim\n";
    const size_t written = std::fwrite(content, 1, sizeof(content) - 1, file);
    REQUIRE(written == sizeof(content) - 1);
    REQUIRE(std::fclose(file) == 0);
  }

  void* batch = csv_parser_find_split_offsets(path.c_str(), 3, ';');
  REQUIRE(batch != nullptr);

  const uint64_t count = csv_split_offsets_batch_count(batch);
  REQUIRE(count >= 2);
  const uint64_t* offsets = csv_split_offsets_batch_ptr(batch);
  REQUIRE(offsets != nullptr);
  REQUIRE(offsets[0] == 0);

  std::string bytes;
  {
    std::FILE* file = std::fopen(path.c_str(), "rb");
    REQUIRE(file != nullptr);
    REQUIRE(std::fseek(file, 0, SEEK_END) == 0);
    const int64_t end = std::ftell(file);
    REQUIRE(end >= 0);
    REQUIRE(std::fseek(file, 0, SEEK_SET) == 0);
    bytes.resize(static_cast<size_t>(end));
    const size_t read = std::fread(bytes.data(), 1, bytes.size(), file);
    REQUIRE(read == bytes.size());
    REQUIRE(std::fclose(file) == 0);
  }

  for (uint64_t index = 1; index < count; ++index) {
    REQUIRE(offsets[index] >= offsets[index - 1]);
    if (offsets[index] == static_cast<uint64_t>(bytes.size())) {
      continue;
    }
    REQUIRE(offsets[index] < bytes.size());
    REQUIRE(bytes[static_cast<size_t>(offsets[index] - 1)] == '\n');
  }

  REQUIRE(offsets[count - 1] == bytes.size());
  csv_split_offsets_batch_destroy(batch);
  REQUIRE(std::remove(path.c_str()) == 0);
}

TEST_CASE("native C ABI decodes latin1 batches to utf8") {
  const uint8_t input[] = {
      'n', 'a', 'm', 'e', '\n', 'J', 'o', 0xE3, 'o', '\n',
  };

  void* parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, input, sizeof(input), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 2);
  REQUIRE(csv_batch_total_fields(batch) == 2);

  const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  REQUIRE(std::string(data, len).find("Jo\xC3\xA3o") != std::string::npos);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI decodes full latin1 high range to utf8") {
  std::vector<uint8_t> input;
  std::string expected;
  for (uint16_t value = 0x80; value <= 0xFF; ++value) {
    const auto byte = static_cast<uint8_t>(value);
    input.push_back(byte);
    expected.push_back(static_cast<char>(0xC0 | (byte >> 6)));
    expected.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
  }
  input.push_back('\n');

  void* parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, input.data(), input.size(), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 1);
  REQUIRE(csv_batch_total_fields(batch) == 1);

  const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  REQUIRE(std::string(data, len) == expected);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI decodes latin1 SIMD tails and mixed runs") {
  for (const size_t len : {15, 16, 17, 31, 32, 33, 63, 64, 65}) {
    std::vector<uint8_t> input(len, 0xE1);
    const std::string expected = decode_latin1_reference(input.data(), input.size());
    input.push_back('\n');

    void* parser = csv_parser_create(1, ',');
    REQUIRE(parser != nullptr);
    void* batch = csv_parser_write_batch(parser, input.data(), input.size(), true);
    csv_parser_destroy(parser);

    REQUIRE(batch != nullptr);
    REQUIRE(csv_batch_row_count(batch) == 1);
    const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
    const auto data_len = static_cast<size_t>(csv_batch_data_len(batch));
    REQUIRE(std::string(data, data_len) == expected);
    csv_batch_destroy(batch);
  }

  std::vector<uint8_t> mixed;
  mixed.insert(mixed.end(), 15, 'A');
  mixed.insert(mixed.end(), 16, 0x80);
  mixed.push_back('B');
  mixed.insert(mixed.end(), 17, 0xFF);
  mixed.insert(mixed.end(), 31, 'C');
  mixed.push_back(0x81);
  const std::string expected = decode_latin1_reference(mixed.data(), mixed.size());

  for (const size_t chunk_size : {1, 15, 16, 17, 31, 32, 33}) {
    void* parser = csv_parser_create(1, ',');
    REQUIRE(parser != nullptr);
    for (size_t offset = 0; offset < mixed.size(); offset += chunk_size) {
      const size_t len = std::min(chunk_size, mixed.size() - offset);
      void* partial = csv_parser_write_batch(parser, mixed.data() + offset, len, false);
      REQUIRE(partial != nullptr);
      REQUIRE(csv_batch_row_count(partial) == 0);
      csv_batch_destroy(partial);
    }

    static constexpr uint8_t newline = '\n';
    void* batch = csv_parser_write_batch(parser, &newline, 1, true);
    csv_parser_destroy(parser);
    REQUIRE(batch != nullptr);
    REQUIRE(csv_batch_row_count(batch) == 1);
    const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
    const auto data_len = static_cast<size_t>(csv_batch_data_len(batch));
    REQUIRE(std::string(data, data_len) == expected);
    csv_batch_destroy(batch);
  }
}

TEST_CASE("native C ABI batch parses dense escaped quotes before close") {
  std::string escaped_quotes;
  for (int i = 0; i < 96; ++i) {
    escaped_quotes += "\"\"";
  }

  const std::string input =
      "\"id\";\"payload\";\"tail\"\r\n\"1\";\"" + escaped_quotes + "end\";\"after\"\r\n\"2\";\"plain\";\"last\"\n";

  void* parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 3);
  REQUIRE(csv_batch_total_fields(batch) == 9);

  const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  const std::string values(data, len);
  REQUIRE(values.find(std::string(96, '"') + "end") != std::string::npos);
  REQUIRE(values.find("after") != std::string::npos);
  REQUIRE(values.find("last") != std::string::npos);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI fixed batch allows quoted newlines") {
  const std::string first = "\"1\";\"Ana\nA\";\"S";
  const std::string second = "P\"\n\"2\";\"Joao\";\"RJ\"\n";

  void* parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);
  void* first_batch =
      csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(first.data()), first.size(), false, 3);
  REQUIRE(first_batch != nullptr);
  REQUIRE(csv_batch_row_count(first_batch) == 0);
  csv_batch_destroy(first_batch);

  void* second_batch =
      csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(second.data()), second.size(), false, 3);
  REQUIRE(second_batch != nullptr);
  REQUIRE(csv_batch_row_count(second_batch) == 2);
  REQUIRE(csv_batch_total_fields(second_batch) == 6);

  void* end_batch = csv_parser_finish_fixed_batch(parser, 3);
  csv_parser_destroy(parser);
  REQUIRE(end_batch != nullptr);
  REQUIRE(csv_batch_row_count(end_batch) == 0);

  csv_batch_destroy(second_batch);
  csv_batch_destroy(end_batch);
}

TEST_CASE("native C ABI exposes 64-bit batch offsets") {
  const std::string input = "a,b\n";
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  const uint64_t* row_offsets = csv_batch_row_offsets_ptr(batch);
  const uint64_t* field_offsets = csv_batch_field_offsets_ptr(batch);
  REQUIRE(row_offsets != nullptr);
  REQUIRE(field_offsets != nullptr);
  REQUIRE(row_offsets[0] == 0);
  REQUIRE(row_offsets[1] == 2);
  REQUIRE(field_offsets[0] == 0);
  REQUIRE(field_offsets[1] == 1);
  REQUIRE(field_offsets[2] == 2);
  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI Latin-1 batch kernel preserves chunked rows and UTF-8 parity") {
  const std::string first_chunk = "\"a\"";
  std::string second_chunk = "\"b\";x";
  second_chunk.push_back(static_cast<char>(0xE3));
  second_chunk.push_back('\r');
  const std::string final_chunk = "\n\"done\"\"now\";last";

  for (const int encoding : {0, 1}) {
    for (const bool strict : {false, true}) {
      void* parser = csv_parser_create(encoding, ';');
      REQUIRE(parser != nullptr);

      void* first = write_batch_mode(parser, strict, reinterpret_cast<const uint8_t*>(first_chunk.data()),
                                     first_chunk.size(), false);
      REQUIRE(first != nullptr);
      REQUIRE(csv_batch_row_count(first) == 0);
      REQUIRE(csv_batch_total_fields(first) == 0);
      REQUIRE(csv_batch_data_len(first) == 0);
      csv_batch_destroy(first);

      void* second = write_batch_mode(parser, strict, reinterpret_cast<const uint8_t*>(second_chunk.data()),
                                      second_chunk.size(), false);
      const std::string encoded_value = encoding == 0 ? std::string({'x', static_cast<char>(0xE3)}) : "x\xC3\xA3";
      require_two_field_batch(second, "a\"b", encoded_value);
      csv_batch_destroy(second);

      void* final = write_batch_mode(parser, strict, reinterpret_cast<const uint8_t*>(final_chunk.data()),
                                     final_chunk.size(), true);
      require_two_field_batch(final, "done\"now", "last");
      csv_batch_destroy(final);
      csv_parser_destroy(parser);
    }
  }
}

TEST_CASE("native C ABI Latin-1 strict batch kernel rejects malformed quotes") {
  const std::string unescaped = "bad\"quote,ok\n";
  const std::string unterminated = "a,\"open";

  void* parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* invalid =
      csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(unescaped.data()), unescaped.size(), true);
  REQUIRE(invalid == nullptr);
  REQUIRE(std::string(csv_parser_last_error(parser)) ==
          "strict CSV quote syntax error: unescaped quote in unquoted field");
  csv_parser_destroy(parser);

  parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  invalid = csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(unterminated.data()),
                                          unterminated.size(), true);
  REQUIRE(invalid == nullptr);
  REQUIRE(std::string(csv_parser_last_error(parser)) == "strict CSV quote syntax error: unterminated quoted field");
  csv_parser_destroy(parser);

  parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* permissive =
      csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(unescaped.data()), unescaped.size(), true);
  require_two_field_batch(permissive, "bad\"quote", "ok");
  csv_batch_destroy(permissive);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI Latin-1 strict batch kernel preserves column validation across writes") {
  const std::string first_row = "a,b\n";
  const std::string mismatched_row = "c\n";

  void* parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* first = csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(first_row.data()),
                                              first_row.size(), false);
  require_two_field_batch(first, "a", "b");
  csv_batch_destroy(first);

  void* mismatch = csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(mismatched_row.data()),
                                                 mismatched_row.size(), true);
  REQUIRE(mismatch == nullptr);
  REQUIRE(std::string(csv_parser_last_error(parser)) == "strict CSV row column count mismatch");
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI validates projection limits before allocation") {
  SECTION("maximum projection length and column index are accepted") {
    std::vector<uint32_t> selected_columns(2024);
    for (uint32_t index = 0; index < selected_columns.size(); ++index) {
      selected_columns[index] = index;
    }
    selected_columns.back() = 2024;

    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    void* batch = csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns.data(),
                                                   selected_columns.size(), false, 0, nullptr, 0);
    REQUIRE(batch != nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
    csv_batch_destroy(batch);
    csv_parser_destroy(parser);
  }

  SECTION("projection length above maximum is rejected") {
    std::vector<uint32_t> selected_columns(2025);
    for (uint32_t index = 0; index < selected_columns.size(); ++index) {
      selected_columns[index] = index;
    }

    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns.data(),
                                             selected_columns.size(), false, 0, nullptr, 0) == nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("length") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("duplicate projected columns are rejected") {
    const uint32_t selected_columns[] = {2, 2};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns,
                                             std::size(selected_columns), false, 0, nullptr, 0) == nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("duplicates") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("column index above maximum is rejected") {
    const uint32_t selected_columns[] = {2025};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns,
                                             std::size(selected_columns), false, 0, nullptr, 0) == nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("2024") != std::string_view::npos);
    csv_parser_destroy(parser);
  }
}

TEST_CASE("native C ABI validates filter column indexes") {
  SECTION("maximum filter column index is accepted") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_equals(parser, nullptr, 0, true, 2024, nullptr, 0) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
    csv_parser_destroy(parser);
  }

  SECTION("filter column index above maximum is rejected") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_equals(parser, nullptr, 0, true, 2025, nullptr, 0) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("2024") != std::string_view::npos);
    csv_parser_destroy(parser);
  }
}

TEST_CASE("native prepared configuration owns caller buffers across chunk boundaries") {
  const std::string input = "alpha,SP,1,\"a\"\"b\r\nc\"\r\nalpine,RJ,2,ignored\r\n"
                            "alba,MG,1,ignored\nalbatross,RJ,3,last";
  const std::vector<std::vector<std::string>> expected = {
      {"alpha", "SP", "1", "a\"b\r\nc"},
      {"albatross", "RJ", "3", "last"},
  };
  const std::vector<std::vector<uint32_t>> projections = {{}, {0, 3, 5}, {3, 0, 5}};

  for (const bool count_only : {false, true}) {
    for (const auto& projection : projections) {
      for (size_t split = 0; split <= input.size(); ++split) {
        CAPTURE(count_only, projection, split);
        void* parser = csv_parser_create(0, ',');
        REQUIRE(parser != nullptr);
        {
          auto columns = projection;
          std::string values = "alSPRJ^[13]$";
          uint32_t value_offsets[] = {0, 2, 4, 6, 12};
          uint32_t filters[] = {
              3, 0, 0, 1, // column 0 starts with "al"
              2, 1, 1, 2, // column 1 is in {"SP", "RJ"}
              4, 2, 3, 1, // column 2 matches "^[13]$"
              7, 3, 0, 0, // all three leaves
          };
          REQUIRE(csv_parser_prepare(parser, !projection.empty(), columns.data(), columns.size(), filters, 4,
                                     reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 4));
          // Caller storage is overwritten and released before either chunk is parsed.
          std::fill(columns.begin(), columns.end(), 0);
          std::fill(std::begin(filters), std::end(filters), 0);
          std::fill(values.begin(), values.end(), 'x');
          std::fill(std::begin(value_offsets), std::end(value_offsets), 0);
        }

        std::vector<std::vector<std::string>> actual;
        uint64_t count = 0;
        for (const bool final : {false, true}) {
          const size_t offset = final ? split : 0;
          const size_t len = final ? input.size() - split : split;
          const auto* data = reinterpret_cast<const uint8_t*>(input.data() + offset);
          if (count_only) {
            count += csv_parser_write_prepared_count(parser, data, len, final);
          } else {
            append_batch_rows(csv_parser_write_prepared_batch(parser, data, len, final), actual);
          }
          REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
        }
        csv_parser_destroy(parser);

        if (count_only) {
          REQUIRE(count == expected.size());
        } else if (projection.empty()) {
          REQUIRE(actual == expected);
        } else {
          std::vector<std::vector<std::string>> selected;
          for (const auto& row : expected) {
            auto& fields = selected.emplace_back();
            for (const uint32_t column : projection) {
              fields.push_back(column < row.size() ? row[column] : "");
            }
          }
          REQUIRE(actual == selected);
        }
      }
    }
  }
}

TEST_CASE("native prepared parser preserves empty projections and empty filter values") {
  const std::string input = ",first\r\nno,skip\n,last";
  const uint32_t columns[] = {0};
  const uint32_t value_offsets[] = {0, 0};
  const uint32_t filters[] = {1, 0, 0, 1};

  for (const bool count_only : {false, true}) {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_prepare(parser, true, columns, 0, filters, 1, nullptr, 0, value_offsets, 1));
    std::vector<std::vector<std::string>> actual;
    uint64_t count = 0;
    for (const char& byte : input) {
      const auto* data = reinterpret_cast<const uint8_t*>(&byte);
      if (count_only) {
        count += csv_parser_write_prepared_count(parser, data, 1, false);
      } else {
        append_batch_rows(csv_parser_write_prepared_batch(parser, data, 1, false), actual);
      }
    }
    if (count_only) {
      count += csv_parser_write_prepared_count(parser, nullptr, 0, true);
      REQUIRE(count == 2);
    } else {
      append_batch_rows(csv_parser_write_prepared_batch(parser, nullptr, 0, true), actual);
      REQUIRE(actual == std::vector<std::vector<std::string>>(2));
    }
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
    csv_parser_destroy(parser);
  }
}

TEST_CASE("native prepared parser requires preparation and supports reset") {
  const uint32_t value_offsets[] = {0};
  const std::string first = "old,\"unfinished";
  const std::string replacement = "new,value\n";
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_prepared_batch(parser, nullptr, 0, true) == nullptr);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).find("prepared configuration") != std::string_view::npos);
  csv_parser_reset(parser);

  REQUIRE(csv_parser_prepare(parser, false, nullptr, 0, nullptr, 0, nullptr, 0, value_offsets, 0));
  void* partial =
      csv_parser_write_prepared_batch(parser, reinterpret_cast<const uint8_t*>(first.data()), first.size(), false);
  REQUIRE(partial != nullptr);
  REQUIRE(csv_batch_row_count(partial) == 0);
  csv_batch_destroy(partial);
  REQUIRE_FALSE(csv_parser_prepare(parser, false, nullptr, 0, nullptr, 0, nullptr, 0, value_offsets, 0));
  csv_parser_reset(parser);

  REQUIRE(csv_parser_prepare(parser, false, nullptr, 0, nullptr, 0, nullptr, 0, value_offsets, 0));
  void* batch = csv_parser_write_prepared_batch(parser, reinterpret_cast<const uint8_t*>(replacement.data()),
                                                replacement.size(), true);
  require_two_field_batch(batch, "new", "value");
  REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  csv_batch_destroy(batch);
  csv_parser_destroy(parser);
}

TEST_CASE("native prepared count distinguishes errors from zero matches") {
  constexpr uint64_t error_result = std::numeric_limits<uint64_t>::max();
  REQUIRE(csv_parser_write_prepared_count(nullptr, nullptr, 0, true) == error_result);

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_prepared_count(parser, nullptr, 0, true) == error_result);
  REQUIRE(std::string_view(csv_parser_last_error(parser)) == "parser has no prepared configuration");
  csv_parser_reset(parser);

  const std::string value = "keep";
  const uint32_t value_offsets[] = {0, 4};
  const uint32_t filters[] = {1, 0, 0, 1};
  REQUIRE(csv_parser_prepare(parser, false, nullptr, 0, filters, 1, reinterpret_cast<const uint8_t*>(value.data()),
                             value.size(), value_offsets, 1));

  SECTION("invalid input retains its error on later writes") {
    REQUIRE(csv_parser_write_prepared_count(parser, nullptr, 1, false) == error_result);
    REQUIRE(std::string_view(csv_parser_last_error(parser)) == "prepared parser input is invalid");
    REQUIRE(csv_parser_write_prepared_count(parser, nullptr, 0, true) == error_result);
    REQUIRE(std::string_view(csv_parser_last_error(parser)) == "prepared parser input is invalid");
  }

  SECTION("valid zero matches and later matching rows remain counts") {
    const std::string rejected = "drop\n";
    REQUIRE(csv_parser_write_prepared_count(parser, reinterpret_cast<const uint8_t*>(rejected.data()), rejected.size(),
                                            false) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
    REQUIRE(csv_parser_write_prepared_count(parser, reinterpret_cast<const uint8_t*>(value.data()), value.size(),
                                            true) == 1);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  }

  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI evaluates AND filters across columns and chunks") {
  const std::string input = "alpha,SP,1\nalpine,RJ,2\nalbatross,SP,3\nalpha,SP\n";
  const std::string values = "alSP13";
  const uint32_t value_offsets[] = {0, 2, 4, 5, 6};
  const uint32_t filters[] = {
      3, 0, 0, 1, // starts with "al"
      1, 1, 1, 1, // equals "SP"
      2, 2, 2, 2, // in {"1", "3"}
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  uint64_t rows = 0;
  for (size_t index = 0; index < input.size(); ++index) {
    rows += csv_parser_write_count_where_all(parser, reinterpret_cast<const uint8_t*>(input.data() + index), 1, false,
                                             filters, 3, reinterpret_cast<const uint8_t*>(values.data()), values.size(),
                                             value_offsets, 4);
  }
  rows += csv_parser_finish_count_where_all(parser, filters, 3, reinterpret_cast<const uint8_t*>(values.data()),
                                            values.size(), value_offsets, 4);
  REQUIRE(rows == 2);
  csv_parser_destroy(parser);

  const uint32_t selected_columns[] = {0, 2};
  parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, true, selected_columns,
      std::size(selected_columns), filters, 3, reinterpret_cast<const uint8_t*>(values.data()), values.size(),
      value_offsets, 4);
  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 2);
  REQUIRE(csv_batch_total_fields(batch) == 4);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(batch)), csv_batch_data_len(batch)) ==
          "alpha1albatross3");
  csv_batch_destroy(batch);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI materializes filtered unprojected rows directly across chunks") {
  const std::string first_chunk = "a,keep,tail\nb,drop,ign";
  const std::string second_chunk = "ored\nc,keep\n";
  const std::string values = "keep";
  const uint32_t value_offsets[] = {0, 4};
  const uint32_t filters[] = {
      1,
      1,
      0,
      1, // column 1 equals "keep"
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* first = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(first_chunk.data()), first_chunk.size(), false, false, nullptr, 0,
      filters, 1, reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 1);
  REQUIRE(first != nullptr);
  REQUIRE(csv_batch_row_count(first) == 1);
  REQUIRE(csv_batch_total_fields(first) == 3);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(first)), csv_batch_data_len(first)) ==
          "akeeptail");
  csv_batch_destroy(first);

  void* second = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(second_chunk.data()), second_chunk.size(), true, false, nullptr, 0,
      filters, 1, reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 1);
  REQUIRE(second != nullptr);
  REQUIRE(csv_batch_row_count(second) == 1);
  REQUIRE(csv_batch_total_fields(second) == 2);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(second)), csv_batch_data_len(second)) ==
          "ckeep");
  csv_batch_destroy(second);
  csv_parser_destroy(parser);

  parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  const std::string split_first = "a,ke";
  const std::string split_second = "ep,tail\n";
  first = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(split_first.data()), split_first.size(), false, false, nullptr, 0,
      filters, 1, reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 1);
  REQUIRE(first != nullptr);
  REQUIRE(csv_batch_row_count(first) == 0);
  REQUIRE(csv_batch_total_fields(first) == 0);
  csv_batch_destroy(first);

  second = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(split_second.data()), split_second.size(), true, false, nullptr, 0,
      filters, 1, reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 1);
  REQUIRE(second != nullptr);
  REQUIRE(csv_batch_row_count(second) == 1);
  REQUIRE(csv_batch_total_fields(second) == 3);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(second)), csv_batch_data_len(second)) ==
          "akeeptail");
  csv_batch_destroy(second);
  csv_parser_destroy(parser);
}

TEST_CASE("private Latin-1 rows preserve raw bytes and UTF-8 filters across chunk splits") {
  const std::string e_acute(1, static_cast<char>(0xE9));
  const std::string c_cedilla(1, static_cast<char>(0xE7));
  const std::string values =
      decode_latin1_reference(reinterpret_cast<const uint8_t*>(e_acute.data()), e_acute.size()) + "EX";
  const uint32_t value_offsets[] = {0, 2, 4};
  const uint32_t filters[] = {
      1, 2, 0, 1, // column 2 equals UTF-8 e-acute
      5, 3, 1, 1, // column 3 is not "EX"
  };
  const std::string input = e_acute + ",\"q\"\"\n" + c_cedilla + "\"," + e_acute + ",OK\r\n" + c_cedilla +
                            ",\"rollback\"\"value\",drop,\"skip\r\nthis\"\r\n" + e_acute + ",," + e_acute + ",EX\n" +
                            c_cedilla + ",\"last\"\"" + e_acute + "\"," + e_acute + ",OK";
  const std::vector<std::vector<std::string>> expected = {
      {e_acute, "q\"\n" + c_cedilla, e_acute, "OK"},
      {c_cedilla, "last\"" + e_acute, e_acute, "OK"},
  };
  const std::vector<std::vector<uint32_t>> projections = {{}, {0, 1, 2, 3, 5}, {3, 1, 5, 0, 2}};

  for (const auto& projection : projections) {
    for (size_t split = 0; split <= input.size(); ++split) {
      CAPTURE(projection, split);
      void* parser = csv_parser_create_latin1_rows(',');
      REQUIRE(parser != nullptr);
      size_t emitted_rows = 0;
      for (const bool final : {false, true}) {
        const size_t offset = final ? split : 0;
        const size_t len = final ? input.size() - split : split;
        void* batch = csv_parser_write_projected_batch_where_all(
            parser, reinterpret_cast<const uint8_t*>(input.data() + offset), len, final, !projection.empty(),
            projection.empty() ? nullptr : projection.data(), projection.size(), filters, 2,
            reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 2);
        REQUIRE(batch != nullptr);
        REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
        const uint64_t* row_offsets = csv_batch_row_offsets_ptr(batch);
        const uint64_t* field_offsets = csv_batch_field_offsets_ptr(batch);
        const uint8_t* data = csv_batch_data_ptr(batch);
        REQUIRE(row_offsets[0] == 0);
        REQUIRE(field_offsets[0] == 0);
        for (uint64_t row = 0; row < csv_batch_row_count(batch); ++row) {
          REQUIRE(emitted_rows < expected.size());
          const auto& expected_row = expected[emitted_rows++];
          const size_t columns = projection.empty() ? expected_row.size() : projection.size();
          REQUIRE(row_offsets[row + 1] - row_offsets[row] == columns);
          for (size_t column = 0; column < columns; ++column) {
            const size_t source_column = projection.empty() ? column : projection[column];
            const std::string_view expected_value = source_column < expected_row.size()
                                                        ? std::string_view(expected_row[source_column])
                                                        : std::string_view{};
            const uint64_t field = row_offsets[row] + column;
            const uint64_t start = field_offsets[field];
            const uint64_t end = field_offsets[field + 1];
            REQUIRE(end >= start);
            REQUIRE(end <= csv_batch_data_len(batch));
            REQUIRE(end - start == expected_value.size());
            if (!expected_value.empty()) {
              REQUIRE(std::string_view(reinterpret_cast<const char*>(data + start), end - start) == expected_value);
            }
          }
        }
        REQUIRE(row_offsets[csv_batch_row_count(batch)] == csv_batch_total_fields(batch));
        REQUIRE(field_offsets[csv_batch_total_fields(batch)] == csv_batch_data_len(batch));
        csv_batch_destroy(batch);
      }
      REQUIRE(emitted_rows == expected.size());
      csv_parser_destroy(parser);
    }
  }
}

TEST_CASE("native C ABI stops after definitive Boolean rejection but keeps CSV structure") {
  const std::string input = "drop,yes,\"quoted\nnewline\",ignored\nkeep,no,ok\n";
  const std::string values = "keepyesblocked";
  const uint32_t value_offsets[] = {0, 4, 7, 14};
  const uint32_t filters[] = {
      1, 0, 0,
      1, // column 0 equals "keep"
      1, 1, 1,
      1, // column 1 equals "yes"
      1, 2, 2,
      1, // column 2 equals "blocked"
      9, 1, 0,
      0, // not the previous result
      8, 2, 0,
      0, // any of column 1 and not column 2
      7, 2, 0,
      0, // all of column 0 and the any result
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, false, nullptr, 0, filters, 6,
      reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 3);
  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 1);
  REQUIRE(csv_batch_total_fields(batch) == 3);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(batch)), csv_batch_data_len(batch)) ==
          "keepnook");
  csv_batch_destroy(batch);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI keeps unknown Boolean predicates until a later field resolves them") {
  const std::string input = "drop,\"quoted\nnewline\",ok\n";
  const std::string values = "keepok";
  const uint32_t value_offsets[] = {0, 4, 6};
  const uint32_t filters[] = {
      1, 0, 0,
      1, // column 0 equals "keep"
      1, 2, 1,
      1, // column 2 equals "ok"
      8, 2, 0,
      0, // any of the previous results
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, false, nullptr, 0, filters, 3,
      reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 2);
  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 1);
  REQUIRE(csv_batch_total_fields(batch) == 3);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(batch)), csv_batch_data_len(batch)) ==
          "dropquoted\nnewlineok");
  csv_batch_destroy(batch);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI handles nested all-of programs with many leaves and missing fields") {
  std::vector<uint32_t> filters;
  filters.reserve(40 * 4 + 5 * 4);
  auto add_leaf = [&filters](uint32_t column) { filters.insert(filters.end(), {1, column, 0, 1}); };
  auto add_all = [&filters](uint32_t count) { filters.insert(filters.end(), {7, count, 0, 0}); };

  for (uint32_t index = 0; index < 32; ++index) {
    add_leaf(index == 31 ? 1 : 0);
  }
  add_all(8);
  add_all(8);
  add_all(8);
  add_all(8);
  add_all(4);
  const std::string values = "ok";
  const uint32_t value_offsets[] = {0, 2};

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  const std::string input = "ok\nok,ok\n";
  void* batch = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, false, nullptr, 0, filters.data(),
      filters.size() / 4, reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 1);
  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 1);
  REQUIRE(csv_batch_total_fields(batch) == 2);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(batch)), csv_batch_data_len(batch)) == "okok");
  csv_batch_destroy(batch);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI evaluates multiple filters on one column") {
  const std::string input = "alpha,1\nalpine,2\nalpha,3\n";
  const std::string values = "alalpha";
  const uint32_t value_offsets[] = {0, 2, 7};
  const uint32_t filters[] = {
      3, 0, 0, 1, 1, 0, 1, 1,
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_count_where_all(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true,
                                           filters, 2, reinterpret_cast<const uint8_t*>(values.data()), values.size(),
                                           value_offsets, 2) == 2);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI evaluates neq and noin filters") {
  const std::string input = "a,SP\nb,RJ\nc,MG\nd\n";
  const std::string values = "SPRJ";
  const uint32_t value_offsets[] = {0, 2, 4};
  const uint32_t filters[] = {
      5, 1, 0, 1, // neq "SP"
      6, 1, 1, 1, // noin {"RJ"}
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  const uint64_t rows = csv_parser_write_count_where_all(
      parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, filters, 2,
      reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 2);
  REQUIRE(rows == 1);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI evaluates nested Boolean filter programs") {
  const std::string input = "a,SP\nb,RJ\nc,MG\nd\n";
  const std::string values = "SPb";
  const uint32_t value_offsets[] = {0, 2, 3};
  const uint32_t any_filters[] = {
      1, 1, 0, 1, // column 1 equals "SP"
      3, 0, 1, 1, // column 0 starts with "b"
      8, 2, 0, 0, // any of the previous two results
  };
  const uint32_t not_any_filters[] = {
      1, 1, 0, 1, // column 1 equals "SP"
      3, 0, 1, 1, // column 0 starts with "b"
      8, 2, 0, 0, // any of the previous two results
      9, 1, 0, 0, // negate the any result
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_count_where_all(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true,
                                           any_filters, 3, reinterpret_cast<const uint8_t*>(values.data()),
                                           values.size(), value_offsets, 2) == 2);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  csv_parser_destroy(parser);

  parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_count_where_all(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true,
                                           not_any_filters, 4, reinterpret_cast<const uint8_t*>(values.data()),
                                           values.size(), value_offsets, 2) == 1);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  csv_parser_destroy(parser);

  parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_projected_batch_where_all(
      parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, false, nullptr, 0, any_filters, 3,
      reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets, 2);
  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 2);
  REQUIRE(csv_batch_total_fields(batch) == 4);
  REQUIRE(std::string(reinterpret_cast<const char*>(csv_batch_data_ptr(batch)), csv_batch_data_len(batch)) == "aSPbRJ");
  csv_batch_destroy(batch);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI compiles one RE2 filter across chunks") {
  const std::string input = "alpha,SP\nalpine,RJ\nbeta,MG\ngamma,SP\n";
  const std::string pattern = "^(?:SP|RJ)$";
  const uint32_t value_offsets[] = {0, static_cast<uint32_t>(pattern.size())};
  const uint32_t filters[] = {4, 1, 0, 1};

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  uint64_t rows = 0;
  for (size_t offset = 0; offset < input.size(); offset += 3) {
    const size_t chunk_size = std::min<size_t>(3, input.size() - offset);
    rows += csv_parser_write_count_where_all(
        parser, reinterpret_cast<const uint8_t*>(input.data() + offset), chunk_size, false, filters, 1,
        reinterpret_cast<const uint8_t*>(pattern.data()), pattern.size(), value_offsets, 1);
  }
  rows += csv_parser_finish_count_where_all(parser, filters, 1, reinterpret_cast<const uint8_t*>(pattern.data()),
                                            pattern.size(), value_offsets, 1);

  REQUIRE(rows == 3);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI reports invalid RE2 syntax") {
  const std::string invalid = "(?=SP)";
  REQUIRE(std::string_view(csv_regex_validate(reinterpret_cast<const uint8_t*>(invalid.data()), invalid.size()))
              .find("invalid perl operator") != std::string_view::npos);

  const uint32_t value_offsets[] = {0, static_cast<uint32_t>(invalid.size())};
  const uint32_t filters[] = {4, 0, 0, 1};
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters, 1,
                                           reinterpret_cast<const uint8_t*>(invalid.data()), invalid.size(),
                                           value_offsets, 1) == 0);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).find("invalid perl operator") != std::string_view::npos);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI caches each large IN filter") {
  const std::string input = "alpha,SP\nalpha,RJ\nbeta,SP\n";
  const std::string_view needles[] = {
      "alpha", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "SP", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
  };
  std::string values;
  std::vector<uint32_t> value_offsets{0};
  for (const auto needle : needles) {
    values.append(needle);
    value_offsets.push_back(static_cast<uint32_t>(values.size()));
  }
  const uint32_t filters[] = {
      2, 0, 0, 8, 2, 1, 8, 8,
  };

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  uint64_t rows = 0;
  for (size_t offset = 0; offset < input.size(); offset += 3) {
    const size_t chunk_size = std::min<size_t>(3, input.size() - offset);
    rows += csv_parser_write_count_where_all(
        parser, reinterpret_cast<const uint8_t*>(input.data() + offset), chunk_size, false, filters, 2,
        reinterpret_cast<const uint8_t*>(values.data()), values.size(), value_offsets.data(), std::size(needles));
  }
  rows += csv_parser_finish_count_where_all(parser, filters, 2, reinterpret_cast<const uint8_t*>(values.data()),
                                            values.size(), value_offsets.data(), std::size(needles));
  REQUIRE(rows == 1);
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI accepts an empty IN filter") {
  const std::string input = "a\nb\n";
  const uint32_t value_offsets[] = {0};
  const uint32_t filters[] = {2, 0, 0, 0};

  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  REQUIRE(csv_parser_write_count_where_all(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true,
                                           filters, 1, nullptr, 0, value_offsets, 0) == 0);
  REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
  csv_parser_destroy(parser);
}

TEST_CASE("native C ABI validates AND filter descriptors") {
  const uint8_t value[] = {'a'};
  const uint32_t offsets[] = {0, 1};

  SECTION("kind") {
    const uint32_t filters[] = {0, 0, 0, 1};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters, 1, value, 1, offsets, 1) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("kind") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("descriptor range") {
    const uint32_t filters[] = {2, 0, 1, 1};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters, 1, value, 1, offsets, 1) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("range") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("offset coverage") {
    const uint32_t filters[] = {1, 0, 0, 1};
    const uint32_t short_offsets[] = {0, 0};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters, 1, value, 1, short_offsets, 1) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("cover") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("filter program length") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, nullptr, 4097, value, 1, offsets, 1) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("4096") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("leaf filter count") {
    std::vector<uint32_t> filters(2025 * 4);
    std::vector<uint32_t> value_offsets(2026, 0);
    for (uint32_t index = 0; index < 2025; ++index) {
      const size_t descriptor = static_cast<size_t>(index) * 4;
      filters[descriptor] = 1;
      filters[descriptor + 1] = 0;
      filters[descriptor + 2] = index;
      filters[descriptor + 3] = 1;
    }
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters.data(), 2025, nullptr, 0,
                                             value_offsets.data(), 2025) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("2024") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("Boolean operand stack") {
    const uint32_t filters[] = {8, 2, 0, 0};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters, 1, nullptr, 0, offsets, 0) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("Boolean") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("Boolean final stack") {
    const uint32_t filters[] = {
        1, 0, 0, 1, 1, 0, 0, 1, 9, 1, 0, 0,
    };
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_all(parser, nullptr, 0, true, filters, 3, value, 1, offsets, 1) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("one result") != std::string_view::npos);
    csv_parser_destroy(parser);
  }
}

TEST_CASE("native C ABI fuzzes deterministic byte streams across parser modes") {
  for (uint32_t seed = 1; seed <= 50; ++seed) {
    const std::string input = make_fuzz_bytes(seed);
    fuzz_batch_mode(input, false);
    fuzz_batch_mode(input, true);
    fuzz_fixed_mode(input);
    fuzz_count_mode(input);
  }
}

TEST_CASE("native C ABI batch modes preserve quoted fields across every chunk split") {
  const std::string latin1_input = "\"1\";\"Jo\xE3o \"\"ol\xE1\"\"\r\nx\";SP\r\n2;;RJ\r\n3;a\xE7\xE3o;MG";
  for (const int encoding : {0, 1}) {
    const std::string input =
        encoding == 1
            ? latin1_input
            : decode_latin1_reference(reinterpret_cast<const uint8_t*>(latin1_input.data()), latin1_input.size());
    const std::string first = "Jo\xC3\xA3o \"ol\xC3\xA1\"\r\nx";
    const std::string last = "a\xC3\xA7\xC3\xA3o";
    const std::vector<std::vector<std::string>> expected = {{"1", first, "SP"}, {"2", "", "RJ"}, {"3", last, "MG"}};
    for (const bool fixed : {false, true}) {
      for (const bool strict : {false, true}) {
        for (size_t split = 0; split <= input.size(); ++split) {
          void* parser = csv_parser_create(encoding, ';');
          REQUIRE(parser != nullptr);
          std::vector<std::vector<std::string>> rows;
          const size_t cuts[] = {0, split, input.size(), input.size()};
          for (size_t part = 0; part < 3; ++part) {
            const auto* data = reinterpret_cast<const uint8_t*>(input.data() + cuts[part]);
            const size_t len = cuts[part + 1] - cuts[part];
            void* batch = fixed ? (strict ? csv_parser_write_strict_fixed_batch(parser, data, len, part == 2, 3)
                                          : csv_parser_write_fixed_batch(parser, data, len, part == 2, 3))
                                : write_batch_mode(parser, strict, data, len, part == 2);
            REQUIRE(batch != nullptr);
            const auto* row_offsets = csv_batch_row_offsets_ptr(batch);
            const auto* field_offsets = csv_batch_field_offsets_ptr(batch);
            const auto* bytes = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
            for (size_t row = 0; row < csv_batch_row_count(batch); ++row) {
              std::vector<std::string> fields;
              for (size_t field = row_offsets[row]; field < row_offsets[row + 1]; ++field) {
                fields.emplace_back(bytes + field_offsets[field], field_offsets[field + 1] - field_offsets[field]);
              }
              rows.push_back(std::move(fields));
            }
            csv_batch_destroy(batch);
          }
          csv_parser_destroy(parser);
          REQUIRE(rows == expected);
        }
      }
    }
  }
}

TEST_CASE("native C ABI projection preserves skipped fields and EOF across chunks") {
  for (const int encoding : {0, 1}) {
    const std::string value = encoding == 1 ? "a\xE7\xE3o" : "a\xC3\xA7\xC3\xA3o";
    const std::string input = "1;ignored plain value;" + value + "\r\n2;discarded;RJ\r\n1;tail";
    for (const bool ordered : {false, true}) {
      const std::vector<uint32_t> selected = ordered ? std::vector<uint32_t>{0, 2} : std::vector<uint32_t>{2, 0};
      const std::vector<std::vector<std::string>> expected =
          ordered ? std::vector<std::vector<std::string>>{{"1", "a\xC3\xA7\xC3\xA3o"}, {"1", ""}}
                  : std::vector<std::vector<std::string>>{{"a\xC3\xA7\xC3\xA3o", "1"}, {"", "1"}};
      for (size_t split = 0; split <= input.size(); ++split) {
        void* parser = csv_parser_create(encoding, ';');
        REQUIRE(parser != nullptr);
        std::vector<std::vector<std::string>> rows;
        const size_t cuts[] = {0, split, input.size(), input.size()};
        const uint8_t filter[] = {'1'};
        for (size_t part = 0; part < 3; ++part) {
          const auto* data = reinterpret_cast<const uint8_t*>(input.data() + cuts[part]);
          void* batch =
              csv_parser_write_projected_batch(parser, data, cuts[part + 1] - cuts[part], part == 2, true,
                                               selected.data(), selected.size(), true, 0, filter, sizeof(filter));
          REQUIRE(batch != nullptr);
          const auto* row_offsets = csv_batch_row_offsets_ptr(batch);
          const auto* field_offsets = csv_batch_field_offsets_ptr(batch);
          const auto* bytes = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
          for (size_t row = 0; row < csv_batch_row_count(batch); ++row) {
            std::vector<std::string> fields;
            for (size_t field = row_offsets[row]; field < row_offsets[row + 1]; ++field) {
              fields.emplace_back(bytes + field_offsets[field], field_offsets[field + 1] - field_offsets[field]);
            }
            rows.push_back(std::move(fields));
          }
          csv_batch_destroy(batch);
        }
        csv_parser_destroy(parser);
        REQUIRE(rows == expected);
      }
    }
  }
}

TEST_CASE("native latin1 fixed specialization preserves strict errors across chunks") {
  struct invalid_case {
    std::string input;
    bool strict;
    std::string error;
  };
  const std::vector<invalid_case> cases = {
      {"1;ol\xE1\n", false, "fixed row column count mismatch"},
      {"1;ol\xE1\n", true, "fixed row column count mismatch"},
      {"1;ol\xE1;SP;x\r\n", false, "fixed row column count mismatch"},
      {"1;ol\xE1;SP;x\r\n", true, "fixed row column count mismatch"},
      {"1;\"ol\xE1", true, "strict CSV quote syntax error"},
      {"1;bad\"quote;SP\n", true, "strict CSV quote syntax error"},
      {"1;\"ol\xE1\"x;SP\n", true, "strict CSV quote syntax error"},
  };
  for (const auto& example : cases) {
    for (size_t split = 0; split <= example.input.size(); ++split) {
      void* parser = csv_parser_create(1, ';');
      REQUIRE(parser != nullptr);
      std::string error;
      const size_t cuts[] = {0, split, example.input.size()};
      for (size_t part = 0; part < 2; ++part) {
        const auto* data = reinterpret_cast<const uint8_t*>(example.input.data() + cuts[part]);
        void* batch = example.strict
                          ? csv_parser_write_strict_fixed_batch(parser, data, cuts[part + 1] - cuts[part], part == 1, 3)
                          : csv_parser_write_fixed_batch(parser, data, cuts[part + 1] - cuts[part], part == 1, 3);
        if (batch == nullptr) {
          error = csv_parser_last_error(parser);
          break;
        }
        csv_batch_destroy(batch);
      }
      csv_parser_destroy(parser);
      REQUIRE(error.find(example.error) != std::string::npos);
    }
  }
}
