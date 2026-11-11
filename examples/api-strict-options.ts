import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  LIMIT,
} from './config.ts';

/**
 * Enable structural and schema validation for callers that must reject invalid
 * CSV instead of accepting the library's default permissive behavior.
 *
 * The environment variables in this example are deployment configuration. Do
 * not derive expected schemas directly from the same untrusted file being
 * validated, because that would make the checks meaningless.
 */
const expectedHeaders = parseExpectedHeaders(Bun.env['CSV_EXAMPLE_EXPECTED_HEADERS']);
const requireHeader = Bun.env['CSV_EXAMPLE_REQUIRE_HEADER'] === '1';
const minDataRows = parseMinDataRows(Bun.env['CSV_EXAMPLE_MIN_DATA_ROWS']);

// Conditional spreads omit disabled properties entirely. This keeps the
// runtime shape aligned with exact optional-property semantics instead of
// passing explicit `undefined` values.
const strictSchema = {
  // The literal `true` is preserved by `as const`, allowing TypeScript to rule
  // out unsupported strict/filter combinations at the call site.
  strict: true,
  ...(expectedHeaders === undefined ? {} : { expectedHeaders }),
  ...(requireHeader ? { requireHeader: true } : {}),
  ...(minDataRows === undefined ? {} : { minDataRows }),
} as const;

// These identity helpers retain precise option types while checking each
// object against the operation-specific public contract.
const strictRowsOptions = defineRowsOptions({
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  ...strictSchema,
});

const strictCountOptions = defineCountOptions({
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  ...strictSchema,
});

let printed = 0;

// Strict failures reject iteration with an Error. Breaking the labeled loop
// calls `return()` on the async generator, so its parser and current batch are
// still released normally.
outer: for await (const rows of csv.rows(FILE, strictRowsOptions)) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      break outer;
    }
  }
}

// A strict count performs the same structural/schema validation as strict row
// iteration. It is intentionally more work than the permissive counting path.
console.log({
  strictCount: await csv.count(FILE, strictCountOptions),
  strictSchema,
});

function parseExpectedHeaders(value: string | undefined): readonly string[] | undefined {
  // An absent or blank variable means "do not assert exact header names". The
  // independent `requireHeader` option may still require a header record.
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseMinDataRows(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  // Validate at the environment boundary so configuration errors are reported
  // before the file scan starts and with the responsible variable's name.
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid CSV_EXAMPLE_MIN_DATA_ROWS: ${value}`);
  }
  return parsed;
}
