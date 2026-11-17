import { csv } from '../src/index.ts';
import {
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
  const batch of csv.rows(FILE, {
    columns: COLUMNS,
    delimiter: DELIMITER,
    where,
    limit: LIMIT,
  })
) {
  for (const row of batch) {
    console.log(row);
  }
}
