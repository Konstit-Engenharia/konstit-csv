import {
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes } from '../src/format-bytes.ts';

const corpusDirectory = join(import.meta.dir, '..', 'corpus', 'large');
const exampleCsvPath = join(corpusDirectory, 'example.csv');
const exampleArchivePath = join(corpusDirectory, 'Estabelecimentos0.zip');
const libpostalPath = join(corpusDirectory, 'formatted_addresses_tagged.random.tsv.gz');

const exampleArchiveUrl =
  'https://arquivos.receitafederal.gov.br/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ/2026-08/Estabelecimentos0.zip';
const libpostalUrl = 'https://archive.org/download/libpostal-parser-training-data-20170304/formatted_addresses_tagged.random.tsv.gz';

await mkdir(corpusDirectory, { recursive: true });
await installExampleCsv();
await downloadIfMissing(libpostalUrl, libpostalPath, 'libpostal training data');

async function installExampleCsv(): Promise<void> {
  if (await reportExistingFile(exampleCsvPath, 'Brazilian government CSV')) {
    return;
  }

  const unzip = Bun.which('unzip');
  if (unzip === null) {
    throw new Error('unzip is required to extract example.csv');
  }

  await downloadIfMissing(exampleArchiveUrl, exampleArchivePath, 'Brazilian government CSV archive');
  const entry = await findSingleZipFile(unzip, exampleArchivePath);
  const partialPath = `${exampleCsvPath}.part`;
  await rm(partialPath, { force: true });
  console.log(`Extracting ${entry} as ${exampleCsvPath}`);

  const subprocess = Bun.spawn([unzip, '-p', exampleArchivePath, entry], {
    stdout: Bun.file(partialPath),
    stderr: 'pipe',
  });
  const [exitCode, stderr,] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    await removePartialFile(partialPath);
    throw new Error(`failed to extract ${entry}: ${stderr.trim() || `unzip exited with code ${exitCode}`}`);
  }
  if (Bun.file(partialPath).size === 0) {
    await removePartialFile(partialPath);
    throw new Error(`failed to extract ${entry}: output is empty`);
  }

  await rename(partialPath, exampleCsvPath);
  await rm(exampleArchivePath, { force: true });
  console.log(`Created ${exampleCsvPath} (${formatBytes(Bun.file(exampleCsvPath).size)})`);
}

async function downloadIfMissing(url: string, targetPath: string, label: string): Promise<void> {
  if (await reportExistingFile(targetPath, label)) {
    return;
  }

  const partialPath = `${targetPath}.part`;
  await rm(partialPath, { force: true });
  console.log(`Downloading ${label} from ${url}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`failed to download ${label}: HTTP ${response.status} ${response.statusText}`);
  }

  const expectedBytes = parseContentLength(response.headers.get('content-length'));
  let receivedBytes = 0;
  let lastProgressAt = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        const now = performance.now();
        if (process.stdout.isTTY === true && now - lastProgressAt >= 1_000) {
          process.stdout.write(`\rDownloaded ${formatProgress(receivedBytes, expectedBytes)}`);
          lastProgressAt = now;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  try {
    const writtenBytes = await Bun.write(partialPath, new Response(body));
    if (process.stdout.isTTY === true) {
      process.stdout.write(`\rDownloaded ${formatProgress(writtenBytes, expectedBytes)}\n`);
    }
    if (writtenBytes !== receivedBytes) {
      throw new Error(`wrote ${writtenBytes} bytes after receiving ${receivedBytes} bytes`);
    }
    if (expectedBytes !== undefined && writtenBytes !== expectedBytes) {
      throw new Error(`expected ${expectedBytes} bytes but received ${writtenBytes}`);
    }
    if (writtenBytes === 0) {
      throw new Error('download is empty');
    }
    await rename(partialPath, targetPath);
    console.log(`Created ${targetPath} (${formatBytes(writtenBytes)})`);
  } catch (error) {
    await removePartialFile(partialPath);
    throw new Error(`failed to download ${label}`, { cause: error });
  }
}

async function findSingleZipFile(unzip: string, archivePath: string): Promise<string> {
  const subprocess = Bun.spawn([unzip, '-Z1', archivePath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr,] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`failed to inspect ${archivePath}: ${stderr.trim() || `unzip exited with code ${exitCode}`}`);
  }

  const files = stdout
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'));
  if (files.length !== 1 || files[0] === undefined) {
    throw new Error(`expected one file in ${archivePath}, found ${files.length}`);
  }
  return files[0];
}

async function reportExistingFile(path: string, label: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return false;
  }
  if (file.size === 0) {
    throw new Error(`${path} exists but is empty; remove it and run this script again`);
  }
  console.log(`Skipping ${label}; ${path} already exists (${formatBytes(file.size)})`);
  return true;
}

async function removePartialFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    console.warn(`Could not remove partial file ${path}:`, error);
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatProgress(receivedBytes: number, expectedBytes: number | undefined): string {
  return expectedBytes === undefined
    ? formatBytes(receivedBytes)
    : `${formatBytes(receivedBytes)} / ${formatBytes(expectedBytes)}`;
}
