// Export as Excel: the report tables (tables.ts) as a workbook, one per sheet named as the UI and the
// CLI name them, the batch summary, and a zip of several. Kept out of the core: it depends on SheetJS.
import { CFB, utils, write, type WorkSheet } from 'xlsx';
import { outputName } from '../map/file';
import { batchRows, reportTables, type BatchEntry, type ReportOptions, type SheetResult, type Table } from './tables';

/** The whole result for a file's sheets as one workbook (Summary, Mapping, Data, Issues, Left out tabs). Returns the .xlsx bytes. */
export function toReport(file: string, results: readonly SheetResult[], options: ReportOptions = {}): Uint8Array {
	return book(Object.entries(reportTables(file, results, options)));
}

/** The batch's summary workbook: one line per sheet written, or per file that failed, and why. */
export const toBatchSummary = (entries: readonly BatchEntry[]): Uint8Array => book([['Files', batchRows(entries)]]);

/** The default output: one workbook per sheet that has records, named RM_<file>_<sheet>.xlsx. */
export function sheetWorkbooks(file: string, results: readonly SheetResult[], options: ReportOptions = {}): { name: string; bytes: Uint8Array; result: SheetResult }[] {
	return results.filter((r) => r.records.length).map((r) => ({ name: outputName(r.file, 'xlsx'), bytes: toReport(file, [r], options), result: r }));
}

/** Files in one zip, for the UI's "Download all" (a browser can't save a folder). */
export function toZip(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
	const zip = CFB.utils.cfb_new();
	for (const f of files) CFB.utils.cfb_add(zip, f.name, f.bytes);
	return new Uint8Array(CFB.write(zip, { type: 'array', fileType: 'zip', compression: true }) as ArrayLike<number>);
}

function book(tabs: readonly [string, Table][]): Uint8Array {
	const wb = utils.book_new();
	for (const [name, rows] of tabs) utils.book_append_sheet(wb, sheet(rows), name);
	return new Uint8Array(write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}

// Every value as text (NPIs and ZIPs keep their leading zeros), a filter on the header, columns sized to fit.
function sheet(rows: Table): WorkSheet {
	const ws = utils.aoa_to_sheet(rows);
	const header = rows[0] ?? [];
	if (rows.length > 1 && ws['!ref'] && header.length > 2) ws['!autofilter'] = { ref: ws['!ref'] };
	const widths: number[] = [];
	for (const row of rows) row.forEach((v, i) => (widths[i] = Math.max(widths[i] ?? 0, String(v).length)));
	ws['!cols'] = widths.map((w) => ({ wch: Math.min(60, Math.max(6, w + 1)) }));
	return ws;
}
