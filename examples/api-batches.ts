import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  COLUMNS,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
  LIMIT,
} from './config.ts';

/**
 * Inspect native batches and zero-copy row views.
 *
 * Use this API when materializing every field as a JavaScript string would be
 * wasteful. Row views and byte views are borrowed from the current batch; copy
 * anything that must survive after the callback returns. Numeric ranges remain
 * values, but only describe offsets within that batch's data.
 */
let printed = 0;

for await (
  using batch of csv.batches(FILE, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    // High-level filters run before rows are exposed through the native batch.
    where: FILTER_VALUE === undefined ? undefined : csv.column(FILTER_COLUMN).equals(FILTER_VALUE),
    // Limit the total number of rows yielded, regardless of batch size.
    limit: LIMIT,
  })
) {
  // The row view is reused as iteration advances. Copy data that must outlive
  // this callback or the current batch.
  batch.forEachRow((row) => {
    console.log({
      // `rowIndex` is local to this batch, not a file-global row number.
      rowIndex: row.rowIndex,
      fieldCount: row.fieldCount,
      // `pick()` accepts zero-based physical source-column indexes and only
      // decodes the requested fields. A missing field becomes an empty string.
      values: row.pick(COLUMNS),
      // `bytes()` avoids UTF-8 decoding. It returns a borrowed view into the
      // batch, so only inspect or copy it while this callback is active.
      firstFieldBytes: row.bytes(COLUMNS[0] ?? 0)?.byteLength ?? 0,
      // Ranges are half-open byte offsets [start, end) within batch data.
      firstFieldRange: row.range(COLUMNS[0] ?? 0),
    });
    ++printed;
  });
  if (printed >= LIMIT) {
    break;
  }
}
