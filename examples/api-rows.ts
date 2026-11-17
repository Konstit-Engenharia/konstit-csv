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
 * Stream materialized rows with projection and an optional equality filter.
 *
 * The parser is permissive by default: rows may have different field counts.
 * Select strict mode when malformed CSV or schema mismatches must reject the
 * operation; see `api-strict-options.ts` for that contract.
 */
const options = {
  // `chunkSize` controls file-read granularity. It is not a row-count limit,
  // and quoted records may span more than one input chunk.
  chunkSize: CHUNK_SIZE,
  // Projection preserves this order and decodes only these physical columns.
  columns: COLUMNS,
  delimiter: DELIMITER,
  // Filters always address a physical source column, even when that column is
  // absent from the projected output.
  where: FILTER_VALUE === undefined ? undefined : csv.column(FILTER_COLUMN).equals(FILTER_VALUE),
  // Limit the total number of rows yielded, regardless of batch size.
  limit: LIMIT,
};

// Every yielded value is the set of rows materialized from a parsed batch.
// Consume one batch at a time to avoid retaining the entire file in memory.
for await (const batch of csv.rows(FILE, options)) {
  for (const row of batch) {
    console.log(row);
  }
}
