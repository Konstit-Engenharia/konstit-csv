import {
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.js';
import { findCsvSafeShards } from './files.js';
import { DEFAULT_CHUNK_SIZE } from './native.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import type {
  CsvParallelCountOptions,
  CsvShard,
} from './types.js';
import { createWorker } from './worker-factory.js';
import {
  toWorkerFilterProgram,
  type WorkerFilterProgramEntry,
} from './worker-filter.js';
import { workerModuleUrl } from './worker-module.js';

interface WorkerCountMessage {
  chunkSize?: number;
  delimiter?: string;
  encoding?: CsvParallelCountOptions['encoding'];
  path: string;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  filterProgram?: WorkerFilterProgramEntry[];
}

interface WorkerDoneMessage {
  rows: number;
  shardIndex: number;
  type: 'done';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

export async function parallelCount(path: string, suppliedOptions: CsvParallelCountOptions): Promise<number> {
  const options = snapshotCsvOptions(suppliedOptions);
  const workerCount = options.workerCount ?? 1;
  if (!Number.isInteger(workerCount) || workerCount <= 1) {
    throw new RangeError(`parallel count require workerCount > 1: ${workerCount}`);
  }
  rejectCompressedSharding(options, 'parallel counting');
  rejectAutoDelimiterSharding(options, 'parallel counting');
  if ((options as { strict?: boolean; }).strict === true) {
    throw new Error('parallel count does not support strict CSV validation; use count() without workers for strict schema checks');
  }
  const filterProgram = toWorkerFilterProgram(options.where);

  const shards = findCsvSafeShards(path, workerCount, options.delimiter ?? ',');
  if (shards.length === 0) {
    return 0;
  }

  const shardWorkers: { readonly shard: CsvShard; readonly worker: Worker; }[] = [];
  let workersCreated = false;
  try {
    for (const shard of shards) {
      shardWorkers.push({
        shard,
        worker: createWorker(workerModuleUrl('count'), {
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

  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      let doneWorkers = 0;
      let total = 0;

      const finish = (value: number) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const { worker } of shardWorkers) {
          worker.terminate();
        }
        resolve(value);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const { worker } of shardWorkers) {
          worker.terminate();
        }
        reject(error);
      };

      shardWorkers.forEach(({ shard, worker }, shardIndex) => {
        worker.onmessage = (event: MessageEvent<WorkerDoneMessage | WorkerErrorMessage>) => {
          const message = event.data;
          if (message.type === 'error') {
            fail(new Error(`worker ${message.shardIndex}: ${message.error}`));
            return;
          }
          total += message.rows;
          if (!Number.isSafeInteger(total)) {
            fail(new RangeError(`parallel row count exceeds Number.MAX_SAFE_INTEGER: ${total}`));
            return;
          }
          ++doneWorkers;
          if (doneWorkers === shardWorkers.length) {
            finish(total);
          }
        };
        worker.onerror = (event) => {
          fail(event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`));
        };
        worker.postMessage(
          {
            chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
            delimiter: options.delimiter,
            encoding: options.encoding,
            path,
            shard,
            shardIndex,
            filterProgram,
          } satisfies WorkerCountMessage,
        );
      });
    });
  } finally {
    for (const { worker } of shardWorkers) {
      worker.terminate();
    }
  }
}
