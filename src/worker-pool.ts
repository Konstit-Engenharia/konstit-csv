import {
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.js';
import { findCsvSafeShards } from './files.js';
import { DEFAULT_CHUNK_SIZE } from './native.js';
import {
  normalizeColumns,
  normalizeFixedColumnsCount,
} from './normalize.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvProjectedRow,
  CsvShard,
  CsvWorkerPoolOptions,
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
  encoding?: CsvApiFileOptions['encoding'];
  fixedColumns?: number;
  path: string;
  shard: CsvShard;
  shardIndex: number;
  filterProgram?: WorkerFilterProgramEntry[];
}

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvApiFileOptions['encoding'];
  fixedColumns?: number;
  path: string;
  selectedColumns?: CsvColumns;
  shard: CsvShard;
  shardIndex: number;
  filterProgram?: WorkerFilterProgramEntry[];
}

interface WorkerRowsBatchMessage {
  rows: string[][];
  shardIndex: number;
  type: 'rows';
}

interface WorkerDoneMessage {
  rows?: number;
  shardIndex: number;
  type: 'done';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

interface ShardWorker {
  readonly shard: CsvShard;
  readonly worker: Worker;
}

type CsvSelectedColumnsFromOptions<TOptions extends CsvApiFileOptions> = TOptions extends { columns: infer TColumns extends CsvColumns; }
  ? TColumns
  : TOptions extends { selectedColumns: infer TColumns extends CsvColumns; } ? TColumns
  : undefined;

/**
 * Reusable worker pool for repeated parallel scans of one CSV file.
 *
 * The path and options are captured when the pool is constructed. Record-safe
 * shards and the count/row workers are then reused across calls, avoiding
 * repeated worker startup. Operations are serialized: calling `count()` or
 * `rows()` while another operation is active throws instead of racing shared
 * workers.
 *
 * Keep the source file unchanged while reusing a pool; its record-safe shard
 * boundaries are cached after the first operation.
 *
 * Use `close()` or a `using` declaration when the pool is no longer needed.
 * Closing an active pool cancels its operation and terminates its workers.
 * Compressed input and automatic delimiter detection are not supported by
 * byte-offset sharding; strict validation is unsupported by parallel workers.
 *
 * @typeParam TColumns Tuple of selected physical columns used to type projected rows.
 *
 * @example
 * ```ts
 * import { CsvWorkerPool } from '@konstit/csv';
 *
 * using pool = new CsvWorkerPool('data.csv', { workerCount: 4 });
 * console.log(await pool.count());
 * ```
 */
export class CsvWorkerPool<TColumns extends CsvColumns | undefined = undefined> {
  readonly #path: string;
  readonly #options: CsvApiFileOptions;
  #countWorkers: ShardWorker[] | undefined;
  #rowsWorkers: ShardWorker[] | undefined;
  #shards: CsvShard[] | undefined;
  #cancelActive: ((error: Error) => void) | undefined;
  #closed = false;
  #busy = false;

  /**
   * Create a pool configured for one uncompressed CSV file.
   *
   * @param path Path to the CSV file.
   * @param suppliedOptions Parallel row options, including `workerCount` greater than one.
   * @throws {RangeError} If `workerCount` is not an integer greater than one.
   * @throws If compressed input or automatic delimiter detection is requested.
   */
  constructor(path: string, suppliedOptions: CsvWorkerPoolOptions<TColumns>) {
    const options = snapshotCsvOptions(suppliedOptions);
    const workerCount = options.workerCount ?? 1;
    if (!Number.isInteger(workerCount) || workerCount <= 1) {
      throw new RangeError(`worker pool requires workerCount > 1: ${workerCount}`);
    }
    rejectCompressedSharding(options, 'worker pool');
    rejectAutoDelimiterSharding(options, 'worker pool');
    normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
    this.#path = path;
    this.#options = options;
  }

