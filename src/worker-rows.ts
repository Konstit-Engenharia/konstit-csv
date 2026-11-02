import {
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.js';
import { findCsvSafeShards } from './files.js';
import { DEFAULT_CHUNK_SIZE } from './native.js';
import { normalizeColumns } from './normalize.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvEncoding,
  CsvParallelRowsOptions,
  CsvProjectedRow,
  CsvShard,
} from './types.js';
import { createWorker } from './worker-factory.js';
import {
  toWorkerFilterProgram,
  type WorkerFilterProgramEntry,
} from './worker-filter.js';
import { workerModuleUrl } from './worker-module.js';

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  selectedColumns?: CsvColumns;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  filterProgram?: WorkerFilterProgramEntry[];
}

interface WorkerRowsBatchMessage {
  rows: string[][];
  shardIndex: number;
  type: 'rows';
}

interface WorkerDoneMessage {
  shardIndex: number;
  type: 'done';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

/**
 * Stream materialized rows through Bun workers.
 *
 * Use this when the main cost is parsing/materialization and you want explicit
 * worker fan-out. `workerCount` is required here by design.
 */
export function parallelRows<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvParallelRowsOptions<TColumns>,
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  return iterateParallelRows(path, snapshotCsvOptions(options));
}

async function* iterateParallelRows<TColumns extends CsvColumns | undefined>(
  path: string,
  options: CsvParallelRowsOptions<TColumns>,
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  const workerCount = options.workerCount ?? 1;
  if (!Number.isInteger(workerCount) || workerCount <= 1) {
    throw new RangeError(`parallel rows require workerCount > 1: ${workerCount}`);
  }
  rejectCompressedSharding(options, 'parallel row parsing');
  rejectAutoDelimiterSharding(options, 'parallel row parsing');
  rejectWorkerRowsUnsupported(options);

  const selected = selectedColumns(options);
  const filterProgram = toWorkerFilterProgram(options.where);
  const shards = findCsvSafeShards(path, workerCount, options.delimiter ?? ',');
  if (shards.length === 0) {
    return;
  }

  const shardWorkers: { readonly shard: CsvShard; readonly worker: Worker; }[] = [];
  let workersCreated = false;
  try {
    for (const shard of shards) {
      shardWorkers.push({
        shard,
        worker: createWorker(workerModuleUrl('rows'), {
          preload: [],
          type: 'module',
        }),
      });
    }
    workersCreated = true;
  } finally {
    if (!workersCreated) {
      for (const { worker } of shardWorkers) {
        worker.terminate();
      }
    }
  }

  type QueueItem<T extends CsvColumns | undefined> =
    | { done: true; }
    | { error: Error; }
    | { rows: CsvProjectedRow<T>[]; };

  const queue: QueueItem<TColumns>[] = [];
  let pendingResolve: (() => void) | undefined;

  const push = (item: QueueItem<TColumns>) => {
    queue.push(item);
    pendingResolve?.();
    pendingResolve = undefined;
  };

  let doneWorkers = 0;

  try {
    shardWorkers.forEach(({ shard, worker }, shardIndex) => {
      worker.onmessage = (event: MessageEvent<WorkerRowsBatchMessage | WorkerDoneMessage | WorkerErrorMessage>) => {
        const message = event.data;
        if (message.type === 'rows') {
          push({
            rows: message.rows as CsvProjectedRow<TColumns>[],
          });
          return;
        }
        if (message.type === 'error') {
          push({
            error: new Error(`worker ${message.shardIndex}: ${message.error}`),
          });
          return;
        }

        ++doneWorkers;
        if (doneWorkers === shardWorkers.length) {
          push({ done: true });
        }
      };
      worker.onerror = (event) => {
        push({
          error: event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`),
        });
      };

      worker.postMessage(
        {
          chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
          delimiter: options.delimiter,
          encoding: options.encoding,
          path,
          selectedColumns: selected,
          shard,
          shardIndex,
          filterProgram,
        } satisfies WorkerRowsMessage,
      );
    });

    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }

      while (true) {
        const item = queue.shift();
        if (item === undefined) {
          break;
        }
        if ('error' in item) {
          throw item.error;
        }
        if ('done' in item) {
          return;
        }
        if (item.rows.length > 0) {
          yield item.rows;
        }
      }
    }
  } finally {
    for (const { worker } of shardWorkers) {
      worker.terminate();
    }
  }
}

function selectedColumns(options: CsvApiFileOptions): CsvColumns | undefined {
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  const columns = options.columns ?? options.selectedColumns;
  normalizeColumns(columns);
  return columns;
}

function rejectWorkerRowsUnsupported(options: CsvApiFileOptions): void {
  if (options.strict === true) {
    throw new Error('parallel rows do not support strict CSV validation');
  }
}
