import {
  bench,
  summary,
} from 'mitata';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCsvFileChunks } from '../src/file-stream.ts';
import { csv } from '../src/index.ts';

// Measure decompressing, filtering, and writing a train/test split at low and
// high match rates. Both implementations preserve the source records verbatim.
const ROWS = 500_000;
const COUNTRY = ['br', 'BR', 'Br', 'bR'] as const;
const compression = { compression: 'gzip' } as const;
const options = {
  ...compression,
  delimiter: '\t',
  quote: false,
  recordDelimiter: '\n',
  output: 'raw-records',
  where: csv.column(1).isOneOf(COUNTRY),
} as const;

const dir = mkdtempSync(join(tmpdir(), 'csv-raw-record-bench-'));
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
const train = join(dir, 'train.tsv');
const test = join(dir, 'test.tsv');

type ConsumeRecord = (bytes: Uint8Array) => void;
type ReadRecords = (path: string, consume: ConsumeRecord) => Promise<void>;

async function split(path: string, readRecords: ReadRecords): Promise<number> {
  const trainWriter = Bun.file(train).writer({ highWaterMark: 64 * 1024 });
  const testWriter = Bun.file(test).writer({ highWaterMark: 64 * 1024 });
  let accepted = 0;
  try {
    await readRecords(path, (record) => {
      const writer = accepted++ % 10 === 0 ? testWriter : trainWriter;
      void writer.write(record);
    });
    return accepted;
  } finally {
    await Promise.all([trainWriter.end(), testWriter.end()]);
  }
}

async function readManual(path: string, consume: ConsumeRecord): Promise<void> {
  let carry: Buffer | undefined;
  for await (const chunk of readCsvFileChunks(path, compression)) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const input = carry === undefined ? bytes : Buffer.concat([carry, bytes]);
    let start = 0;
    for (let lf = input.indexOf(10); lf >= 0; lf = input.indexOf(10, start)) {
      matchManual(input, start, lf + 1, consume);
      start = lf + 1;
    }
    carry = start === input.length ? undefined : input.subarray(start);
  }
  if (carry !== undefined) {
    matchManual(carry, 0, carry.length, consume);
  }
}

function matchManual(input: Buffer, start: number, end: number, consume: ConsumeRecord): void {
  const firstTab = input.indexOf(9, start);
  if (firstTab < 0 || firstTab + 3 >= end || input[firstTab + 3] !== 9) {
    return;
  }
  if (((input[firstTab + 1] ?? 0) | 32) !== 98 || ((input[firstTab + 2] ?? 0) | 32) !== 114) {
    return;
  }
  const extraTab = input.indexOf(9, firstTab + 4);
  if (extraTab < 0 || extraTab >= end) {
    consume(input.subarray(start, end));
  }
}

async function readNative(path: string, consume: ConsumeRecord): Promise<void> {
  for await (using batch of csv.batches(path, options)) {
    for (let i = 0, rows = batch.rowCount; i < rows; ++i) {
      if (batch.rowFieldCount(i) === 3) {
        consume(batch.rowBytes(i));
      }
    }
  }
}

async function outputHashes(): Promise<string[]> {
  return await Promise.all([train, test].map(async (path) => Bun.CryptoHasher.hash('sha256', await Bun.file(path).bytes(), 'hex')));
}

for (const frequency of [100, 1]) {
  const path = join(dir, `matches-every-${frequency}.tsv.gz`);
  const source = Array.from({ length: ROWS }, (_, i) => {
    const country = i % frequency === 0 ? COUNTRY[Math.floor(i / frequency) % COUNTRY.length] : 'ar';
    const extra = i % 127 === 0 ? '\textra' : '';
    const ending = i === ROWS - 1 ? '' : i % 2 === 0 ? '\r\n' : '\n';
    return `pt\t${country}\t"Rua São João, número ${i}, Barra da Tijuca, Rio de Janeiro${extra}${ending}`;
  });
  await Bun.write(path, Bun.gzipSync(Buffer.from(source.join(''), 'latin1')));

  const expectedRows = await split(path, readManual);
  const expectedHashes = await outputHashes();
  const actualRows = await split(path, readNative);
  const actualHashes = await outputHashes();
  if (actualRows !== expectedRows || actualHashes.some((hash, i) => hash !== expectedHashes[i])) {
    throw new Error(`raw-record split differs from manual split for ${100 / frequency}% matches`);
  }
  console.info(
    `${100 / frequency}% matches, ${actualRows} valid records, train SHA-256 ${actualHashes[0]}, test SHA-256 ${actualHashes[1]}`,
  );

  summary(() => {
    for (const [label, readRecords,] of [['manual split', readManual], ['raw-record split', readNative]] as const) {
      bench(`${100 / frequency}% matches / ${label}`, async () => {
        const count = await split(path, readRecords);
        if (count !== expectedRows) {
          throw new Error(`expected ${expectedRows} valid records, got ${count}`);
        }
        return count;
      });
    }
  });
}
