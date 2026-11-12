import {
  expect,
  test,
} from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

const methods = ['rows', 'batches', 'count', 'parse'] as const;
const strictModes = ['omitted', 'false', 'true'] as const;
const cases = strictModes.flatMap((strict) => [
  { declaration: 'inline', strict },
  { declaration: 'satisfies', strict },
]);

test.each(cases)('option hover documentation with $declaration options and strict $strict', ({ declaration, strict }) => {
  const source = `
    import { csv, type CsvRowsOptions, type CsvBatchesOptions, type CsvCountOptions, type CsvParseOptions } from '../src/index.ts';
    ${
    methods.map((method) => {
      const options = `{
      chunkSize: 1024,
      delimiter: ';',
      encoding: 'latin1',
      columns: ${method === 'batches' && strict === 'true' ? 'undefined' : '[2, 0, 2] as const'},
      fixedColumns: 3,
      expectedHeaders: ['a', 'b', 'c'],
      requireHeader: true,
      minDataRows: 1,
      ${strict === 'omitted' ? '' : `strict: ${strict},`}
      where: ${strict === 'true' ? 'undefined' : 'csv.column(0).equals(\'a\')'},
      ${method === 'parse' ? '' : 'compression: { format: \'zip\', entry: \'data.csv\' },'}
      ${method === 'rows' ? 'reuseArrays: true,' : ''}
    }`;
      const typeName = `Csv${method.charAt(0).toUpperCase()}${method.slice(1)}Options`;
      const type = method === 'rows' || method === 'parse' ? `${typeName}<readonly [2, 0, 2]>` : typeName;
      const argument = declaration === 'satisfies' ? `${options} satisfies ${type}` : options;
      return `void csv.${method}(${method === 'parse' ? 'new Uint8Array()' : '\'data.csv\''}, ${argument});`;
    }).join('\n')
  }
  `;
  const fileName = join(import.meta.dir, 'options-hover-fixture.ts');
  const options: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: ['bun'],
  };
  const service = ts.createLanguageService({
    ...ts.sys,
    getCompilationSettings: () => options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    getScriptFileNames: () => [fileName],
    getScriptSnapshot: (path) => {
      const contents = path === fileName ? source : ts.sys.readFile(path);
      return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
    },
    getScriptVersion: () => '0',
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  });

  try {
    expect(service.getSyntacticDiagnostics(fileName)).toEqual([]);
    expect(service.getSemanticDiagnostics(fileName).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')))
      .toEqual([]);
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
    let checkedProperties = 0;

    function checkHover(node: ts.Node): void {
      if (ts.isPropertyAssignment(node)) {
        const info = service.getQuickInfoAtPosition(fileName, node.name.getStart(sourceFile));
        const documentation = ts.displayPartsToString(info?.documentation);
        expect(documentation, `JSDoc for ${node.name.getText(sourceFile)}`).not.toBe('');
        if (node.name.getText(sourceFile) === 'where') {
          expect(documentation).toContain(strict === 'true' ? 'Filtering is unavailable' : 'Filter records');
        }
        checkedProperties += 1;
      }
      ts.forEachChild(node, checkHover);
    }

    checkHover(sourceFile);
    expect(checkedProperties).toBe(strict === 'omitted' ? 46 : 50);
  } finally {
    service.dispose();
  }
});
