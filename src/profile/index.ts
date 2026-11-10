import type { BodyRow, ColumnProfile, Row, SheetProfile } from '../types';
import { cellText, columnLetter, isBlank } from '../cells';
import { normalizeHeader } from './normalize';
import { detectType } from './value-type';

export interface ProfileOptions {
	/** 0-based header row. Detected when omitted. */
	headerRow?: number | undefined;
	/** Distinct sample values kept per column. */
	samples?: number | undefined;
}

/** Find the header row, then describe each column: header, value type, fill rate, samples. */
export function profile(rows: readonly Row[], options: ProfileOptions = {}): SheetProfile {
	const headerRow = options.headerRow ?? detectHeaderRow(rows);
	const samples = options.samples ?? 5;
	const header = rows[headerRow] ?? [];
	const body = bodyRows(rows, headerRow);
	// A loop, not Math.max(...rows): spreading one argument per row overflows the stack on big sheets.
	let width = header.length;
	for (const { cells } of body) width = Math.max(width, cells.length);
	const groups = groupBand(rows, headerRow, width);

	const columns: ColumnProfile[] = [];
	for (let j = 0; j < width; j++) {
		const raw = header[j];
		const all = body.map(({ cells }) => cells[j]);
		const values = all.filter((v) => !isBlank(v));
		if (isBlank(raw) && !values.length) continue;

		const distinct = [...new Set(values.map(cellText))];
		columns.push({
			index: j,
			letter: columnLetter(j),
			header: raw == null ? '' : String(raw),
			...normalizeHeader(raw),
			group: groups[j] ?? '',
			...detectType(values),
			filled: values.length,
			placeholders: all.filter((v) => cellText(v) !== '' && isBlank(v)).length,
			total: body.length,
			distinct: distinct.length,
			samples: distinct.slice(0, samples),
		});
	}
	return { headerRow, rowCount: body.length, body, columns };
}

/** The non-blank rows below the header, with their 0-based sheet index. */
export function bodyRows(rows: readonly Row[], headerRow: number): BodyRow[] {
	const body: BodyRow[] = [];
	for (let index = headerRow + 1; index < rows.length; index++) {
		const cells = rows[index];
		if (cells?.some((v) => !isBlank(v))) body.push({ index, cells });
	}
	return body;
}

/** The row in the first `maxScan` that looks most like a header. */
export function detectHeaderRow(rows: readonly Row[], maxScan = 30): number {
	let best = 0;
	let bestScore = -Infinity;
	for (let r = 0; r < Math.min(rows.length, maxScan); r++) {
		const score = scoreHeaderRow(rows, r);
		if (score > bestScore) {
			best = r;
			bestScore = score;
		}
	}
	return best;
}

const looksLikeData = (v: unknown) =>
	v instanceof Date || typeof v === 'number' || /^[\d\s()+\-./$,:]+$/.test(String(v).trim());

// Headers are many distinct labels with data filled in below them.
function scoreHeaderRow(rows: readonly Row[], r: number): number {
	const row = rows[r] ?? [];
	const cells = row.filter((v) => !isBlank(v));
	if (cells.length < 2) return -Infinity;

	const labels = cells.filter((v) => !looksLikeData(v)).map((v) => String(v).trim().toLowerCase());
	const unique = new Set(labels).size;
	const data = cells.length - labels.length;

	let support = 0;
	for (let k = 1; k <= 3; k++) {
		const next = rows[r + k] ?? [];
		row.forEach((v, j) => {
			if (!isBlank(v) && !isBlank(next[j])) support += 1 / 3;
		});
	}
	return unique * 2 - data * 3 - (labels.length - unique) + support * 0.5;
}

// A sparse label row directly above the header ("PRACTICING LOCATION II") usually
// spans merged cells; carry each label right until the next one.
function groupBand(rows: readonly Row[], headerRow: number, width: number): string[] {
	const above = rows[headerRow - 1];
	const header = rows[headerRow] ?? [];
	if (!above) return [];

	const filled = above.filter((v) => !isBlank(v)).length;
	if (!filled || filled >= header.filter((v) => !isBlank(v)).length / 2) return [];

	const out: string[] = [];
	let current = '';
	for (let j = 0; j < width; j++) {
		if (!isBlank(above[j])) current = String(above[j]).trim();
		out[j] = current;
	}
	return out;
}
