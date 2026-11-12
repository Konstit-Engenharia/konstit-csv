import csvParser from 'csv-parser';
import iconv from 'iconv-lite';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export function countBufferWithCsvParser(input: Buffer, separator = ','): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let rows = 0;
    Readable.from([input])
      .pipe(csvParser({ headers: false, separator }))
      .on('data', () => {
        ++rows;
      })
      .on('error', reject)
      .on('end', () => {
        resolvePromise(rows);
      });
  });
}

export function countFileWithCsvParser(
  file: string,
  chunkSize: number,
  delimiter: string,
  encoding?: 'latin1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    let rows = 0;
    let stream = createReadStream(file, { highWaterMark: chunkSize });

    if (encoding !== undefined) {
      stream = stream.pipe(iconv.decodeStream(encoding)) as unknown as typeof stream;
    }

    stream
      .pipe(csvParser({ headers: false, separator: delimiter }))
      .on('data', () => {
        ++rows;
      })
      .on('error', reject)
      .on('end', () => {
        resolve(rows);
      });
  });
}

export interface CsvParserMaterializeStats {
  cells: number;
  chars: number;
  rows: number;
}

export function materializeFileWithCsvParser(
  file: string,
  chunkSize: number,
  delimiter: string,
  encoding?: 'iso88591' | 'latin1',
): Promise<CsvParserMaterializeStats> {
  return new Promise((resolve, reject) => {
    let rows = 0;
    let cells = 0;
    let chars = 0;
    let stream = createReadStream(file, { highWaterMark: chunkSize });

    if (encoding !== undefined) {
      stream = stream.pipe(iconv.decodeStream(encoding)) as unknown as typeof stream;
    }

    stream
      .pipe(csvParser({ headers: false, separator: delimiter }))
      .on('data', (row: unknown) => {
        const values = Array.isArray(row) ? row : Object.values(row as Record<string, string>);
        if (values.length <= 19 || values[5] !== '02' || values[19] === 'EX') {
          return;
        }
        ++rows;
        cells += values.length;
        for (const value of values) {
          chars += String(value).length;
        }
      })
      .on('error', reject)
      .on('end', () => {
        resolve({
          cells,
          chars,
          rows,
        });
      });
  });
}
