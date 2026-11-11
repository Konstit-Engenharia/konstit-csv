import {
  normalizeFilterColumn,
  normalizeNativeFilterProgram,
  validateRegex,
} from './normalize.js';
import type {
  CsvNativeFilterOperator,
  CsvNativeFilterProgramEntry,
} from './normalize.js';
import type {
  CsvFieldValue,
  CsvFilter,
  CsvFilterColumn,
  CsvNativeFilter,
  CsvRegex,
} from './types.js';

const nativeProgramByFilter = new WeakMap<object, readonly CsvNativeFilterProgramEntry[]>();

/**
 * Select a reusable zero-based physical CSV column for building native filters.
 *
 * The returned column exposes predicate methods such as `equals()` and `hasMatch()`. Predicate
 * operands are copied when the filter is created, so later mutation of a `Buffer`, `Uint8Array`,
 * or values array cannot change the filter. A selected column can be reused to create many
 * independent filters.
 *
 * @param columnIndex - Zero-based physical column index, from 0 through 2024.
 * @returns An immutable column predicate builder.
 * @throws {RangeError} If `columnIndex` is not an integer in the supported range.
 *
 * @example
 * ```ts
 * const state = csv.column(2);
 * const filter = state.isOneOf(['SP', 'RJ']);
 * ```
 */
export function column(columnIndex: number): CsvFilterColumn {
  const selectedColumn = normalizeFilterColumn(columnIndex);
  return Object.freeze({
    equals: (value: CsvFieldValue) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, value: copyFieldValue(value, 'equals value') }),
      ),
    doesNotEqual: (value: CsvFieldValue) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, notEquals: copyFieldValue(value, 'doesNotEqual value') }),
      ),
    isOneOf: (values: readonly CsvFieldValue[]) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, values: copyFieldValues(values, 'isOneOf values') }),
      ),
    isNoneOf: (values: readonly CsvFieldValue[]) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, notIn: copyFieldValues(values, 'isNoneOf values') }),
      ),
    startsWith: (prefix: CsvFieldValue) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, prefix: copyFieldValue(prefix, 'startsWith prefix') }),
      ),
    hasMatch: (pattern: RegExp) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, regex: re(pattern) }),
      ),
  });
}

/**
 * Match rows for which every supplied filter matches.
 *
 * Groups can be nested, and the resulting filter can be reused for both rows and counts.
 * A missing physical column remains unknown under negation.
 *
 * @param first - First filter in the group.
 * @param rest - Additional filters that must also match.
 * @returns An immutable conjunction filter.
 * @throws {RangeError} If no filter is supplied.
 * @throws {TypeError} If any filter was not created by this filter API.
 */
export function all(first: CsvFilter, ...rest: readonly CsvFilter[]): CsvFilter {
  return combineFilters('all', first, rest);
}

/**
 * Match rows for which at least one supplied filter matches.
 *
 * Groups can be nested, and the resulting filter can be reused for both rows and counts.
 * Another matching child can satisfy the group when one child's column is missing.
 *
 * @param first - First filter in the group.
 * @param rest - Additional filters, any one of which may match.
 * @returns An immutable disjunction filter.
 * @throws {RangeError} If no filter is supplied.
 * @throws {TypeError} If any filter was not created by this filter API.
 */
export function any(first: CsvFilter, ...rest: readonly CsvFilter[]): CsvFilter {
  return combineFilters('any', first, rest);
}

/**
 * Negate one native filter.
 *
 * The resulting filter preserves the evaluator's unknown result for a missing column. Use this
 * with filters created by {@link column}, {@link all}, or {@link any}; filters are immutable and
 * safe to reuse across operations.
 *
 * @param filter - Filter to negate.
 * @returns An immutable negation filter.
 * @throws {TypeError} If `filter` was not created by this filter API.
 */
