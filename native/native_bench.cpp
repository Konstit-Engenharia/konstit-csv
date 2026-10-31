#include <mitata.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <regex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

extern "C" {
void* csv_parser_create(int encoding, uint8_t delimiter);
void csv_parser_destroy(void* parser);
void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final, uint32_t columns);
void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final, bool has_projection,
                                       const uint32_t* selected_columns, uint64_t selected_columns_len, bool has_filter,
                                       uint32_t filter_column, const uint8_t* filter_value, uint64_t filter_value_len);
void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter);
uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
uint64_t csv_parser_count_trusted_newlines(const uint8_t* data, uint64_t len);
uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
                                             uint32_t filter_column, const uint8_t* filter_value,
                                             uint64_t filter_value_len);
void csv_batch_destroy(void* batch);
void csv_split_offsets_batch_destroy(void* batch);
uint64_t csv_batch_row_count(void* batch);
uint64_t csv_batch_total_fields(void* batch);
uint64_t csv_split_offsets_batch_count(void* batch);
}

namespace {

constexpr uint8_t delimiter = ';';
constexpr uint32_t filter_column = 19;
constexpr uint8_t filter_value[] = {'S', 'P'};
constexpr uint32_t selected_columns[] = {0, 4, 19};
constexpr uint64_t default_bytes = 256ull * 1024ull * 1024ull;

std::vector<uint8_t> g_input;
uint64_t g_strict_input_size = 0;
std::string g_split_input_path;
volatile uint64_t g_sink = 0;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "native bench error: " << message << std::endl;
  std::abort();
}

uint64_t parse_u64_env(const char* name, uint64_t fallback) {
  const char* value = std::getenv(name);
  if (value == nullptr || value[0] == '\0') {
    return fallback;
  }

  char* end = nullptr;
  const auto parsed = std::strtoull(value, &end, 10);
  if (end == value || (end != nullptr && end[0] != '\0')) {
    fail(std::string("invalid ") + name + ": " + value);
  }
  return parsed;
}

std::string string_env(const char* name, const char* fallback) {
  const char* value = std::getenv(name);
  return value == nullptr || value[0] == '\0' ? std::string(fallback) : std::string(value);
}

std::vector<uint8_t> read_input(const std::string& path, uint64_t byte_limit, bool& complete_file_read) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    fail("could not open " + path);
  }

  file.seekg(0, std::ios::end);
  const auto size = file.tellg();
  if (size < 0) {
    fail("could not stat " + path);
  }
  file.seekg(0, std::ios::beg);

  const auto available = static_cast<uint64_t>(size);
  const auto wanted = byte_limit == 0 ? available : std::min(byte_limit, available);
  complete_file_read = wanted == available;
  std::vector<uint8_t> data(static_cast<size_t>(wanted));
  if (!data.empty()) {
    file.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(data.size()));
    if (file.gcount() != static_cast<std::streamsize>(data.size())) {
      fail("short read from " + path);
    }
  }
  return data;
}

constexpr size_t complete_record_prefix(std::string_view input, uint8_t field_delimiter,
                                        bool complete_file_read = false) {
  bool in_quotes = false;
  bool pending_quote = false;
  bool at_field_start = true;
  bool previous_was_cr = false;
  size_t complete_prefix = 0;
  size_t index = 0;

  while (index < input.size()) {
    const auto byte = static_cast<uint8_t>(input[index]);
    if (in_quotes) {
      if (pending_quote) {
        if (byte == '"') {
          pending_quote = false;
          at_field_start = false;
          ++index;
          continue;
        }
        pending_quote = false;
        in_quotes = false;
        continue;
      }

      if (byte == '"') {
        pending_quote = true;
      }
      ++index;
      continue;
    }

    if (previous_was_cr) {
      previous_was_cr = false;
      if (byte == '\n') {
        complete_prefix = index + 1;
        at_field_start = true;
        ++index;
        continue;
      }
    }

    if (byte == field_delimiter) {
      at_field_start = true;
    } else if (byte == '\n') {
      complete_prefix = index + 1;
      at_field_start = true;
    } else if (byte == '\r') {
      complete_prefix = index + 1;
      at_field_start = true;
      previous_was_cr = true;
    } else if (byte == '"' && at_field_start) {
      in_quotes = true;
      at_field_start = false;
    } else {
      at_field_start = false;
    }
    ++index;
  }

  if (complete_file_read && (!in_quotes || pending_quote)) {
    return input.size();
  }
  return complete_prefix;
}

