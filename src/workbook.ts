// Read a spreadsheet's bytes into rows, the same way in Node and the browser.
// Kept out of the core because it depends on SheetJS.
import { read, utils } from 'xlsx';
import { redactSsn } from './redact';
import type { Row } from './types';

export interface Sheet {
	name: string;
	rows: Row[];
	/** SSNs removed on read: columns removed by header (0-based) and cells replaced. */
	redacted: { columns: number[]; cells: number };
}

/**
 * Read every sheet of an xlsx, xls or csv file as rows of cells.
 * Pass the file's bytes: `await file.arrayBuffer()` in the browser, `readFileSync(path)` in Node.
 * Dates come back as Date objects; blank rows are kept so row numbers match the sheet.
 * SSNs are replaced before the rows are returned (see redact.ts), so nothing downstream sees them.
 */
export function readWorkbook(data: ArrayBuffer | Uint8Array): Sheet[] {
	const workbook = read(data, { type: 'array', cellDates: true });
	return workbook.SheetNames.map((name) => {
		const { rows, columns, cells } = redactSsn(utils.sheet_to_json<Row>(workbook.Sheets[name]!, { header: 1, raw: true, defval: null, blankrows: true }));
		return { name, rows, redacted: { columns, cells } };
	});
}
