// End-to-end file parsing workloads from bytebrujo/bun-csv's benchmark-comparison.ts (MIT).
import { parse } from 'csv-parse/sync';
import { parseString } from 'fast-csv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Papa from 'papaparse';
import { CSVParser } from 'turbocsv';
import { csv } from '../../src/index.ts';

const corpus = join(import.meta.dir, '../../corpus/turbocsv');
const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth'];
const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const genders = ['Male', 'Female', 'Other'];
const countries = ['USA', 'Canada', 'UK', 'Germany', 'France', 'Australia', 'Japan', 'Brazil', 'India', 'Mexico'];
const departments = ['Engineering', 'Sales', 'Marketing', 'HR', 'Finance', 'Operations', 'Legal', 'Support'];

function generateFixture(rows: number): string {
  const lines = ['id,first_name,last_name,email,gender,ip_address,country,birthdate,salary,department'];
  for (let id = 1; id <= rows; ++id) {
    const first = firstNames[id % firstNames.length];
    const last = lastNames[id % lastNames.length];
    const email = `${first}.${last}${id}@example.com`.toLowerCase();
    const ip = `${id % 256}.${id * 7 % 256}.${id * 13 % 256}.${id * 17 % 256}`;
    const month = String(1 + id % 12).padStart(2, '0');
    const day = String(1 + id % 28).padStart(2, '0');
    lines.push([
      id,
      first,
      last,
      email,
      genders[id % genders.length],
      ip,
      countries[id % countries.length],
      `${1950 + id % 50}-${month}-${day}`,
      30_000 + id % 170_000,
      departments[id % departments.length],
    ].join(','));
  }
  return lines.join('\n');
}

interface Fixture {
  name: string;
  path: string;
  rows: number;
  bytes: number;
  idColumn: string;
  hasQuotes: boolean;
}

export async function* comparisonFixtures(): AsyncGenerator<Fixture> {
  for (const rows of [1_000, 10_000, 100_000]) {
    const name = `benchmark-${rows / 1_000}k.csv`;
    const path = join(corpus, name);
    const file = Bun.file(path);
    const bytes = await file.exists() ? file.size : await Bun.write(file, generateFixture(rows));
    yield { name, path, rows, bytes, idColumn: 'id', hasQuotes: false };
  }
  for (const rows of [100, 100_000]) {
    const name = `customers-${rows}.csv`;
    const path = join(corpus, name);
    const file = Bun.file(path);
    if (await file.exists()) {
      yield { name, path, rows, bytes: file.size, idColumn: 'Index', hasQuotes: (await file.text()).includes('"') };
    }
  }
}

type Visit = (id: string | null | undefined) => void;
type RecordRow = Record<string, string>;

function readTurbo(path: string, fastMode: boolean, visit: Visit): void {
  const parser = new CSVParser(path, { fastMode });
  try {
    for (const row of parser) {
      visit(row.get(0));
    }
    if (parser.errors.length) {
      throw new Error(`TurboCSV: ${parser.errors[0]?.message}`);
    }
  } finally {
    parser.close();
  }
}

interface ParserCase {
  name: string;
  emitsHeader?: boolean;
  read: (fixture: Fixture, visit: Visit) => void | Promise<void>;
}

async function readBatches(path: string, visit: Visit, columns?: readonly number[]): Promise<void> {
  for await (using batch of csv.batches(path, { encoding: 'utf8', columns })) {
    batch.forEachRow((row) => visit(row.get(0)));
  }
}

async function readRows(path: string, visit: Visit, columns?: readonly number[]): Promise<void> {
  for await (const batch of csv.rows(path, { encoding: 'utf8', columns })) {
    for (const row of batch) {
      visit(row[0]);
    }
  }
}

const parsers: readonly ParserCase[] = [
  { name: 'TurboCSV', read: ({ path }, visit) => readTurbo(path, false, visit) },
  { name: 'TurboCSV fast', read: ({ path }, visit) => readTurbo(path, true, visit) },
  { name: '@konstit/csv batches', emitsHeader: true, read: ({ path }, visit) => readBatches(path, visit) },
  { name: '@konstit/csv batches columns: [0]', emitsHeader: true, read: ({ path }, visit) => readBatches(path, visit, [0]) },
  { name: '@konstit/csv rows', emitsHeader: true, read: ({ path }, visit) => readRows(path, visit) },
  { name: '@konstit/csv rows columns: [0]', emitsHeader: true, read: ({ path }, visit) => readRows(path, visit, [0]) },
  {
    name: 'PapaParse',
    read({ path, idColumn }, visit) {
      const { data, errors } = Papa.parse<RecordRow>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
      if (errors.length) {
        throw new Error(`PapaParse: ${errors[0]?.message}`);
      }
      for (const row of data) {
        visit(row[idColumn]);
      }
    },
  },
  {
    name: 'csv-parse (sync)',
    read({ path, idColumn }, visit) {
      const records = parse<RecordRow>(readFileSync(path, 'utf8'), { columns: true, skip_empty_lines: true });
      for (const row of records) {
        visit(row[idColumn]);
      }
    },
  },
  {
    name: 'fast-csv',
    read({ path, idColumn }, visit) {
      return new Promise<void>((resolve, reject) => {
        parseString(readFileSync(path, 'utf8'), { headers: true })
          .on('data', (row: RecordRow) => visit(row[idColumn]))
          .once('error', reject)
          .once('end', resolve);
      });
    },
  },
];

export function comparisonCases(fixture: Fixture): { name: string; run: () => Promise<void>; }[] {
  return parsers.filter((parser) => !(fixture.hasQuotes && parser.name === 'TurboCSV fast')).map((parser) => ({
    name: parser.name,
    async run() {
      let rows = parser.emitsHeader ? -1 : 0;
      let idSum = 0;
      await parser.read(fixture, (id) => {
        if (++rows === 0) {
          if (id !== fixture.idColumn) {
            throw new Error(`${fixture.name}: expected first column ${fixture.idColumn}, got ${id}`);
          }
          return;
        }
        idSum += Number(id);
      });
      // Both the generated files and upstream customer samples number data rows from 1.
      if (rows !== fixture.rows || idSum !== rows * (rows + 1) / 2) {
        throw new Error(`${parser.name}: unexpected rows or IDs for ${fixture.name} (rows=${rows}, ID sum=${idSum})`);
      }
    },
  }));
}

if (import.meta.main) {
  for await (const fixture of comparisonFixtures()) {
    const results = [];
    for (const { name, run } of comparisonCases(fixture)) {
      await run(); // Warm up before the five timed file reads.
      const times = [];
      for (let i = 0; i < 5; ++i) {
        const start = performance.now();
        await run();
        times.push(performance.now() - start);
      }
      const middle = times.sort((a, b) => a - b).slice(1, -1);
      const ms = middle.reduce((sum, time) => sum + time, 0) / middle.length;
      results.push({ name, ms, throughput: fixture.bytes / (1024 ** 2) / (ms / 1000) });
    }
    results.sort((a, b) => a.ms - b.ms);
    const fastestMs = Math.min(...results.map(({ ms }) => ms));
    console.log(
      `\n${fixture.name}: ${fixture.rows.toLocaleString()} data rows, ${fixture.bytes.toLocaleString()} bytes (mean of middle 3 runs)`,
    );
    console.table(results.map(({ name, ms, throughput }) => ({
      'Parser': name,
      'ms': ms.toFixed(2),
      'MiB/s': throughput.toFixed(1),
      'Time / fastest': `${(ms / fastestMs).toFixed(2)}×`,
    })));
  }
}
