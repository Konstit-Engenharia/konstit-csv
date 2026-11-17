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

// `csv.rows()` owns file reads, parser finalization, and native batch cleanup.
// It yields one materialized row batch at a time.
const where = FILTER_VALUE === undefined ? undefined : csv.column(FILTER_COLUMN).equals(FILTER_VALUE);

for await (
  const rows of csv.rows(FILE, {
    columns: COLUMNS,
    delimiter: DELIMITER,
    where,
    limit: LIMIT,
  })
) {
  for (const row of rows) {
    console.log(row);
  }
}
