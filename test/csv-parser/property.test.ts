import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  NativeCsvParser,
  parseCsvBuffer,
} from '../../src/index.ts';
import {
  parseChunkedRows,
  parseRows,
} from './helpers.ts';

interface GeneratedCase {
  csv: string;
  rows: string[][];
  delimiter: string;
}

describe('generated CSV property tests', () => {
  for (const delimiter of [',', ';']) {
    test(`round-trips generated valid CSV with delimiter ${delimiter}`, () => {
      for (let seed = 1; seed <= 80; ++seed) {
        const fixture = generateCase(seed, delimiter);
        expect(parseRows(fixture.csv, { delimiter })).toEqual(fixture.rows);
        expect(parseRows(fixture.csv, { delimiter, strict: true })).toEqual(fixture.rows);

        for (const chunkSize of [1, 2, 5, 17]) {
          expect(parseChunkedRows(fixture.csv, chunkSize, { delimiter })).toEqual(fixture.rows);
          expect(parseChunkedRows(fixture.csv, chunkSize, { delimiter, strict: true })).toEqual(fixture.rows);
        }

        for (const chunkSize of [1, 2, 15, 16, 17, 31, 32, 33, 63, 64, 65]) {
          expect(countChunkedRows(fixture.csv, chunkSize, delimiter)).toBe(fixture.rows.length);
        }
      }
    });
  }

  test('selected columns match generated rows', () => {
    for (let seed = 100; seed < 140; ++seed) {
      const fixture = generateCase(seed, ';');
      const selected = [0, 2] as const;
      const expected = fixture.rows.map((row) => [row[0] ?? '', row[2] ?? '']);
      expect(parseCsvBuffer(Buffer.from(fixture.csv), {
        delimiter: fixture.delimiter,
        columns: selected,
        strict: true,
      })).toEqual(expected);
    }
  });
});

function countChunkedRows(csv: string, chunkSize: number, delimiter: string): number {
  const input = Buffer.from(csv);
  using parser = new NativeCsvParser({ delimiter });
  let rows = 0;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    rows += parser.writeCount(input.subarray(offset, offset + chunkSize));
  }
  return rows + parser.endCount();
}

function generateCase(seed: number, delimiter: string): GeneratedCase {
  const random = createRandom(seed);
  const columnCount = 1 + random.int(5);
  const rowCount = 1 + random.int(24);
  const rows: string[][] = [];
  rows.length = rowCount;

  for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
    const row: string[] = [];
    row.length = columnCount;
    for (let columnIndex = 0; columnIndex < columnCount; ++columnIndex) {
      row[columnIndex] = randomField(random, delimiter);
    }
    rows[rowIndex] = row;
  }

  const newline = random.bool() ? '\n' : '\r\n';
  const trailingNewline = random.bool();
  const csv = rows.map((row) => row.map((field) => renderField(field, delimiter, random)).join(delimiter)).join(newline)
    + (trailingNewline ? newline : '');

  return {
    csv,
    delimiter,
    rows,
  };
}

function randomField(random: Random, delimiter: string): string {
  const alphabet = ['a', 'b', 'c', '0', '1', ' ', delimiter, '"', '\n', '\r\n', 'é', '中'];
  const length = random.int(12);
  let value = '';
  for (let index = 0; index < length; ++index) {
    value += alphabet[random.int(alphabet.length)] ?? '';
  }
  return value;
}

function renderField(value: string, delimiter: string, random: Random): string {
  const mustQuote = value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');
  if (!mustQuote && random.int(4) !== 0) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

interface Random {
  bool(): boolean;
  int(maxExclusive: number): number;
}

function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  return {
    bool: () => (next() & 1) === 1,
    int: (maxExclusive: number) => next() % maxExclusive,
  };
}
