// TurboCSV 0.3.4 advertises a declaration file that is absent from its npm tarball.
declare module 'turbocsv' {
  export class CSVParser {
    constructor(path: string, options?: { fastMode?: boolean; });
    readonly errors: readonly { message: string; }[];
    [Symbol.iterator](): IterableIterator<{ get(column: number): string | null; }>;
    close(): void;
  }
}
