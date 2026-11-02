import {
  MAX_FILTER_COUNT,
  MAX_PROJECTION_LENGTH,
} from './normalize.js';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvFieldValue,
  CsvNativeFilter,
  CsvNativeProjectionOptions,
} from './types.js';

const snapshots = new WeakSet<object>();

/** Own the mutable option values while retaining opaque immutable filter handles. */
export function snapshotCsvOptions<TOptions extends CsvApiFileOptions & CsvNativeProjectionOptions>(options: TOptions): TOptions {
  if (snapshots.has(options)) {
    return options;
  }
  const captured = { ...options };
  if (captured.filters !== undefined && captured.filters.length > MAX_FILTER_COUNT) {
    throw new RangeError(`filter count out of range: ${captured.filters.length}`);
  }
  const snapshot = Object.freeze({
    ...captured,
    columns: snapshotColumns(captured.columns),
    selectedColumns: snapshotColumns(captured.selectedColumns),
    expectedHeaders: captured.expectedHeaders === undefined ? undefined : Object.freeze([...captured.expectedHeaders]),
    compression: typeof captured.compression === 'object' && captured.compression !== null
      ? Object.freeze({ ...captured.compression })
      : captured.compression,
    equalsFilter: captured.equalsFilter === undefined
      ? undefined
      : Object.freeze({ ...captured.equalsFilter, value: copyFieldValue(captured.equalsFilter.value) }),
    filters: captured.filters === undefined ? undefined : Object.freeze(captured.filters.map(snapshotNativeFilter)),
  });
  snapshots.add(snapshot);
  return snapshot;
}

function snapshotColumns(columns: CsvColumns | undefined): CsvColumns | undefined {
  if (columns === undefined) {
    return undefined;
  }
  if (columns.length > MAX_PROJECTION_LENGTH) {
    throw new RangeError(`selected column count out of range: ${columns.length}`);
  }
  return Object.freeze([...columns]);
}

function snapshotNativeFilter(filter: CsvNativeFilter): CsvNativeFilter {
  if ('value' in filter) {
    return Object.freeze({ ...filter, value: copyFieldValue(filter.value) });
  }
  if ('values' in filter) {
    return Object.freeze({ ...filter, values: Object.freeze(filter.values.map(copyFieldValue)) });
  }
  if ('notEquals' in filter) {
    return Object.freeze({ ...filter, notEquals: copyFieldValue(filter.notEquals) });
  }
  if ('notIn' in filter) {
    return Object.freeze({ ...filter, notIn: Object.freeze(filter.notIn.map(copyFieldValue)) });
  }
  if ('prefix' in filter) {
    return Object.freeze({ ...filter, prefix: copyFieldValue(filter.prefix) });
  }
  return Object.freeze({ ...filter, regex: Object.freeze({ ...filter.regex }) });
}

function copyFieldValue(value: CsvFieldValue): CsvFieldValue {
  if (typeof value === 'string') {
    return value;
  }
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('filter value must be a string, Buffer, or Uint8Array');
  }
  return new Uint8Array(value);
}
