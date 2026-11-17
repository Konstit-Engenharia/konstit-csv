#include "field_transforms.hpp"
#include "regex.hpp"
#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstring>
#include <iterator>
#include <limits>
#include <uni_algo/case.h>
#include <uni_algo/conv.h>
#include <uni_algo/norm.h>
#include <uni_algo/prop.h>
#include <uni_algo/ranges_conv.h>
#include <uni_algo/version.h>

namespace csv_native {
namespace {
static_assert(una::version::unicode == una::version::unicode_v{15, 1, 0});
struct interval {
  char32_t first, last;
};
constexpr interval diacritics[] = {
#include "diacritic_ranges.inc"
};

bool is_diacritic_mark(char32_t cp) {
  if (!una::codepoint::prop{cp}.General_Category_M())
    return false;
  const auto it = std::lower_bound(std::begin(diacritics), std::end(diacritics), cp,
                                   [](interval range, char32_t c) { return range.last < c; });
  return it != std::end(diacritics) && it->first <= cp;
}

unsigned combining_class(char32_t cp) { return una::codepoint::prop_norm{cp}.Canonical_Combining_Class(); }

std::string remove_diacritics(std::string_view source) {
  // Work with canonical mappings per scalar: the stream-safe normalizer inserts U+034F
  // into long combining sequences, which would introduce a character absent from the field.
  std::u32string retained;
  for (char32_t cp : una::views::utf8(source)) {
    if (una::codepoint::prop_norm{cp}.NFD_Quick_Check_Yes()) {
      if (!is_diacritic_mark(cp))
        retained.push_back(cp);
    } else {
      for (char32_t part : una::codepoint::to_decompose_u32(cp)) {
        if (!is_diacritic_mark(part))
          retained.push_back(part);
      }
    }
  }
  // Restore canonical order within each run of non-starters, including runs joined by removal.
  for (auto first = retained.begin(); first != retained.end();) {
    if (combining_class(*first) == 0) {
      ++first;
      continue;
    }
    const auto end = std::find_if(first + 1, retained.end(), [](char32_t cp) { return combining_class(cp) == 0; });
    std::stable_sort(first, end, [](char32_t a, char32_t b) { return combining_class(a) < combining_class(b); });
    first = end;
  }
  size_t written = 0, starter = std::string::npos;
  unsigned previous_class = 0;
  for (char32_t cp : retained) {
    const auto cc = combining_class(cp);
    if (starter != std::string::npos && (previous_class == 0 || previous_class < cc)) {
      const auto composed = una::codepoint::to_compose(retained[starter], cp);
      if (composed != una::codepoint::replacement_char) {
        retained[starter] = composed;
        continue;
      }
    }
    if (cc == 0)
      starter = written;
    retained[written++] = cp;
    previous_class = cc;
  }
  retained.resize(written);
  return una::utf32to8(retained);
}

std::string_view trim(std::string_view field) {
  auto view = una::views::utf8(field);
  auto first = view.begin();
  auto last = view.end();
  while (first != last && una::codepoint::is_whitespace(*first))
    ++first;
  while (first != last) {
    auto prev = last;
    --prev;
    if (!una::codepoint::is_whitespace(*prev))
      break;
    last = prev;
  }
  return {first.begin(), last.begin()};
}

unsigned date_number(std::string_view digits) {
  unsigned value = 0;
  const char* end = digits.data() + digits.size();
  const auto parsed = std::from_chars(digits.data(), end, value);
  return parsed.ec == std::errc{} && parsed.ptr == end ? value : 0;
}

std::string format_date(std::string_view field, const field_transform& step) {
  std::string_view year, month, day;
  if (field.size() == 8) {
    year = field.substr(0, 4);
    month = field.substr(4, 2);
    day = field.substr(6, 2);
  } else if (field.size() == 10 && field[4] == '-' && field[7] == '-') {
    year = field.substr(0, 4);
    month = field.substr(5, 2);
    day = field.substr(8, 2);
  } else if (field.size() == 10 && (field[2] == '-' || field[2] == '/') && field[5] == field[2]) {
    day = field.substr(0, 2);
    month = field.substr(3, 2);
    year = field.substr(6, 4);
  } else {
    return step.default_value.value_or("");
  }

  const auto y = date_number(year);
  const std::chrono::year_month_day date{std::chrono::year{static_cast<int>(y)}, std::chrono::month{date_number(month)},
                                         std::chrono::day{date_number(day)}};
  if (y == 0 || !date.ok())
    return step.default_value.value_or("");
  if (step.kind != transform_kind::date_ymd)
    std::swap(year, day);
  const char separator = step.kind == transform_kind::date_dmy_slash ? '/' : '-';
  return std::string(year).append(1, separator).append(month).append(1, separator).append(day);
}
} // namespace

bool field_transforms::add(uint32_t column, uint32_t kind, std::optional<std::string_view> default_value) {
  if (kind > static_cast<uint32_t>(transform_kind::replace_regex))
    return false;
  if (column >= columns_.size())
    columns_.resize(static_cast<size_t>(column) + 1);
  auto& chain = columns_[column];
  const auto operation = static_cast<transform_kind>(kind);
  switch (operation) {
  case transform_kind::trim:
    chain.trim_ascii = true;
    break;
  case transform_kind::upper:
  case transform_kind::lower:
    chain.ascii_case = operation;
    break;
  case transform_kind::remove_diacritics:
    break;
  default:
    chain.ascii_cleanup = false;
    only_ascii_cleanup_ = false;
  }
  chain.steps.push_back({operation, {}, {}, {}, std::optional<std::string>{default_value}});
  return true;
}

bool field_transforms::add_pair(uint32_t column, std::string_view key, std::string_view value, std::string& error) {
  if (column >= columns_.size() || columns_[column].steps.empty())
    return false;
  auto& step = columns_[column].steps.back();
  if (step.kind == transform_kind::lookup) {
    step.values.emplace(key, value);
    return true;
  }
  if (step.kind == transform_kind::replace_regex) {
    if (step.regex)
      return false;
    auto pattern = regexes_.find(key);
    if (pattern == regexes_.end()) {
      auto compiled = compile_regex(key, true, error);
      if (!compiled)
        return false;
      pattern = regexes_.emplace(key, compiled_pattern{std::move(compiled), {}}).first;
    }
    auto& compiled = pattern->second;
    auto replacement = compiled.replacements.find(value);
    if (replacement == compiled.replacements.end())
      replacement = compiled.replacements.try_emplace(std::string(value), *compiled.expression, value).first;
    step.regex = &replacement->second;
    return true;
  }
  if (step.kind != transform_kind::replace_literal || key.empty() || !step.search.empty())
    return false;
  step.search = key;
  step.replacement = value;
  return true;
}

void field_transforms::prepare_ascii_cleanup() {
  uniform_ascii_columns_ = 0;
  if (!only_ascii_cleanup_ || columns_.empty())
    return;
  const auto& first = columns_.front();
  uniform_ascii_cleanup_ = {first.trim_ascii, first.ascii_case};
  for (const auto& chain : columns_) {
    if (chain.trim_ascii != first.trim_ascii || chain.ascii_case != first.ascii_case)
      break;
    ++uniform_ascii_columns_;
  }
  // Unbound columns are identities, so a uniform identity prefix also covers them.
  if (uniform_ascii_columns_ == columns_.size() && !first.trim_ascii && !first.ascii_case.has_value())
    uniform_ascii_columns_ = std::numeric_limits<size_t>::max();
}

size_t field_transforms::write_ascii(char* out, size_t column, std::string_view field) const {
  if (field.empty())
    return 0;
  if (column < columns_.size()) {
    const auto& chain = columns_[column];
    if (chain.trim_ascii) {
      const auto whitespace = [](char c) { return c == ' ' || (c >= '\t' && c <= '\r'); };
      while (!field.empty() && whitespace(field.front()))
        field.remove_prefix(1);
      while (!field.empty() && whitespace(field.back()))
        field.remove_suffix(1);
    }
    if (chain.ascii_case == transform_kind::upper) {
      for (size_t i = 0; i < field.size(); ++i)
        out[i] = field[i] >= 'a' && field[i] <= 'z' ? field[i] - ('a' - 'A') : field[i];
      return field.size();
    }
    if (chain.ascii_case == transform_kind::lower) {
      for (size_t i = 0; i < field.size(); ++i)
        out[i] = field[i] >= 'A' && field[i] <= 'Z' ? field[i] + ('a' - 'A') : field[i];
      return field.size();
    }
  }
  std::memcpy(out, field.data(), field.size());
  return field.size();
}

bool field_transforms::append(std::string& destination, size_t column, std::string_view field, bool known_ascii) const {
  if (column >= columns_.size() || columns_[column].steps.empty()) {
    destination.append(field);
    return true;
  }
  const auto& chain = columns_[column];
  if (chain.ascii_cleanup &&
      (known_ascii || std::none_of(field.begin(), field.end(), [](unsigned char c) { return c >= 0x80; }))) {
    const size_t start = destination.size();
    destination.resize(start + field.size());
    const size_t written = write_ascii(destination.data() + start, column, field);
    destination.resize(start + written);
    return true;
  }
  std::string value{field};
  for (const auto& step : chain.steps) {
    switch (step.kind) {
    case transform_kind::trim:
      value = trim(value);
      break;
    case transform_kind::upper:
      value = una::cases::to_uppercase_utf8(value);
      break;
    case transform_kind::lower:
      value = una::cases::to_lowercase_utf8(value);
      break;
    case transform_kind::remove_diacritics:
      if (std::any_of(value.begin(), value.end(), [](unsigned char c) { return c >= 0x80; }))
        value = remove_diacritics(value);
      break;
    case transform_kind::lookup:
      if (auto it = step.values.find(value); it != step.values.end())
        value = it->second;
      else if (step.default_value.has_value())
        value = *step.default_value;
      break;
    case transform_kind::date_ymd:
    case transform_kind::date_dmy:
    case transform_kind::date_dmy_slash:
      value = format_date(value, step);
      break;
    case transform_kind::replace_regex:
      if (!step.regex)
        return false;
      step.regex->apply(value);
      break;
    case transform_kind::replace_literal: {
      if (step.search.empty())
        return false;
      size_t match = value.find(step.search);
      if (match == std::string::npos)
        break;
      std::string replaced;
      size_t start = 0;
      do {
        replaced.append(value, start, match - start);
        replaced.append(step.replacement);
        start = match + step.search.size();
        match = value.find(step.search, start);
      } while (match != std::string::npos);
      replaced.append(value, start);
      value = std::move(replaced);
      break;
    }
    }
  }
  destination.append(value);
  return true;
}
} // namespace csv_native
