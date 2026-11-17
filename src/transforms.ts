import {
  native,
  type NativePointer,
} from './native.js';
import {
  MAX_COLUMN_INDEX,
  normalizeColumnIndex,
} from './normalize.js';
import type {
  CsvColumns,
  CsvTransform,
  CsvTransformChain,
  CsvTransformMethods,
} from './types.js';

// Operation codes are shared with native/field_transforms.hpp.
enum Op {
  Trim,
  Upper,
  Lower,
  Unaccent,
  ReplaceAll,
  Map,
  DateYmd,
  DateDmy,
}
type Step =
  | { kind: Op.Trim | Op.Upper | Op.Lower | Op.Unaccent; }
  | { kind: Op.ReplaceAll; search: string; replacement: string; }
  | { kind: Op.DateYmd | Op.DateDmy; defaultValue: string | undefined; }
  | { kind: Op.Map; values: ReadonlyMap<string, string>; defaultValue: string | undefined; };

interface Chain {
  step: Step;
  previous: Chain | undefined;
}

interface Binding {
  chain: Chain;
  columns: readonly number[];
}

const bindings = new WeakMap<CsvTransformChain, Binding>();

/** Start a reusable chain. Choose physical columns after defining its steps. */
export function transform(): CsvTransformMethods<CsvTransformChain> {
  return Object.freeze(methods((step) => createChain({ step, previous: undefined })));
}

export function transformMethods(column: number): CsvTransformMethods {
  return methods((step) => createChain({ step, previous: undefined }, [column]));
}

// A token is a bound CsvTransform precisely when it is registered in bindings.
function createChain(chain: Chain, columns: readonly number[]): CsvTransform;
function createChain(chain: Chain, columns?: readonly number[]): CsvTransformChain;
function createChain(chain: Chain, columns?: readonly number[]): CsvTransformChain {
  const token = Object.freeze({
    ...methods((step) => createChain({ step, previous: chain }, columns)),
    on: (...targets: [number, ...number[]]) => {
      if (!targets.length) {
        throw new RangeError('on() requires at least one transform column');
      }
      if (targets.length > MAX_COLUMN_INDEX + 1) {
        throw new RangeError('too many transform columns');
      }
      const seen = new Set<number>();
      for (const column of targets) {
        normalizeColumnIndex(column, 'transform column');
        if (seen.has(column)) {
          throw new RangeError(`transform column repeated: ${column}`);
        }
        seen.add(column);
      }
      return createChain(chain, targets);
    },
  });
  if (columns !== undefined) {
    bindings.set(token, { chain, columns });
  }
  return token;
}

function methods<T>(append: (step: Step) => T): CsvTransformMethods<T> {
  return {
    trim: () => append({ kind: Op.Trim }),
    upper: () => append({ kind: Op.Upper }),
    lower: () => append({ kind: Op.Lower }),
    unaccent: () => append({ kind: Op.Unaccent }),
    replaceAll: (search, replacement) => {
      requireText(search);
      requireText(replacement);
      if (search.length === 0) {
        throw new RangeError('replaceAll search must not be empty');
      }
      return append({ kind: Op.ReplaceAll, search, replacement });
    },
    map: (values, defaultValue) => {
      if (defaultValue !== undefined) {
        requireText(defaultValue);
      }
      const captured = new Map<string, string>();
      for (const [key, value,] of mappingEntries(values)) {
        requireText(key);
        requireText(value);
        captured.set(key, value);
      }
      return append({ kind: Op.Map, values: captured, defaultValue });
    },
    date: (format, defaultValue) => {
      if (format !== 'YYYY-MM-DD' && format !== 'DD-MM-YYYY') {
        throw new TypeError('date() format must be YYYY-MM-DD or DD-MM-YYYY');
      }
      if (defaultValue !== undefined) {
        requireText(defaultValue);
      }
      return append({ kind: format === 'YYYY-MM-DD' ? Op.DateYmd : Op.DateDmy, defaultValue });
    },
  };
}

