#pragma once

#include <re2/re2.h>
#include <string>
#include <string_view>
#include <vector>

namespace csv_native {
class regex_replacement {
public:
  regex_replacement(const re2::RE2& pattern, std::string_view replacement);
  void apply(std::string& field) const;

private:
  // Each literal run is followed by a capture, if any. A name can occur in disjoint alternatives.
  struct part {
    std::string literal;
    std::vector<int> groups;
  };
  const re2::RE2& pattern_;
  int submatch_count_ = 1;
  std::vector<part> parts_;
};
} // namespace csv_native