  /** Whether `close()` has been called and the pool can no longer start work. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Count logical CSV records across the pool's record-safe shards.
   *
   * Native `where` filters are evaluated in the workers and shard counts are
   * summed on the main thread. Strict validation is not supported. The pool
   * must be open and idle when this method is called.
   *
   * @returns A promise for the total logical record count.
   * @throws {RangeError} If the total cannot be represented as a safe integer.
   * @throws If the pool is closed or busy, strict mode was configured, or a worker, file, or parser error occurs.
   */
  async count(): Promise<number> {
    this.#assertOpen();
    if (this.#options.strict === true) {
      throw new Error('parallel count does not support strict CSV validation');
    }

    this.#busy = true;
    let cancelActive: ((error: Error) => void) | undefined;
    try {
      const filterProgram = toWorkerFilterProgram(this.#options.where);
      const shards = this.#ensureShards();
      if (shards.length === 0) {
        return 0;
      }
      const workers = this.#ensureCountWorkers(shards);
      return await new Promise<number>((resolve, reject) => {
        let settled = false;
        let doneWorkers = 0;
        let total = 0;

        const finish = (value: number) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };

        const fail = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          this.#invalidateCountWorkers();
          reject(error);
        };

        cancelActive = (error) => fail(error);
        this.#cancelActive = cancelActive;

        try {
          for (const [shardIndex, { shard, worker },] of workers.entries()) {
            if (settled) {
              break;
            }
            worker.onmessage = (event: MessageEvent<WorkerDoneMessage | WorkerErrorMessage>) => {
              if (settled) {
                return;
              }
              const message = event.data;
              if (message.type === 'error') {
                fail(new Error(`worker ${message.shardIndex}: ${message.error}`));
                return;
              }
              total += message.rows ?? 0;
              if (!Number.isSafeInteger(total)) {
                fail(new RangeError(`parallel row count exceeds Number.MAX_SAFE_INTEGER: ${total}`));
                return;
              }
              ++doneWorkers;
              if (doneWorkers === workers.length) {
                finish(total);
              }
            };
            worker.onerror = (event) => {
              fail(event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`));
            };
            worker.postMessage(
              {
                chunkSize: this.#options.chunkSize ?? DEFAULT_CHUNK_SIZE,
                delimiter: this.#options.delimiter,
                encoding: this.#options.encoding,
                fixedColumns: this.#options.fixedColumns,
                path: this.#path,
                shard,
                shardIndex,
                filterProgram,
              } satisfies WorkerCountMessage,
            );
          }
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      if (this.#cancelActive === cancelActive) {
        this.#cancelActive = undefined;
      }
      this.#busy = false;
    }
  }

  /**
   * Stream projected row batches from the pool's workers.
   *
   * Batches are yielded as workers report them and therefore are not globally
   * ordered by file position; each shard retains its own row order. The pool
   * must be open and idle when iteration starts. Stopping iteration early
   * terminates the active row workers.
   *
   * @returns An async generator of non-empty projected row batches.
   * @throws If the pool is closed or busy, strict mode was configured, or a worker, file, or parser error occurs.
   */
  async *rows(): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
    this.#assertOpen();
    rejectWorkerRowsUnsupported(this.#options);
    const filterProgram = toWorkerFilterProgram(this.#options.where);

    this.#busy = true;
    let cancelActive: ((error: Error) => void) | undefined;
    let completed = false;
    try {
      const shards = this.#ensureShards();
      if (shards.length === 0) {
        return;
      }
      const workers = this.#ensureRowsWorkers(shards);
      const selected = selectedColumns(this.#options);

      type QueueItem =
        | { done: true; }
        | { error: Error; }
        | { rows: CsvProjectedRow<TColumns>[]; };

      const queue: QueueItem[] = [];
      let pendingResolve: (() => void) | undefined;

      const push = (item: QueueItem) => {
        queue.push(item);
        pendingResolve?.();
        pendingResolve = undefined;
      };

      let doneWorkers = 0;
      let failed = false;

      const fail = (error: Error) => {
        if (failed) {
          return;
        }
        failed = true;
        this.#invalidateRowsWorkers();
        push({ error });
      };

      cancelActive = fail;
      this.#cancelActive = cancelActive;

      try {
        for (const [shardIndex, { shard, worker },] of workers.entries()) {
          if (failed) {
            break;
          }
          worker.onmessage = (event: MessageEvent<WorkerRowsBatchMessage | WorkerDoneMessage | WorkerErrorMessage>) => {
            if (failed) {
              return;
            }
            const message = event.data;
            if (message.type === 'rows') {
              push({
                rows: message.rows as CsvProjectedRow<TColumns>[],
              });
              return;
            }
            if (message.type === 'error') {
              fail(new Error(`worker ${message.shardIndex}: ${message.error}`));
              return;
            }
            ++doneWorkers;
            if (doneWorkers === workers.length) {
              push({ done: true });
            }
          };
          worker.onerror = (event) => {
            fail(event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`));
          };
          worker.postMessage(
            {
              chunkSize: this.#options.chunkSize ?? DEFAULT_CHUNK_SIZE,
              delimiter: this.#options.delimiter,
              encoding: this.#options.encoding,
              fixedColumns: this.#options.fixedColumns,
              path: this.#path,
              selectedColumns: selected,
              shard,
              shardIndex,
              filterProgram,
            } satisfies WorkerRowsMessage,
          );
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }

      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            pendingResolve = resolve;
          });
        }

        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) {
            continue;
          }
          if ('error' in item) {
            throw item.error;
          }
          if ('done' in item) {
            completed = true;
            return;
          }
          if (item.rows.length > 0) {
            yield item.rows;
          }
        }
      }
    } finally {
      if (!completed) {
        this.#invalidateRowsWorkers();
      }
      if (this.#cancelActive === cancelActive) {
        this.#cancelActive = undefined;
      }
      this.#busy = false;
    }
  }

  /**
   * Cancel active work and terminate all workers owned by this pool.
   *
   * This method is idempotent. A closed pool cannot be used again.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#cancelActive?.(new Error('worker pool is closed'));
    this.#invalidateCountWorkers();
    this.#invalidateRowsWorkers();
  }

  /** Dispose the pool for use with a `using` declaration. */
  [Symbol.dispose](): void {
    this.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('worker pool is closed');
    }
    if (this.#busy) {
      throw new Error('worker pool is busy');
    }
  }

  #ensureShards(): CsvShard[] {
    if (this.#shards !== undefined) {
      return this.#shards;
    }
    this.#shards = findCsvSafeShards(
      this.#path,
      this.#options.workerCount ?? 1,
      this.#options.delimiter ?? ',',
    );
    return this.#shards;
  }

  #ensureCountWorkers(shards: readonly CsvShard[]): ShardWorker[] {
    if (this.#countWorkers !== undefined) {
      return this.#countWorkers;
    }
    this.#countWorkers = createShardWorkers(shards, 'count');
    return this.#countWorkers;
  }

  #ensureRowsWorkers(shards: readonly CsvShard[]): ShardWorker[] {
    if (this.#rowsWorkers !== undefined) {
      return this.#rowsWorkers;
    }
    this.#rowsWorkers = createShardWorkers(shards, 'rows');
    return this.#rowsWorkers;
  }

  #invalidateCountWorkers(): void {
    terminateShardWorkers(this.#countWorkers ?? []);
    this.#countWorkers = undefined;
  }

  #invalidateRowsWorkers(): void {
    terminateShardWorkers(this.#rowsWorkers ?? []);
    this.#rowsWorkers = undefined;
  }
}

