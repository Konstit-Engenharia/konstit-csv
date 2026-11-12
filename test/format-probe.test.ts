import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  highwayProbe,
  referenceProbe,
} from '../bench/probe/probes.ts';
import { iterateRows } from '../src/api.ts';
import type { CsvFileProbe } from '../src/file-stream.ts';

const probes = [referenceProbe, highwayProbe];
const prefix = Buffer.from('1,2\n'.repeat(128));

// Let the platform decoder independently decide whether a possibly truncated
// UTF-8 suffix is legal. Prefix rows isolate encoding from delimiter scoring.
function checkEncoding(tail: Buffer, eof: boolean) {
  const bytes = Buffer.concat([prefix, tail]);
  let expected = 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !eof });
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    expected = tail.some((byte) => byte >= 0x80 && byte <= 0x9f) ? 'windows-1252' : 'latin1';
  }
  for (const probe of probes) {
    assert.equal(probe('file.csv', bytes, eof, 'auto').encoding, expected, tail.toString('hex'));
  }
}

test('UTF-8 classification agrees with fatal decoding across vector and sample boundaries', () => {
  for (const n of [0, 1, 13, 14, 15, 16, 29, 30, 31, 32, 63, 64, 65_020]) {
    for (const hex of ['c2a2', 'e0a080', 'eda080', 'ed9fbf', 'f0908080', 'f48fbfbf', 'f4908080', 'f0808080', 'c080', 'ff', '8080']) {
      const chars = Buffer.from(hex, 'hex');
      for (let k = 1; k <= chars.length; ++k) {
        const tail = Buffer.concat([Buffer.alloc(n, 0x61), chars.subarray(0, k)]);
        checkEncoding(tail, true);
        checkEncoding(tail, false);
      }
    }
  }

  let seed = 4271;
  function next() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 16;
  }
  for (let i = 0; i < 1000; ++i) {
    const tail = Buffer.alloc(next() % 120);
    for (let k = 0; k < tail.length; ++k) {
      tail[k] = 1 + (next() % 255);
    }
    checkEncoding(tail, i % 2 === 0);
  }
});

function outcome(probe: CsvFileProbe, path: string, bytes: Buffer, eof: boolean) {
  try {
    return probe(path, bytes, eof, 'auto');
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return error.message;
  }
}

test('combined delimiter scoring matches delimiter-only scoring across truncated records', () => {
  for (const delimiter of [',', '\t', ';', '|', ':', '^', '~']) {
    const bytes = Buffer.from(`a${delimiter}b\r\n\n123${delimiter}"quoted,;\r\n""text"""\n4${delimiter}5`);
    for (let end = 0; end <= bytes.length; ++end) {
      for (const eof of [false, true]) {
        const slice = bytes.subarray(0, end);
        assert.deepEqual(outcome(highwayProbe, 'file.data', slice, eof), outcome(referenceProbe, 'file.data', slice, eof));
      }
    }
  }
  for (
    const [path, input,] of [
      ['tie.csv', 'a,b;c\nx,y;z'],
      ['tie.data', 'a,b;c\nx,y;z'],
      ['strong.data', 'a|b|c,d\nx|y|z,t'],
      ['empty.csv', ''],
      ['unstable.csv', 'a,b\na,b,c\n'],
      ['no-rows.csv', '\r\n\n'],
      ['limit.csv', `${'a,b\n'.repeat(128)}a;b\n`],
      ['short.csv', 'x'.repeat(65_536)],
      ['binary.csv', 'a,b\n\0'],
      ['utf32.data', '\xff\xfe\x00\x00'],
      ['utf32be.data', '\x00\x00\xfe\xff'],
    ] as const
  ) {
    const bytes = Buffer.from(input, 'latin1');
    assert.deepEqual(outcome(highwayProbe, path, bytes, true), outcome(referenceProbe, path, bytes, true));
  }
});

test('both probed streams replay the original bytes through the selected decoder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-probe-check-'));
  try {
    const utf16 = Buffer.from('\ufeffid\tname\r\n1\t"São\n東京😀"\r\n', 'utf16le');
    const cases = [
      [Buffer.from('\ufeffid;name\n1;café\n'), 'café'],
      [Buffer.from('id;name\n1;caf\xe9\n', 'latin1'), 'café'],
      [Buffer.from('id;name\n1;\x93caf\xe9\x94\n', 'latin1'), '“café”'],
      [utf16, 'São\n東京😀'],
      [Buffer.from(utf16).swap16(), 'São\n東京😀'],
    ] as const;
    const path = join(directory, 'input.txt');
    for (const [bytes, value,] of cases) {
      await Bun.write(path, bytes);
      for (const probe of probes) {
        for (const chunkSize of [1, 7, 1024 * 1024]) {
          const actual = [];
          for await (const batch of iterateRows(path, { delimiter: 'auto', encoding: 'auto', chunkSize }, probe)) {
            actual.push(...batch);
          }
          assert.deepEqual(actual, [['id', 'name'], ['1', value]]);
        }
      }
    }
    // The sample cuts the last scalar after its first byte, between read-ahead buffers.
    const field = `${'x'.repeat(65_536 - Buffer.byteLength('a,b\n1,') - 1)}😀`;
    await Bun.write(path, `a,b\n1,${field}\n2,last\n`);
    for (const probe of probes) {
      const actual = [];
      for await (const batch of iterateRows(path, { delimiter: 'auto', encoding: 'auto', chunkSize: 997 }, probe)) {
        actual.push(...batch);
      }
      assert.deepEqual(actual, [['a', 'b'], ['1', field], ['2', 'last']]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
