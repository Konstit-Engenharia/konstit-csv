import { createReadStream } from 'node:fs';
import { createPreparedParser } from '../parser.js';
import type {
  CsvColumns,
  CsvEncoding,
} from '../types.js';
import type { WorkerFilterProgramEntry } from '../worker-filter.js';

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  fixedColumns?: number;
  selectedColumns?: CsvColumns;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  path: string;
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

addEventListener('message', async (event: MessageEvent<WorkerRowsMessage>) => {
  const message = event.data;
  try {
    await streamShardRows(message);
    postMessage(
      {
        shardIndex: message.shardIndex,
        type: 'done',
      } satisfies WorkerDoneMessage,
    );
  } catch (error) {
    postMessage(
      {
        error: error instanceof Error ? error.message : String(error),
        shardIndex: message.shardIndex,
        type: 'error',
      } satisfies WorkerErrorMessage,
    );
  }
});

async function streamShardRows(message: WorkerRowsMessage): Promise<void> {
  using parser = createPreparedParser(
    {
      delimiter: message.delimiter,
      encoding: message.encoding,
      fixedColumns: message.fixedColumns,
    },
    message.selectedColumns,
    message.filterProgram,
  );
  const rowsBuffer: string[][] = [];
  for await (
    const chunk of createReadStream(message.path, {
      end: message.shard.end,
      highWaterMark: message.chunkSize,
      start: message.shard.start,
    })
  ) {
    const batch = parser.writeBatch(chunk as Buffer);
    try {
      const rows = batch.rowsInto(rowsBuffer);
      if (rows.length > 0) {
        postMessage(
          {
            rows,
            shardIndex: message.shardIndex,
            type: 'rows',
          } satisfies WorkerRowsBatchMessage,
        );
      }
    } finally {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  try {
    const rows = batch.rowsInto(rowsBuffer);
    if (rows.length > 0) {
      postMessage(
        {
          rows,
          shardIndex: message.shardIndex,
          type: 'rows',
        } satisfies WorkerRowsBatchMessage,
      );
    }
  } finally {
    batch.close();
  }
}