static_assert(complete_record_prefix("a;b\npartial", delimiter) == 4);
static_assert(complete_record_prefix("a;b\rpartial", delimiter) == 4);
static_assert(complete_record_prefix("a;b\r\npartial", delimiter) == 5);
static_assert(complete_record_prefix("\"a\nb\";c\rpartial", delimiter) == 8);
static_assert(complete_record_prefix("\"a\"\"\nb\";c\npartial", delimiter) == 10);
static_assert(complete_record_prefix("\"a\nb", delimiter) == 0);
static_assert(complete_record_prefix("a;b", delimiter, true) == 3);
static_assert(complete_record_prefix("\"a\"", delimiter, true) == 3);
static_assert(complete_record_prefix("\"a", delimiter, true) == 0);

void* new_parser(int encoding = 0) {
  void* parser = csv_parser_create(encoding, delimiter);
  if (parser == nullptr) {
    fail("csv_parser_create returned null");
  }
  return parser;
}

void consume(uint64_t value) { g_sink ^= value + 0x9e3779b97f4a7c15ull + (g_sink << 6) + (g_sink >> 2); }

void bench_count() {
  void* parser = new_parser();
  const uint64_t rows = csv_parser_write_count(parser, g_input.data(), g_input.size(), true);
  csv_parser_destroy(parser);
  if (rows == 0) {
    fail("count returned 0 rows");
  }
  consume(rows);
}

void bench_trusted_count() {
  const uint64_t rows = csv_parser_count_trusted_newlines(g_input.data(), g_input.size());
  if (rows == 0) {
    fail("trusted count returned 0 rows");
  }
  consume(rows);
}

void bench_filter_count() {
  void* parser = new_parser();
  const uint64_t rows = csv_parser_write_count_where_equals(parser, g_input.data(), g_input.size(), true, filter_column,
                                                            filter_value, sizeof(filter_value));
  csv_parser_destroy(parser);
  consume(rows);
}

