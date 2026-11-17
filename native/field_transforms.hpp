#pragma once

#include <ankerl/unordered_dense.h>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace csv_native {
enum class transform_kind : uint32_t {
  trim,
  upper,
  lower,
  remove_diacritics,
  replace_all,
  lookup,
  date_ymd,
  date_dmy,
  date_dmy_slash
};

struct field_transform {
  transform_kind kind;
  std::string search;
  std::string replacement;
  ankerl::unordered_dense::map<std::string, std::string> values;
  std::optional<std::string> default_value;
};

class field_transforms {
public:
  bool empty() const { return columns_.empty(); }
  bool add(uint32_t column, uint32_t kind, std::optional<std::string_view> default_value);
  bool add_pair(uint32_t column, std::string_view key, std::string_view value);
  bool append(std::string& destination, size_t column, std::string_view field, bool known_ascii = false) const;
  bool only_ascii_cleanup() const { return only_ascii_cleanup_; }
  // ASCII cleanup never expands the field. The caller reserves room for its original width.
  size_t write_ascii(char* out, size_t column, std::string_view field) const;

private:
  struct column_chain {
    std::vector<field_transform> steps;
    // On ASCII, unaccent is an identity and trimming commutes with case conversion.
    bool ascii_cleanup = true;
    bool trim_ascii = false;
    std::optional<transform_kind> ascii_case;
  };
  std::vector<column_chain> columns_;
  bool only_ascii_cleanup_ = true;
};
} // namespace csv_native
