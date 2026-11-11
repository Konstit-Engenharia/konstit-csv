#include <hwy/highway.h>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>

namespace {
namespace hn = hwy::HWY_NAMESPACE;
constexpr size_t row_limit = 128;
constexpr std::array<uint8_t, 7> candidates = {',', '\t', ';', '|', ':', '^', '~'};
constexpr auto candidate_index = [] {
  std::array<uint8_t, 128> indices{};
  for (size_t i = 0; i < candidates.size(); ++i)
    indices[candidates[i]] = i;
  return indices;
}();

struct RowCounts {
  std::array<uint32_t, 7> current{};
  uint32_t* stable;
  uint32_t rows = 0;

  void finish() {
    for (size_t i = 0; i < current.size(); ++i) {
      if (rows == 0)
        stable[i] = current[i];
      else if (current[i] != stable[i])
        stable[i] = 0;
    }
    ++rows;
    current.fill(0);
  }
};

enum Encoding : uint32_t { utf8, latin1, windows1252, contains_nul };
} // namespace

// A non-null output requests seven stable separator counts and the number of complete nonempty rows.
extern "C" __attribute__((visibility("default"))) HWY_ATTR uint32_t csv_probe_format(const uint8_t* bytes,
                                                                                     uint32_t size, bool eof,
                                                                                     bool infer_encoding,
                                                                                     uint32_t* output) {
  const hn::CappedTag<uint8_t, 32> d;
  const size_t width = hn::Lanes(d);
  RowCounts counts{{}, output};
  bool quoted = false;
  size_t row_start = 0;
  bool valid_utf8 = true;
  bool has_c1 = false;
  uint64_t carry = 0;

  for (size_t offset = 0; offset < size; offset += width) {
    const size_t n = std::min(width, size - offset);
    const uint64_t active = (uint64_t{1} << n) - 1;
    const auto v = n == width ? hn::LoadU(d, bytes + offset) : hn::LoadN(d, bytes + offset, n);
    const auto eq = [&](uint8_t b) HWY_ATTR { return hn::Eq(v, hn::Set(d, b)); };
    const auto ge = [&](uint8_t b) HWY_ATTR { return hn::Ge(v, hn::Set(d, b)); };
    const auto bits = [&](auto mask) HWY_ATTR { return hn::BitsFromMask(d, mask) & active; };

    if (infer_encoding) {
      if (bits(eq(0)) != 0)
        return contains_nul;
      if (bits(ge(0x80)) != 0 || carry != 0) {
        has_c1 |= bits(hn::And(ge(0x80), hn::Not(ge(0xa0)))) != 0;
        if (valid_utf8) {
          // A two-, three- or four-byte lead requires continuations in the next
          // one, two or three lanes. Carry those expectations across vectors.
          const auto expected = carry | (bits(ge(0xc0)) << 1) | (bits(ge(0xe0)) << 2) | (bits(ge(0xf0)) << 3);
          const auto actual = bits(hn::And(ge(0x80), hn::Not(ge(0xc0))));
          carry = expected >> n;
          valid_utf8 = (expected & active) == actual && bits(hn::Or(hn::Or(eq(0xc0), eq(0xc1)), ge(0xf5))) == 0;
          // Four lead values restrict the second byte to exclude overlong
          // forms, surrogate code points and values above U+10FFFF.
          auto special = bits(hn::Or(hn::Or(eq(0xe0), eq(0xed)), hn::Or(eq(0xf0), eq(0xf4))));
          while (valid_utf8 && special != 0) {
            const size_t i = offset + std::countr_zero(special);
            special &= special - 1;
            if (i + 1 == size)
              break;
            const auto lead = bytes[i], next = bytes[i + 1];
            valid_utf8 = !(lead == 0xe0 && next < 0xa0) && !(lead == 0xed && next >= 0xa0) &&
                         !(lead == 0xf0 && next < 0x90) && !(lead == 0xf4 && next >= 0x90);
          }
        }
      }
    }

    if (output == nullptr || counts.rows == row_limit) {
      if (!infer_encoding)
        break;
      continue;
    }
    auto structural = hn::Or(eq('"'), hn::Or(eq('\n'), eq('\r')));
    for (const uint8_t c : candidates)
      structural = hn::Or(structural, eq(c));
    auto events = bits(structural);
    while (events != 0) {
      const size_t i = offset + std::countr_zero(events);
      events &= events - 1;
      const uint8_t c = bytes[i];
      if (c == '"') {
        // An escaped pair toggles twice with no separator between the quotes.
        quoted = !quoted;
      } else if (!quoted) {
        if (c == '\n' || c == '\r') {
          if (i > row_start)
            counts.finish();
          row_start = i + 1;
          if (counts.rows == row_limit)
            break;
        } else {
          ++counts.current[candidate_index[c]];
        }
      }
    }
  }
  if (output != nullptr) {
    if (eof && !quoted && row_start < size && counts.rows < row_limit)
      counts.finish();
    output[7] = counts.rows;
  }
  if (valid_utf8 && (!eof || carry == 0))
    return utf8;
  return has_c1 ? windows1252 : latin1;
}
