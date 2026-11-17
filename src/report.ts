// The whole result of mapping one file, as one Excel workbook: what was decided (Summary, Mapping),
// what moves forward (Data) and what didn't (Issues, Left out). Written by the CLI for -o *.xlsx.
// Kept out of the core because it depends on SheetJS.
import { CFB, utils, write, type WorkSheet } from 'xlsx';
import type { AutomapResult } from './automap';
import { leftOutRows, recordRows } from './csv';
import { isDropped, type Issue, type RosterRecord } from './records';

export interface ReportOptions {
	/** Write dropped rows to the Data tab too (they're on Left out either way). */
	keepDropped?: boolean | undefined;
	/** Extra Summary lines, label → value: the lookups used, the tool's version, … */
	notes?: Readonly<Record<string, string>> | undefined;
}

const KIND: Record<Issue['kind'], string> = { missing: 'missing', format: 'unreadable', invalid: 'rejected', warning: 'warning', default: 'note' };

/**
 * One workbook for a file's sheets (each an automap result, with `sheet` its name):
 * - Summary: per sheet, the header row, action and category (and why), and row counts.
 * - Mapping: each column of the file and the field it went to (or why not), then required fields nothing filled.
 * - Data: the rows that move forward, as in the CSV output.
 * - Issues: one line per problem, on every row, kept or left out; filter on "Left out".
 * - Left out: each dropped row, the reason, and its values, so it can be fixed and sent again.
 * Returns the .xlsx file's bytes.
 */
export function toReport(file: string, results: readonly (AutomapResult & { sheet: string })[], { keepDropped = false, notes = {} }: ReportOptions = {}): Uint8Array {
	const all = results.flatMap((r) => r.records);
	const kept = keepDropped ? all : all.filter((r) => !isDropped(r));
	const book = utils.book_new();
	const add = (name: string, rows: readonly (readonly (string | number)[])[]) => utils.book_append_sheet(book, sheet(rows), name);

	add('Summary', [
		['File', file],
		...Object.entries(notes),
		...results.flatMap((r) => {
			const dropped = r.records.filter(isDropped).length;
			return [
				[],
				['Sheet', r.sheet],
				['Header row', r.headerRow + 1],
				['Action', `${r.action.action}: ${r.action.why}`],
				['Category', `${r.category.category}: ${r.category.why}`],
				['Columns mapped', `${Object.keys(r.mapping).length} of ${r.columns.length}`],
				['Rows', r.records.length],
				['Moved forward', r.records.length - dropped],
				['Left out', dropped],
				['With issues', r.records.filter((x) => x.issues.some((i) => i.kind !== 'default')).length],
				...r.transforms.map((t) => ['Transform likely', t.message]),
			];
		}),
	]);

	const mapping: (string | number)[][] = [['Sheet', 'Column', 'Header', 'Field', 'Score', 'Status', 'Why']];
	for (const r of results) {
		const byColumn = new Map(Object.values(r.mapping).map((a) => [a.column, a]));
		const hints = new Map(r.suggestions.map((s) => [s.column, s]));
		for (const c of r.columns) {
			const a = byColumn.get(c.index);
			const hint = hints.get(c.index);
			const status = a ? (a.override ? 'mapping file' : 'mapped') : c.status === 'ignored' ? 'ignored' : hint ? `not mapped (maybe ${hint.field})` : 'not mapped';
			mapping.push([r.sheet, c.letter, c.header, a?.field ?? '', a ? Math.round(a.score * 100) / 100 : '', status, (a ?? hint)?.why.join('; ') ?? '']);
		}
		for (const m of r.missing) mapping.push([r.sheet, '', '', m.field, '', `missing (required for ${m.actions.join(', ')})`, 'no column holds it']);
	}
	add('Mapping', mapping);

	add('Data', recordRows(kept));

	const issues: (string | number)[][] = [['Sheet', 'Row', 'Name', 'Field', 'Value', 'Kind', 'Message', 'Left out']];
	for (const r of all) {
		const out = isDropped(r) ? 'yes' : '';
		for (const i of r.issues) issues.push([r.values['file.sheet'] ?? '', r.row, who(r), i.field, r.values[i.field] ?? '', KIND[i.kind], i.message.replace(/; row dropped$/, ''), out]);
	}
	add('Issues', issues);

	add('Left out', leftOutRows(all));

	return new Uint8Array(write(book, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}

// "Smith, Jane", or the billing entity's name.
const who = (r: RosterRecord) => [r.values['provider.last_name'], r.values['provider.first_name']].filter(Boolean).join(', ') || r.values['billing.legal_name'] || '';

// Every value as text (NPIs and ZIPs keep their leading zeros), a filter on the header, columns sized to fit.
function sheet(rows: readonly (readonly (string | number)[])[]): WorkSheet {
	const ws = utils.aoa_to_sheet(rows as (string | number)[][]);
	const header = rows[0] ?? [];
	if (rows.length > 1 && ws['!ref'] && header.length > 2) ws['!autofilter'] = { ref: ws['!ref'] };
	const widths: number[] = [];
	for (const row of rows) row.forEach((v, i) => (widths[i] = Math.max(widths[i] ?? 0, String(v).length)));
	ws['!cols'] = widths.map((w) => ({ wch: Math.min(60, Math.max(6, w + 1)) }));
	return ws;
}

/** One sheet of a batch, or a file that couldn't be mapped (`error`). */
export interface BatchEntry {
	file: string;
	sheet: string;
	action?: string;
	category?: string;
	rows?: number;
	movedForward?: number;
	leftOut?: number;
	withIssues?: number;
	/** The sheet's workbook, relative to the batch folder. */
	output?: string;
	/** Why nothing was written: unreadable, password-protected, no records, … */
	error?: string;
}

/** A sheet's line in the batch summary. `output`: its workbook's file name. */
export function sheetEntry(file: string, r: AutomapResult & { sheet: string }, output: string): BatchEntry {
	const leftOut = r.records.filter(isDropped).length;
	return {
		file, sheet: r.sheet, action: r.action.action, category: r.category.category, rows: r.records.length, movedForward: r.records.length - leftOut, leftOut,
		withIssues: r.records.filter((x) => x.issues.some((i) => i.kind !== 'default')).length, output,
	};
}

/** Files in one zip, for the UI's "Download all" (a browser can't save a folder). */
export function toZip(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
	const zip = CFB.utils.cfb_new();
	for (const f of files) CFB.utils.cfb_add(zip, f.name, f.bytes);
	return new Uint8Array(CFB.write(zip, { type: 'array', fileType: 'zip', compression: true }) as ArrayLike<number>);
}

/** The batch's summary workbook: one line per sheet written, or per file that failed, and why. */
export function toBatchSummary(entries: readonly BatchEntry[]): Uint8Array {
	const book = utils.book_new();
	const rows: (string | number)[][] = [['File', 'Sheet', 'Action', 'Category', 'Rows', 'Moved forward', 'Left out', 'With issues', 'Workbook', 'Error']];
	for (const e of entries) rows.push([e.file, e.sheet, e.action ?? '', e.category ?? '', e.rows ?? '', e.movedForward ?? '', e.leftOut ?? '', e.withIssues ?? '', e.output ?? '', e.error ?? '']);
	utils.book_append_sheet(book, sheet(rows), 'Files');
	return new Uint8Array(write(book, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}
