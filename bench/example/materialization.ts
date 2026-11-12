import { createReadStream } from 'node:fs';
import {
  NativeCsvParser,
  parseCsvFile,
  parseCsvFileProjected,
} from '../../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  type ExampleBenchCase,
  FILE,
  SELECTED_COLUMNS,
} from './config.ts';

export const materializationCases = [
  ['native binary batches', () => countNativeBatchRows()],
  ['native materialize rows(binary batches)', () => countNativeMaterializedRows()],
  ['native materialize rows(reused js arrays)', () => countNativeMaterializedRowsReused()],
  ['native materialize selected columns', () => countNativeSelectedRows()],
  ['native projected columns', () => countNativeProjectedRows()],
] as const satisfies readonly ExampleBenchCase[];

async function countNativeBatchRows(): Promise<number> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  let rows = 0;
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    rows += batch.rowCount;
  }
  using batch = parser.endBatch();
  rows += batch.rowCount;
  return rows;
}

async function countNativeMaterializedRows(): Promise<number> {
  let rows = 0;
  for await (const batch of parseCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER })) {
    rows += batch.length;
  }
  return rows;
}

async function countNativeMaterializedRowsReused(): Promise<number> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    rows += batch.rowsInto(rowsBuffer).length;
  }
  using batch = parser.endBatch();
  rows += batch.rowsInto(rowsBuffer).length;
  return rows;
}

async function countNativeSelectedRows(): Promise<number> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    rows += batch.rowsInto(rowsBuffer, SELECTED_COLUMNS).length;
  }
  using batch = parser.endBatch();
  rows += batch.rowsInto(rowsBuffer, SELECTED_COLUMNS).length;
  return rows;
}

async function countNativeProjectedRows(): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      columns: SELECTED_COLUMNS,
    })
  ) {
    rows += batch.length;
  }
  return rows;
}
