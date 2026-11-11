import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
} from './config.ts';

/**
 * Count all rows, then demonstrate native filter conditions supported by
 * `count()`. Counting does not materialize row arrays, so it is the preferred
 * API when only the cardinality is needed.
 */
const baseOptions = {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
};

// With no `where` clause, every parsed record contributes to the result.
console.log({
  rows: await csv.count(FILE, baseOptions),
});

if (FILTER_VALUE !== undefined) {
  const filterColumn = csv.column(FILTER_COLUMN);
  const equals = filterColumn.equals(FILTER_VALUE);
  const equalsOrEmpty = csv.any(equals, filterColumn.equals(''));
  const composed = csv.all(equalsOrEmpty, csv.not(filterColumn.equals('')));

  console.log({
    // Filter columns are zero-based physical indexes in the source CSV.
    equals: await csv.count(FILE, {
      ...baseOptions,
      where: equals,
    }),
    doesNotEqual: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.doesNotEqual(FILTER_VALUE),
    }),
    // Prefix matching compares encoded field bytes without allocating a
    // JavaScript string for every candidate row.
    startsWith: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.startsWith(FILTER_VALUE),
    }),
    // `isOneOf` matches several exact values in one scan. This one-element input
    // intentionally makes its result directly comparable to `equals`.
    isOneOf: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.isOneOf([FILTER_VALUE]),
    }),
    isNoneOf: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.isNoneOf([FILTER_VALUE]),
    }),
    hasMatch: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.hasMatch(new RegExp(`^${escapeRegExp(FILTER_VALUE)}$`, 'u')),
    }),
    // Boolean groups are immutable and reusable across row and count APIs.
    composed: await csv.count(FILE, {
      ...baseOptions,
      where: composed,
    }),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
