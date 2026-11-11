import { bench } from 'mitata';
import { NativeCsvParser } from '../src/index.ts';

// A single count can avoid allocating offset views. Two counts include the cost of building the view on demand.
// Scanning a batch exercises repeated lookups both with and without the cost of parsing.
for (const rowCount of [1, 256]) {
  const input = Buffer.from(Array.from({ length: rowCount }, (_, i) => i % 2 === 0 ? 'a,b\n' : 'a,b,c\n').join(''));
  for (const lookups of rowCount === 1 ? [1, 2] : [1, 2, rowCount]) {
    const expected = rowCount === 1 ? 2 * lookups : 2 * lookups + Math.floor(lookups / 2);
    bench(`fresh / rows=${rowCount} / lookups=${lookups}`, function*() {
      using parser = new NativeCsvParser();
      yield () => {
        using batch = parser.writeBatch(input);
        let fields = 0;
        for (let i = 0; i < lookups; ++i) {
          fields += batch.rowFieldCount(i % rowCount);
        }
        if (fields !== expected) {
          throw new Error(`unexpected field count: ${fields}`);
        }
      };
    });
  }
}

bench('cached / rows=256 / lookups=256', function*() {
  using parser = new NativeCsvParser();
  using batch = parser.writeBatch(Buffer.from('a,b\na,b,c\n'.repeat(128)), true);
  batch.fieldRange(0, 0);
  yield () => {
    let fields = 0;
    for (let i = 0; i < 256; ++i) {
      fields += batch.rowFieldCount(i);
    }
    if (fields !== 640) {
      throw new Error(`unexpected field count: ${fields}`);
    }
  };
});
