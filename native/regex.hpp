#pragma once

#include <memory>
#include <re2/re2.h>
#include <string>
#include <string_view>

namespace csv_native {
inline constexpr size_t max_regex_pattern_size = 4096;

inline std::unique_ptr<re2::RE2> compile_regex(std::string_view source, bool capture, std::string& error) {
  if (source.size() > max_regex_pattern_size) {
    error = "regular expression exceeds 4096 UTF-8 bytes";
    return nullptr;
  }
  re2::RE2::Options options;
  options.set_log_errors(false);
  options.set_max_mem(1 << 20);
  options.set_never_capture(!capture);
  auto compiled = std::make_unique<re2::RE2>(source, options);
  if (!compiled->ok()) {
    error = "invalid regular expression: " + compiled->error();
    return nullptr;
  }
  return compiled;
}
} // namespace csv_native
