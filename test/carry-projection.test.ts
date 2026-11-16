import {
  describe,
  expect,
  test,
} from 'bun:test';
import { NativeCsvParser } from '../src/index.ts';
import type { NativeCsvBatch } from '../src/index.ts';

function completedRows(batch: NativeCsvBatch): string[][] {
  const rows = batch.rows();
  const fields = rows.flat();
  expect(batch.rowCount).toBe(rows.length);
  expect(batch.totalFields).toBe(fields.length);
  expect(batch.data().toString()).toBe(fields.join(''));
  expect([...batch.rowOffsets()]).toHaveLength(rows.length + 1);
  expect([...batch.fieldOffsets()]).toHaveLength(fields.length + 1);
  expect(batch.rowOffsets().at(-1)).toBe(BigInt(fields.length));
  expect(batch.fieldOffsets().at(-1)).toBe(BigInt(batch.data().byteLength));
  return rows;
}

describe('projected rows carried across batches', () => {
  test('combines field offsets across three writes with empty fields on both sides of a split', () => {
    using parser = new NativeCsvParser({ columns: [0, 1, 3, 4] });
    using first = parser.writeBatch(Buffer.from('prev,p,ignored,q,r\n,'));
    expect(completedRows(first)).toEqual([['prev', 'p', 'q', 'r']]);

    using middle = parser.writeBatch(Buffer.from('prefix,ignored,'));
    expect(completedRows(middle)).toEqual([]);
    using last = parser.writeBatch(Buffer.from(',suffix\nnext,x,ignored,y,z\n'), true);
    expect(completedRows(last)).toEqual([['', 'prefix', '', 'suffix'], ['next', 'x', 'y', 'z']]);
    expect([...last.fieldOffsets()]).toEqual([0n, 0n, 6n, 6n, 12n, 16n, 17n, 18n, 19n]);
    expect([...last.rowOffsets()]).toEqual([0n, 4n, 8n]);
  });

  test('keeps completed selected fields across ignored tails and pads missing columns', () => {
    const text = `João,unused,"café ""quoted""\nnext",tail,Érico,"${'ignored'.repeat(29)}"\r\n`
      + ',,,"unselected\nline",,\nlast,unused';
    for (const encoding of ['utf8', 'iso88591'] as const) {
      const input = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'latin1');
      for (const chunkSize of [1, 2, 3, 17, 64, input.byteLength]) {
        using parser = new NativeCsvParser({ encoding, columns: [0, 2, 4] });
        const rows: string[][] = [];
        for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
          using batch = parser.writeBatch(input.subarray(offset, offset + chunkSize));
          rows.push(...completedRows(batch));
        }
        using final = parser.endBatch();
        rows.push(...completedRows(final));
        expect(rows).toEqual([
          ['João', 'café "quoted"\nnext', 'Érico'],
          ['', '', ''],
          ['last', '', ''],
        ]);
      }
    }
  });

  test('carries all fields when filtering without a projection', () => {
    const tail = 'x'.repeat(131);
    const text = `one,"café\nline",${tail},keep\r\nrejected,"hidden ""quote""",${tail},drop\n`
      + 'two,,last,keep';
    for (const encoding of ['utf8', 'iso88591'] as const) {
      const input = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'latin1');
      for (const chunkSize of [1, 7, 32, input.byteLength]) {
        using parser = new NativeCsvParser({ encoding, equalsFilter: { column: 3, value: 'keep' } });
        const rows: string[][] = [];
        for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
          using batch = parser.writeBatch(input.subarray(offset, offset + chunkSize));
          rows.push(...completedRows(batch));
        }
        using final = parser.endBatch();
        rows.push(...completedRows(final));
        expect(rows).toEqual([
          ['one', 'café\nline', tail, 'keep'],
          ['two', '', 'last', 'keep'],
        ]);
      }
    }
  });

  test('rolls back a carried row rejected by a later field', () => {
    using parser = new NativeCsvParser({ columns: [0, 1], equalsFilter: { column: 3, value: 'keep' } });
    using first = parser.writeBatch(Buffer.from('first,"kept ""one""",pass,keep\r\nreject,"drop é",part'));
    expect(completedRows(first)).toEqual([['first', 'kept "one"']]);

    using middle = parser.writeBatch(Buffer.from('ial'));
    expect(completedRows(middle)).toEqual([]);
    using empty = parser.writeBatch(Buffer.alloc(0));
    expect(completedRows(empty)).toEqual([]);

    using next = parser.writeBatch(Buffer.from(',drop\r\nsecond,"kept\nline",tail,keep\r'));
    expect(completedRows(next)).toEqual([['second', 'kept\nline']]);
    using missingFilter = parser.writeBatch(Buffer.from('\nrejected,missing'));
    expect(completedRows(missingFilter)).toEqual([]);
    using final = parser.endBatch();
    expect(completedRows(final)).toEqual([]);
    expect(completedRows(first)).toEqual([['first', 'kept "one"']]);
    expect(completedRows(next)).toEqual([['second', 'kept\nline']]);
  });

  test('clears a carried row on reset and restores row selection', () => {
    using parser = new NativeCsvParser({ columns: [0, 2], skipRows: 1, limit: 1 });
    using incomplete = parser.writeBatch(Buffer.from('header,ignored,value\r\nold,ignored,discarded,"unfinished'));
    expect(completedRows(incomplete)).toEqual([]);
    parser.reset();

    using header = parser.writeBatch(Buffer.from('new,ignored,header\n'));
    expect(completedRows(header)).toEqual([]);
    using row = parser.writeBatch(Buffer.from('fresh,ignored,kept,"tail'));
    expect(completedRows(row)).toEqual([]);
    using final = parser.writeBatch(Buffer.from(' end"\nextra,ignored,row\n'), true);
    expect(completedRows(final)).toEqual([['fresh', 'kept']]);
  });

  test('returned batch buffers remain owned independently of later writes and parser lifetime', () => {
    using parser = new NativeCsvParser({ columns: [0, 2, 5] });
    using first = parser.writeBatch(Buffer.from('one,unused,two,unused,unused,six\r\ncarry,unused,third,"'));
    const firstData = first.data();
    const firstRowOffsets = first.rowOffsets();
    const firstFieldOffsets = first.fieldOffsets();
    expect(completedRows(first)).toEqual([['one', 'two', 'six']]);

    for (const part of ['long ', 'unselected\n', 'tail ', 'across ', 'chunks']) {
      using middle = parser.writeBatch(Buffer.from(part));
      expect(completedRows(middle)).toEqual([]);
    }
    using second = parser.writeBatch(Buffer.from('",unused,last\nnext,unused,value'));
    const secondData = second.data();
    expect(completedRows(second)).toEqual([['carry', 'third', 'last']]);
    using final = parser.endBatch();
    expect(completedRows(final)).toEqual([['next', 'value', '']]);
    parser.close();

    expect(firstData.toString()).toBe('onetwosix');
    expect([...firstRowOffsets]).toEqual([0n, 3n]);
    expect([...firstFieldOffsets]).toEqual([0n, 3n, 6n, 9n]);
    expect(secondData.toString()).toBe('carrythirdlast');
    expect(completedRows(first)).toEqual([['one', 'two', 'six']]);
    expect(completedRows(second)).toEqual([['carry', 'third', 'last']]);
    expect(completedRows(final)).toEqual([['next', 'value', '']]);
  });
});
