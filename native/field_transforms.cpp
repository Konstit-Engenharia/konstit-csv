#include "field_transforms.hpp"
#include <algorithm>
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
} // namespace

bool field_transforms::add(uint32_t column, uint32_t kind, std::optional<std::string_view> map_default) {
  if (kind > static_cast<uint32_t>(transform_kind::lookup))
    return false;
  if (column >= columns_.size())
    columns_.resize(static_cast<size_t>(column) + 1);
  columns_[column].push_back({static_cast<transform_kind>(kind), {}, {}, {}, std::optional<std::string>{map_default}});
  return true;
}

bool field_transforms::add_pair(uint32_t column, std::string_view key, std::string_view value) {
  if (column >= columns_.size() || columns_[column].empty())
    return false;
  auto& step = columns_[column].back();
  if (step.kind == transform_kind::lookup) {
    step.values.emplace(key, value);
    return true;
  }
  if (step.kind != transform_kind::replace_all || key.empty() || !step.search.empty())
    return false;
  step.search = key;
  step.replacement = value;
  return true;
}

bool field_transforms::append(std::string& destination, size_t column, std::string_view field) const {
  if (column >= columns_.size() || columns_[column].empty()) {
    destination.append(field);
    return true;
  }
  std::string value{field};
  for (const auto& step : columns_[column]) {
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
      else if (step.map_default.has_value())
        value = *step.map_default;
      break;
    case transform_kind::replace_all: {
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
