import { type DocumentChunk } from '../../types';

/**
 * A single column can hold strings, numbers, dates, formulas, rich text runs or
 * hyperlinks, so every cell has to be normalised before it reaches the index.
 * Kept in step with the FileViewer xlsx renderer, which resolves the same shapes
 * for display.
 */
const cellToText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    const cell = value as {
      error?: string;
      formula?: string;
      hyperlink?: string;
      result?: unknown;
      richText?: { text: string }[];
      sharedFormula?: string;
      text?: unknown;
    };

    if (cell.richText) return cell.richText.map((run) => run.text).join('');
    if (cell.formula !== undefined || cell.sharedFormula !== undefined) {
      return cellToText(cell.result);
    }
    if (cell.hyperlink !== undefined && cell.text === undefined) return cell.hyperlink;
    if (cell.text !== undefined) return cellToText(cell.text);

    return cell.error ?? '';
  }

  return String(value);
};

/**
 * Chunks a `.xlsx` workbook into one document per data row, reusing the sheet's
 * first row as the column names — the same `header: value` shape `CsVLoader`
 * emits, so tabular data reaches the index identically whichever format it was
 * uploaded in.
 */
export const ExcelLoader = async (fileBlob: Blob): Promise<DocumentChunk[]> => {
  const { Workbook } = await import('exceljs');

  const workbook = new Workbook();
  await workbook.xlsx.load(await fileBlob.arrayBuffer());

  return workbook.worksheets.flatMap((sheet) => {
    const chunks: DocumentChunk[] = [];
    let header: string[] = [];

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let column = 1; column <= sheet.columnCount; column++) {
        cells.push(cellToText(row.getCell(column).value));
      }

      if (rowNumber === 1) {
        header = cells;
        return;
      }

      const content = cells
        .map((value, index) => [header[index] || `column ${index + 1}`, value] as const)
        .filter(([, value]) => value.trim() !== '')
        .map(([column, value]) => `${column}: ${value}`)
        .join('\n');

      if (!content) return;

      chunks.push({
        metadata: { row: rowNumber, sheetName: sheet.name, source: 'blob' },
        pageContent: content,
      });
    });

    return chunks;
  });
};