export function not(filter: CsvFilter): CsvFilter {
  const program = requireNativeProgram(filter, 'csv.not() filter');
  return createFilter([
    ...program,
    Object.freeze({ operandCount: 1, operator: 'not' } satisfies CsvNativeFilterOperator),
  ]);
}

/**
 * Validate and brand a JavaScript regular expression for native matching.
 *
 * Validation happens immediately using the parser's RE2-compatible engine. Supported flags are
 * `i`, `m`, `s`, and `u`; global, sticky, indices, and `v` flags are rejected. The returned
 * branded descriptor is used by low-level `CsvRegexFilter` values; `CsvFilterColumn.hasMatch()`
 * accepts a `RegExp` and creates this descriptor internally.
 *
 * @param pattern - JavaScript regular expression to validate and copy.
 * @returns An immutable validated regular expression descriptor.
 * @throws {TypeError} If `pattern` is not a `RegExp`.
 * @throws {SyntaxError} If the pattern is invalid for the native RE2 engine.
 * @throws {Error} If the expression uses unsupported flags.
 * @throws {RangeError} If the UTF-8 pattern exceeds the native size limit.
 */
export function re(pattern: RegExp): CsvRegex {
  if (!(pattern instanceof RegExp)) {
    throw new TypeError('csv.re() requires a RegExp');
  }
  const regex = {
    flags: pattern.flags,
    source: pattern.source,
  };
  validateRegex(regex);
  return Object.freeze(regex) as CsvRegex;
}

/**
 * Resolve the native program associated with an opaque filter handle.
 *
 * This internal bridge lets the high-level API translate a `where` filter while preserving
 * identity-based validation. It is not part of the package root API; callers should pass filters
 * directly to `where` instead.
 *
 * @internal
 * @param filter - Filter created by this module, or `undefined` when no filter is configured.
 * @returns The immutable native filter program, or `undefined` when no filter is supplied.
 * @throws {TypeError} If a non-native or foreign filter object is supplied.
 */
export function nativeFilterProgramFor(filter: CsvFilter | undefined): readonly CsvNativeFilterProgramEntry[] | undefined {
  if (filter === undefined) {
    return undefined;
  }
  return requireNativeProgram(filter, 'where');
}

function combineFilters(
  operator: 'all' | 'any',
  first: CsvFilter,
  rest: readonly CsvFilter[],
): CsvFilter {
  if (first === undefined) {
    throw new RangeError(`csv.${operator}() requires at least one filter`);
  }
  const filters = [first, ...rest];
  const program = filters.flatMap((filter, index) => requireNativeProgram(filter, `csv.${operator}() filter ${index}`));
  program.push(Object.freeze({ operandCount: filters.length, operator }));
  return createFilter(program);
}

function createFilterFromPredicate(predicate: CsvNativeFilter): CsvFilter {
  return createFilter([predicate]);
}

function createFilter(program: readonly CsvNativeFilterProgramEntry[]): CsvFilter {
  normalizeNativeFilterProgram(program);
  const filter = Object.freeze({}) as CsvFilter;
  nativeProgramByFilter.set(filter, Object.freeze([...program]));
  return filter;
}

function requireNativeProgram(filter: CsvFilter, label: string): readonly CsvNativeFilterProgramEntry[] {
  const program = typeof filter === 'object' && filter !== null ? nativeProgramByFilter.get(filter) : undefined;
  if (program === undefined) {
    throw new TypeError(`${label} must be created with csv.column(), csv.all(), csv.any(), or csv.not()`);
  }
  return program;
}

function copyFieldValues(values: readonly CsvFieldValue[], label: string): readonly CsvFieldValue[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (values.length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
  return Object.freeze(values.map((value, index) => copyFieldValue(value, `${label}[${index}]`)));
}

function copyFieldValue(value: CsvFieldValue, label: string): CsvFieldValue {
  if (typeof value === 'string') {
    return value;
  }
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a string, Buffer, or Uint8Array`);
  }
  return Buffer.from(value);
}
