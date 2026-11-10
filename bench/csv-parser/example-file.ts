import { statSync } from 'node:fs';
import { csv } from '../../src/index.ts';
import {
  type CsvParserMaterializeStats,
  materializeFileWithCsvParser,
} from './common.ts';

type BenchmarkTarget = 'csv-parser' | 'konstit-csv';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'corpus/large/example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 2 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const bytes = statSync(FILE).size;

// Hypothesis: csv.rows() materializes the Latin-1 corpus faster than the
// csv-parser pipeline that first decodes it with iconv-lite. Both targets read
// every field so the benchmark includes row materialization, not only parsing.
const target = parseTarget(Bun.argv[2]);
const result = target === 'konstit-csv'
  ? await materializeWithKonstitCsv()
  : await materializeFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER, 'iso88591');

if (result.rows === 0) {
  throw new Error(`${target}: zero rows`);
}

console.log({
  file: FILE,
  target,
  bytes,
  cells: result.cells.toLocaleString(),
  chars: result.chars.toLocaleString(),
  rows: result.rows.toLocaleString(),
});

async function materializeWithKonstitCsv(): Promise<CsvParserMaterializeStats> {
  let cells = 0;
  let chars = 0;
  let rows = 0;

  for await (
    const batch of csv.rows(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      encoding: 'latin1',
      where: csv.all(
        csv.column(5).equals('02'),
        csv.column(19).doesNotEqual('EX'),
      ),
      reuseArrays: true,
    })
  ) {
    rows += batch.length;
    for (const row of batch) {
      cells += row.length;
      for (const value of row) {
        chars += value.length;
      }
    }
  }

  return {
    cells,
    chars,
    rows,
  };
}

function parseTarget(value: string | undefined): BenchmarkTarget {
  if (value === 'csv-parser' || value === 'konstit-csv') {
    return value;
  }
  throw new Error('target must be csv-parser or konstit-csv');
}
