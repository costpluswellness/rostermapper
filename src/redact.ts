// SSNs are never kept. Any column headed like an SSN, and any value shaped like one, is replaced
// as soon as a file is read, before anything can display, map or export it. A TIN/SSN column
// is removed whole: undashed, an SSN and a TIN look the same.
import { cellText, isBlank } from './cells';
import { normalizeHeader } from './profile/normalize';
import type { Row } from './types';

export const REDACTED = '[SSN removed]';

// Header rows are near the top; look this far down for SSN headers.
const HEADER_SCAN = 30;
const SSN_VALUE = /^\s*\d{3}[- ]\d{2}[- ]\d{4}\s*$/;

/** True for a whole-cell value shaped like an SSN: "123-45-6789" or "123 45 6789". Undashed digits aren't matched: they look like a TIN. */
export const isSsnValue = (text: string): boolean => SSN_VALUE.test(text);

/** True for headers like "SSN", "SS#", "Social Security Number", "Soc Sec No", "TIN/SSN". */
export function isSsnHeader(header: unknown): boolean {
	const norm = normalizeHeader(header).norm;
	const words = norm.split(' ');
	return words.includes('ssn') || words.includes('ss') || /\bsocial sec(urity)?\b/.test(norm) || /\bsoc sec\b/.test(norm);
}

// A header is short text with no long numbers; "SSN on file: 111-22-3333" in a notes cell is data.
const looksLikeHeader = (cell: unknown): cell is string => typeof cell === 'string' && cell.length <= 40 && !/\d{3}/.test(cell);

export interface Redaction {
	rows: Row[];
	/** 0-based indexes of columns removed because of their header. */
	columns: number[];
	/** How many cells were replaced. */
	cells: number;
}

/** Column index → the row (0-based) of its SSN header, for every column headed like an SSN in the first rows. */
export function ssnHeaderColumns(rows: readonly Row[]): Map<number, number> {
	const headers = new Map<number, number>();
	rows.slice(0, HEADER_SCAN).forEach((row, r) => row?.forEach((cell, c) => {
		if (!headers.has(c) && looksLikeHeader(cell) && isSsnHeader(cell)) headers.set(c, r);
	}));
	return headers;
}

/** Replace every SSN in a sheet's rows. Returns new rows; the input is not changed. */
export function redactSsn(rows: readonly Row[]): Redaction {
	// Column → the row of its SSN header; everything below it is removed.
	const headers = ssnHeaderColumns(rows);
	let cells = 0;
	const out = rows.map((row, r) => {
		if (!row) return row;
		let copy: Row | undefined;
		row.forEach((cell, c) => {
			if (isBlank(cell) || cell === REDACTED) return;
			const below = headers.has(c) && r > headers.get(c)!;
			if (below || isSsnValue(cellText(cell))) {
				copy ??= [...row];
				(copy as unknown[])[c] = REDACTED;
				cells++;
			}
		});
		return copy ?? row;
	});
	return { rows: out, columns: [...headers.keys()].sort((a, b) => a - b), cells };
}
