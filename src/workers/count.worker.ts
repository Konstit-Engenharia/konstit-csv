import { createReadStream } from 'node:fs';
import { DEFAULT_CHUNK_SIZE } from '../native.js';
import { createPreparedParser } from '../parser.js';
import type { CsvEncoding } from '../types.js';
import type { WorkerFilterProgramEntry } from '../worker-filter.js';

interface WorkerCountMessage {
  chunkSize?: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  filterProgram?: WorkerFilterProgramEntry[];
}

addEventListener('message', async (event: MessageEvent<WorkerCountMessage>) => {
  const message = event.data;
  try {
    const rows = await countShard(message);
    postMessage({
      rows,
      shardIndex: message.shardIndex,
      type: 'done',
    });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
      shardIndex: message.shardIndex,
      type: 'error',
    });
  }
});

async function countShard(message: WorkerCountMessage): Promise<number> {
  using parser = createPreparedParser(
    {
      delimiter: message.delimiter,
      encoding: message.encoding,
    },
    undefined,
    message.filterProgram,
  );
  let rows = 0;
  for await (
    const chunk of createReadStream(message.path, {
      end: message.shard.end,
      highWaterMark: message.chunkSize ?? DEFAULT_CHUNK_SIZE,
      start: message.shard.start,
    })
  ) {
    rows += parser.writeCount(chunk as Buffer);
  }
  rows += parser.endCount();
  return rows;
}
