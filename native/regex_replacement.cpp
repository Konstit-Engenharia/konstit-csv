#include "regex_replacement.hpp"
#include <absl/container/fixed_array.h>
#include <algorithm>
#include <uni_algo/conv.h>
#include <utility>

namespace csv_native {
regex_replacement::regex_replacement(const re2::RE2& pattern, std::string_view replacement) : pattern_(pattern) {
  const int group_count = pattern.NumberOfCapturingGroups();
  const auto& names = pattern.CapturingGroupNames();
  const auto last_close = replacement.rfind('>');
  const auto digit = [](char c) { return c >= '0' && c <= '9'; };
  std::string literal;
  for (size_t i = 0; i < replacement.size();) {
    const char c = replacement[i++];
    if (c != '$' || i == replacement.size()) {
      literal += c;
      continue;
    }

    const char token = replacement[i];
    std::vector<int> groups;
    if (token == '$') {
      literal += '$';
      ++i;
      continue;
    } else if (token == '&') {
      groups.push_back(0);
      ++i;
    } else if (digit(token)) {
      int group = token - '0';
      size_t digits = 1;
      if (i + 1 < replacement.size() && digit(replacement[i + 1])) {
        const int two_digits = 10 * group + (replacement[i + 1] - '0');
        if (two_digits <= group_count) {
          group = two_digits;
          digits = 2;
        }
      }
      if (group == 0 || group > group_count) {
        literal += '$';
        continue;
      }
      groups.push_back(group);
      i += digits;
    } else if (token == '<' && !names.empty() && last_close != std::string_view::npos && i < last_close) {
      const auto close = replacement.find('>', i + 1);
      const auto name = replacement.substr(i + 1, close - i - 1);
      for (const auto& [group, candidate] : names) {
        if (candidate == name)
          groups.push_back(group);
      }
      i = close + 1;
      if (groups.empty())
        continue;
    } else {
      literal += '$';
      continue;
    }

    submatch_count_ = std::max(submatch_count_, groups.back() + 1);
    parts_.push_back({std::exchange(literal, {}), std::move(groups)});
  }
  if (!literal.empty())
    parts_.push_back({std::move(literal), {}});
}

// RE2 advances one code point after an empty match, or one byte at malformed UTF-8.
static size_t next_character(std::string_view text, size_t offset) {
  const auto lead = static_cast<unsigned char>(text[offset]);
  if (lead < 0xc2 || lead > 0xf4)
    return offset + 1;
  const size_t width = lead < 0xe0 ? 2 : (lead < 0xf0 ? 3 : 4);
  return offset + (una::is_valid_utf8(text.substr(offset, width)) ? width : 1);
}

void regex_replacement::apply(std::string& field) const {
  absl::FixedArray<absl::string_view> matches(submatch_count_);
  std::string output;
  size_t search = 0;
  size_t copied = 0;
  bool replaced = false;
  while (pattern_.Match(field, search, field.size(), re2::RE2::UNANCHORED, matches.data(), submatch_count_)) {
    const auto match = matches[0];
    const auto start = static_cast<size_t>(match.data() - field.data());
    const auto end = start + match.size();
    // RE2 global matching skips an empty match immediately following the previous match.
    if (!replaced || !match.empty() || start != copied) {
      output.append(field, copied, start - copied);
      for (const auto& part : parts_) {
        output.append(part.literal);
        absl::string_view captured;
        for (const auto group : part.groups) {
          const auto candidate = matches[group];
          if (candidate.data() && (!captured.data() || candidate.data() >= captured.data()))
            captured = candidate;
        }
        output.append(captured);
      }
      copied = end;
      replaced = true;
    }
    if (end == field.size())
      break;
    search = match.empty() ? next_character(field, end) : end;
  }
  if (replaced) {
    output.append(field, copied);
    field.swap(output);
  }
}
} // namespace csv_native
