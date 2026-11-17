#pragma once

#include <ankerl/unordered_dense.h>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace csv_native {
enum class transform_kind : uint32_t { trim, upper, lower, remove_diacritics, replace_all, lookup };

struct field_transform {
  transform_kind kind;
  std::string search;
  std::string replacement;
  ankerl::unordered_dense::map<std::string, std::string> values;
  std::optional<std::string> map_default;
};

class field_transforms {
public:
  bool empty() const { return columns_.empty(); }
  bool add(uint32_t column, uint32_t kind, std::optional<std::string_view> map_default);
  bool add_pair(uint32_t column, std::string_view key, std::string_view value);
  bool append(std::string& destination, size_t column, std::string_view field) const;

private:
  std::vector<std::vector<field_transform>> columns_;
};
} // namespace csv_native