function mappingEntries(values: ReadonlyMap<string, string> | Readonly<Record<string, string>>): Iterable<readonly [string, string]> {
  if (values !== null && typeof values === 'object') {
    if (typeof values.get === 'function' && typeof values.entries === 'function') {
      return values.entries();
    }
    const prototype = Object.getPrototypeOf(values);
    if (prototype === null || Object.getPrototypeOf(prototype) === null) {
      return Object.entries(values);
    }
  }
  throw new TypeError('map() requires a map or plain object of strings');
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw new TypeError('transform operands must be well-formed strings');
  }
}

export function snapshotTransforms(transforms: readonly CsvTransform[] | undefined): readonly CsvTransform[] | undefined {
  if (transforms === undefined) {
    return undefined;
  }
  if (!Array.isArray(transforms)) {
    throw new TypeError('transform must be an array of column transforms');
  }
  if (transforms.length > MAX_COLUMN_INDEX + 1) {
    throw new RangeError('too many transform columns');
  }
  const captured: CsvTransform[] = [...transforms];
  const seen = new Set<number>();
  for (const token of captured) {
    const binding = bindings.get(token);
    if (!binding) {
      throw new TypeError('transform requires a bound chain; call chain.on(column) or start with csv.column(column)');
    }
    for (const column of binding.columns) {
      if (seen.has(column)) {
        throw new RangeError(`transform column repeated: ${column}`);
      }
      seen.add(column);
    }
  }
  return Object.freeze(captured);
}

/** Strict row projection happens after full-width validation and transformation. */
export function selectTransforms(tokens: readonly CsvTransform[], columns: CsvColumns): readonly CsvTransform[] {
  const selected = new Set(columns);
  const result: CsvTransform[] = [];
  for (const token of tokens) {
    const binding = bindings.get(token);
    if (!binding) {
      throw new TypeError('expected a bound transform chain');
    }
    const targets = binding.columns.filter((column) => selected.has(column));
    if (targets.length) {
      result.push(targets.length === binding.columns.length ? token : createChain(binding.chain, targets));
    }
  }
  return result;
}

/** Copy each selected chain into its parser. Native writes never reference caller-owned data. */
export function prepareTransforms(handle: NativePointer, tokens: readonly CsvTransform[], selected: CsvColumns | undefined): boolean {
  const columns = selected === undefined ? undefined : new Set(selected);
  let active = false;
  for (const token of tokens) {
    const binding = bindings.get(token);
    if (!binding) {
      throw new TypeError('expected a bound transform chain');
    }
    const targets = columns ? binding.columns.filter((column) => columns.has(column)) : binding.columns;
    if (!targets.length) {
      continue;
    }
    const steps: Step[] = [];
    for (let node: Chain | undefined = binding.chain; node; node = node.previous) {
      steps.push(node.step);
    }
    steps.reverse();
    for (const column of targets) {
      for (const step of steps) {
        const fallback = 'defaultValue' in step && step.defaultValue !== undefined ? Buffer.from(step.defaultValue) : undefined;
        const added = fallback !== undefined
          ? native.symbols.csv_parser_add_transform_with_default(handle, column, step.kind, fallback, fallback)
          : native.symbols.csv_parser_add_transform(handle, column, step.kind);
        if (!added) {
          throw new Error('native parser rejected transform step');
        }
        if (step.kind === Op.ReplaceAll) {
          addPair(handle, column, step.search, step.replacement);
        }
        if (step.kind === Op.Map) {
          for (const [key, value,] of step.values) {
            addPair(handle, column, key, value);
          }
        }
      }
    }
    active = true;
  }
  return active;
}

function addPair(handle: NativePointer, column: number, key: string, value: string): void {
  const first = Buffer.from(key);
  const second = Buffer.from(value);
  if (!native.symbols.csv_parser_transform_pair(handle, column, first, first, second, second)) {
    throw new Error('native parser rejected transform operands');
  }
}
