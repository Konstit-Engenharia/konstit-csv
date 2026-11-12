import { bench } from 'mitata';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  iterateRows,
} from '../../src/api.ts';
import type { CsvFileProbe } from '../../src/file-stream.ts';
import { snapshotCsvOptions } from '../../src/options-snapshot.ts';
import { referenceProbe } from './probes.ts';

// Compare how soon a caller can use the first real row batch with either
// probe. Both iterators open the file, probe, replay and materialize normally.
const directory = mkdtempSync(join(tmpdir(), 'csv-probe-'));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
const inputs: { name: string; path: string; encoding: ReturnType<CsvFileProbe>['encoding']; delimiter: string; }[] = [];

async function fixture(
  name: string,
  pattern: Buffer,
  encoding: ReturnType<CsvFileProbe>['encoding'],
  delimiter: string,
  repeats: number,
  bom?: Buffer,
) {
  const path = join(directory, `${name}.txt`);
  const data = Buffer.alloc(pattern.length * repeats, pattern);
  await Bun.write(path, bom === undefined ? data : Buffer.concat([bom, data]));
  inputs.push({ name, path, encoding, delimiter });
}

await fixture('tiny ASCII', Buffer.from('1,Ada,Brazil\n'), 'utf8', ',', 8);
await fixture('short ASCII rows', Buffer.from('123,Lisbon,Portugal\n'), 'utf8', ',', 120_000);
await fixture('wide quoted UTF-8', Buffer.from(`1;"${'São,東京 ""city""\n'.repeat(45)}";BR\r\n`), 'utf8', ';', 2300);
await fixture('Windows-1252', Buffer.from('1;\x93caf\xe9\x94;\x80\n', 'latin1'), 'windows-1252', ';', 200_000);
await fixture('UTF-16LE TSV', Buffer.from('1\tSão Paulo\tBR\r\n', 'utf16le'), 'utf-16le', '\t', 68_000, Buffer.from([0xff, 0xfe]));
const corpus = 'corpus/large/example.csv';
if (await Bun.file(corpus).exists()) {
  inputs.push({ name: 'Latin-1 corpus', path: corpus, encoding: 'latin1', delimiter: ';' });
}

const implementations = ['baseline', 'Highway'] as const;
for (const { name, path, delimiter, encoding } of inputs) {
  const chunks = name === 'Latin-1 corpus' || name === 'wide quoted UTF-8' ? [64 * 1024, 1024 * 1024] : [1024 * 1024];
  for (const chunkSize of chunks) {
    const options = { delimiter: 'auto', encoding: 'auto', chunkSize } as const;
    // Warm the filesystem and verify the whole batch against an explicitly configured parse.
    const control = csv.rows(path, { encoding, delimiter, chunkSize });
    const first = await control.next();
    await control.return();
    assert.ok(!first.done && first.value.length > 0);
    const order = process.env['CSV_PROBE_REVERSE'] === '1' ? implementations.toReversed() : implementations;
    for (const implementation of order) {
      const open = implementation === 'Highway'
        ? () => csv.rows(path, options)
        : () => iterateRows(path, snapshotCsvOptions(options), referenceProbe);
      const check = open();
      try {
        assert.deepEqual((await check.next()).value, first.value);
      } finally {
        await check.return();
      }
      const label = `${name} ${chunkSize / 1024}KiB ${implementation}`;
      bench(label, function*() {
        const times: number[] = [];
        yield {
          async manual() {
            const start = Bun.nanoseconds();
            const rows = open();
            try {
              const batch = await rows.next();
              const elapsed = Bun.nanoseconds() - start;
              assert.ok(!batch.done && batch.value.length === first.value.length);
              times.push(elapsed);
              return elapsed;
            } finally {
              await rows.return();
            }
          },
        };
        times.sort((a, b) => a - b);
        const lower = times[Math.floor((times.length - 1) / 2)];
        const upper = times[Math.floor(times.length / 2)];
        assert.ok(lower !== undefined && upper !== undefined);
        console.info(JSON.stringify({ label, calls: times.length, medianUs: (lower + upper) / 2000 }));
      });
    }
  }
}