function createShardWorkers(shards: readonly CsvShard[], kind: 'count' | 'rows'): ShardWorker[] {
  const workers: ShardWorker[] = [];
  let workersCreated = false;
  try {
    for (const shard of shards) {
      workers.push({
        shard,
        worker: createWorker(workerModuleUrl(kind), {
          preload: [],
          type: 'module',
        }),
      });
    }
    workersCreated = true;
    return workers;
  } finally {
    if (!workersCreated) {
      terminateShardWorkers(workers);
    }
  }
}

function terminateShardWorkers(workers: readonly ShardWorker[]): void {
  for (const { worker } of workers) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
}

/**
 * Construct a reusable {@link CsvWorkerPool} with tuple-aware row types.
 *
 * This factory is the implementation behind the package-level `workerPool`
 * helper. It captures the supplied options when called.
 *
 * @param path Path to the uncompressed CSV file.
 * @param options Parallel row options, including `workerCount` greater than one.
 * @returns A reusable worker pool. Dispose it with `close()` or `using`.
 * @throws {RangeError} If `workerCount` is not an integer greater than one.
 * @throws If compressed input or automatic delimiter detection is requested.
 */
export function createWorkerPool<TOptions extends CsvWorkerPoolOptions>(
  path: string,
  options: TOptions,
): CsvWorkerPool<CsvSelectedColumnsFromOptions<TOptions>>;
export function createWorkerPool(path: string, options: CsvWorkerPoolOptions): CsvWorkerPool {
  return new CsvWorkerPool(path, options);
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
