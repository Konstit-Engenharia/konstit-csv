import {
  native,
  type NativePointer,
} from './native.js';
import { MAX_COLUMN_INDEX } from './normalize.js';
import type {
  CsvColumns,
  CsvTransform,
  CsvTransformMethods,
} from './types.js';

// Operation codes are shared with native/field_transforms.hpp.
enum Op {
  Trim,
  Upper,
  Lower,
  RemoveDiacritics,
  ReplaceAll,
  Lookup,
}
type Step =
  | { kind: Op.Trim | Op.Upper | Op.Lower | Op.RemoveDiacritics; }
  | { kind: Op.ReplaceAll; search: string; replacement: string; }
  | { kind: Op.Lookup; values: ReadonlyMap<string, string>; };

interface Chain {
  column: number;
  step: Step;
  previous: Chain | undefined;
}

const chains = new WeakMap<CsvTransform, Chain>();

export function transformMethods(column: number, previous?: Chain): CsvTransformMethods {
  const append = (step: Step): CsvTransform => {
    const chain = { column, step, previous };
    const token = Object.freeze(transformMethods(column, chain)) as CsvTransform;
    chains.set(token, chain);
    return token;
  };
  return {
    trim: () => append({ kind: Op.Trim }),
    upper: () => append({ kind: Op.Upper }),
    lower: () => append({ kind: Op.Lower }),
    removeDiacritics: () => append({ kind: Op.RemoveDiacritics }),
    replaceAll: (search, replacement) => {
      requireText(search);
      requireText(replacement);
      if (search.length === 0) {
        throw new RangeError('replaceAll search must not be empty');
      }
      return append({ kind: Op.ReplaceAll, search, replacement });
    },
    lookup: (values) => {
      if (values == null || typeof values.get !== 'function' || typeof values.entries !== 'function') {
        throw new TypeError('lookup requires a map of strings');
      }
      const captured = new Map<string, string>();
      for (const [key, value,] of values.entries()) {
        requireText(key);
        requireText(value);
        captured.set(key, value);
      }
      return append({ kind: Op.Lookup, values: captured });
    },
  };
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
    const chain = chains.get(token);
    if (!chain) {
      throw new TypeError('transform requires a chain created by csv.column()');
    }
    if (seen.has(chain.column)) {
      throw new RangeError(`transform column repeated: ${chain.column}`);
    }
    seen.add(chain.column);
  }
  return Object.freeze(captured);
}

/** Strict row projection happens after full-width validation and transformation. */
export function selectTransforms(tokens: readonly CsvTransform[], columns: CsvColumns): readonly CsvTransform[] {
  const selected = new Set(columns);
  return tokens.filter((token) => {
    const chain = chains.get(token);
    return chain !== undefined && selected.has(chain.column);
  });
}

/** Copy each selected chain into its parser. Native writes never reference caller-owned data. */
export function prepareTransforms(handle: NativePointer, tokens: readonly CsvTransform[], selected: CsvColumns | undefined): boolean {
  const columns = selected === undefined ? undefined : new Set(selected);
  let active = false;
  for (const token of tokens) {
    const chain = chains.get(token);
    if (!chain) {
      throw new TypeError('transform requires a chain created by csv.column()');
    }
    if (columns && !columns.has(chain.column)) {
      continue;
    }
    const steps: Step[] = [];
    for (let node: Chain | undefined = chain; node; node = node.previous) {
      steps.push(node.step);
    }
    for (const step of steps.reverse()) {
      if (!native.symbols.csv_parser_add_transform(handle, chain.column, step.kind)) {
        throw new Error('native parser rejected transform step');
      }
      if (step.kind === Op.ReplaceAll) {
        addPair(handle, chain.column, step.search, step.replacement);
      }
      if (step.kind === Op.Lookup) {
        for (const [key, value,] of step.values) {
          addPair(handle, chain.column, key, value);
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