void bench_binary_batch() {
  void* parser = new_parser();
  void* batch = csv_parser_write_batch(parser, g_input.data(), g_input.size(), true);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_write_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_latin1_batch() {
  void* parser = new_parser(1);
  void* batch = csv_parser_write_batch(parser, g_input.data(), g_input.size(), true);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("latin1 csv_parser_write_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_strict_binary_batch() {
  void* parser = new_parser();
  void* batch = csv_parser_write_strict_batch(parser, g_input.data(), g_strict_input_size, true);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("strict csv_parser_write_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_strict_latin1_batch() {
  void* parser = new_parser(1);
  void* batch = csv_parser_write_strict_batch(parser, g_input.data(), g_strict_input_size, true);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("strict latin1 csv_parser_write_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

// Compare fixed-column arena writes against the ordinary binary batch on the same input.
void bench_fixed_batch() {
  void* parser = new_parser();
  void* batch = csv_parser_write_fixed_batch(parser, g_input.data(), g_input.size(), true, 20);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("fixed batch returned null (fixture must have 20 columns)");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_latin1_fixed_batch() {
  void* parser = new_parser(1);
  void* batch = csv_parser_write_fixed_batch(parser, g_input.data(), g_input.size(), true, 20);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("fixed batch returned null (fixture must have 20 columns)");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_split_offsets() {
  void* batch = csv_parser_find_split_offsets(g_split_input_path.c_str(), 16, delimiter);
  if (batch == nullptr) {
    fail("csv_parser_find_split_offsets returned null");
  }
  consume(csv_split_offsets_batch_count(batch));
  csv_split_offsets_batch_destroy(batch);
}

void bench_project_filter() {
  void* parser = new_parser();
  void* batch = csv_parser_write_projected_batch(parser, g_input.data(), g_input.size(), true, true, selected_columns,
                                                 sizeof(selected_columns) / sizeof(selected_columns[0]), true,
                                                 filter_column, filter_value, sizeof(filter_value));
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_write_projected_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_latin1_project_filter() {
  void* parser = new_parser(1);
  void* batch = csv_parser_write_projected_batch(parser, g_input.data(), g_input.size(), true, true, selected_columns,
                                                 sizeof(selected_columns) / sizeof(selected_columns[0]), true,
                                                 filter_column, filter_value, sizeof(filter_value));
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_write_projected_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

} // namespace

int main() {
  const auto path = string_env("CSV_NATIVE_BENCH_FILE", "corpus/large/example.csv");
  const auto byte_limit = parse_u64_env("CSV_NATIVE_BENCH_BYTES", default_bytes);
  const auto filter = string_env("CSV_NATIVE_BENCH_FILTER", ".*");
  const auto format = string_env("CSV_NATIVE_BENCH_FORMAT", "mitata");
  const std::regex benchmark_filter(filter);
  bool complete_file_read = false;
  g_input = read_input(path, byte_limit, complete_file_read);
  if (g_input.empty()) {
    fail("input is empty");
  }

  const bool strict_benchmark_requested = std::regex_match("native strict binary batch", benchmark_filter) ||
                                          std::regex_match("native strict latin1 batch", benchmark_filter);
  if (strict_benchmark_requested) {
    g_strict_input_size = complete_record_prefix(
        std::string_view(reinterpret_cast<const char*>(g_input.data()), g_input.size()), delimiter, complete_file_read);
    if (g_strict_input_size == 0) {
      fail("strict benchmarks require at least one structurally complete record");
    }
  }

  std::cerr << "native bench input: " << path << " bytes=" << g_input.size() << std::endl;

  // Bounded measurements avoid allocating/exporting millions of optimized-out noop samples.
  if (std::getenv("CSV_NATIVE_BENCH_COMPACT") != nullptr) {
    mitata::lib::k_options options;
    options.min_samples = 12;
    options.max_samples = 200;
    options.min_cpu_time = 250e6;
    const std::pair<const char*, void (*)()> cases[] = {
        {"native binary batch", bench_binary_batch},
        {"native latin1 batch", bench_latin1_batch},
        {"native fixed batch 20 columns", bench_fixed_batch},
        {"native latin1 fixed batch 20 columns", bench_latin1_fixed_batch},
        {"native projected filter", bench_project_filter},
        {"native latin1 projected filter", bench_latin1_project_filter},
    };
    for (const auto& [name, fn] : cases) {
      if (!std::regex_match(name, benchmark_filter)) {
        continue;
      }
      const auto stats = mitata::lib::fn(fn, options);
      std::cout << "{\"name\":\"" << name << "\",\"avg\":" << stats.avg << ",\"min\":" << stats.min
                << ",\"max\":" << stats.max << ",\"p50\":" << stats.p50 << ",\"p99\":" << stats.p99
                << ",\"samples\":" << stats.samples.size() << "}\n";
    }
    return 0;
  }

  mitata::runner runner;
  auto* count = runner.bench("native count", bench_count);
  count->baseline();
  runner.bench("native trusted count", bench_trusted_count);
  runner.bench("native filter count", bench_filter_count);
  runner.bench("native binary batch", bench_binary_batch);
  // Compares portable Latin-1 SIMD decoding with the UTF-8 materialization baseline on the same bytes.
  runner.bench("native latin1 batch", bench_latin1_batch);
  // Measures strict quote and column validation on a complete-row UTF-8 prefix.
  runner.bench("native strict binary batch", bench_strict_binary_batch);
  // Measures strict validation with Latin-1 decoding on the same complete-row prefix.
  runner.bench("native strict latin1 batch", bench_strict_latin1_batch);
  if (const char* split_input = std::getenv("CSV_NATIVE_BENCH_SPLIT_FILE"); split_input != nullptr) {
    g_split_input_path = split_input;
    // Measures the end-to-end quote-aware structural scan used to find safe file shard boundaries.
    runner.bench("native split offsets", bench_split_offsets);
  }
  runner.bench("native projected filter", bench_project_filter);
  mitata::k_run options;
  options.colors = std::getenv("NO_COLOR") == nullptr;
  options.format = format;
  options.filter = benchmark_filter;
  runner.run(options);

  if (g_sink == 0) {
    std::cerr << "native bench sink=" << g_sink << std::endl;
  }
  return 0;
}
