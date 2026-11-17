import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  type ExampleBenchCase,
  FILE,
  runExampleBenchCases,
} from './example/config.ts';

// example.csv has 30 Latin-1 fields per row. Measure native output generation
// and end-to-end string materialization with the same input and cleanup chain.
const columns = 30;
const plain = { chunkSize: CHUNK_SIZE, delimiter: DELIMITER, encoding: 'latin1', fixedColumns: columns } as const;
const chain = csv.transform().trim().upper().unaccent();
const remaining = Array.from({ length: columns - 1 }, (_, i) => i + 1);
const cleanup = { ...plain, transform: [chain.on(0, ...remaining)] };
const cases: ExampleBenchCase[] = [];

for (const [name, options,] of [['plain', plain], ['cleanup', cleanup]] as const) {
  cases.push([`native batches / ${name}`, async () => {
    let rows = 0;
    let fields = 0;
    let bytes = 0;
    for await (using batch of csv.batches(FILE, options)) {
      rows += batch.rowCount;
      fields += batch.totalFields;
      bytes += batch.dataLength;
    }
    if (fields !== rows * columns || bytes === 0) {
      throw new Error('unexpected native batch output');
    }
    return rows;
  }]);
  cases.push([`materialized rows / ${name}`, async () => {
    let rows = 0;
    let fields = 0;
    let characters = 0;
    for await (const batch of csv.rows(FILE, { ...options, reuseArrays: true })) {
      rows += batch.length;
      for (const row of batch) {
        fields += row.length;
        for (const field of row) {
          characters += field.length;
        }
      }
    }
    if (fields !== rows * columns || characters === 0) {
      throw new Error('unexpected materialized output');
    }
    return rows;
  }]);
}

await runExampleBenchCases(cases);
