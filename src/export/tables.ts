// The result of mapping one file as tables, header row first: what was decided (Summary, Mapping),
// what moves forward (Data) and what didn't (Issues, Left out). The CLI's workbook writes them as tabs
// (report.ts); the UI's Results shows the same tables. Pure: no SheetJS.
import type { AutomapResult } from '../map/automap';
import { isDropped, type Issue, type RosterRecord } from '../standardize/records';
import { leftOutRows, recordRows } from './csv';

/** One sheet's automap result, with the sheet's name. */
export type SheetResult = AutomapResult & { sheet: string };

export type Cell = string | number;
export type Table = Cell[][];

export interface ReportOptions {
	/** Write dropped rows to the Data tab too (they're on Left out either way). */
	keepDropped?: boolean | undefined;
	/** Extra Summary lines, label → value: the lookups used, the tool's version, … */
	notes?: Readonly<Record<string, string>> | undefined;
}

export interface ReportTables {
	Summary: Table;
	Mapping: Table;
	Data: Table;
	Issues: Table;
	'Left out': Table;
}

/** Issue kinds as the report names them. */
export const ISSUE_KIND: Record<Issue['kind'], string> = { missing: 'missing', format: 'unreadable', invalid: 'rejected', warning: 'warning', default: 'note' };

/** A record with an issue other than a note (the effective date default is a note, not a problem). */
export const hasProblem = (r: { issues: readonly { kind: string }[] }): boolean => r.issues.some((i) => i.kind !== 'default');

/** Row counts for a sheet's records: rows, moved forward, left out, with issues. */
export function counts(records: readonly RosterRecord[]): { rows: number; movedForward: number; leftOut: number; withIssues: number } {
	const leftOut = records.filter(isDropped).length;
	return { rows: records.length, movedForward: records.length - leftOut, leftOut, withIssues: records.filter(hasProblem).length };
}

/** "Smith, Jane", or the billing entity's name. */
export const who = (r: RosterRecord): string =>
	[r.values['provider.last_name'], r.values['provider.first_name']].filter(Boolean).join(', ') || r.values['billing.legal_name'] || '';

/**
 * The report for a file's sheets:
 * - Summary: per sheet, the header row, action and category (and why), and row counts.
 * - Mapping: each column of the file and the field it went to (or why not), then required fields nothing filled.
 * - Data: the rows that move forward, as in the CSV output.
 * - Issues: one line per problem, on every row, kept or left out; filter on "Left out".
 * - Left out: each dropped row, the reason, and its values, so it can be fixed and sent again.
 */
export function reportTables(file: string, results: readonly SheetResult[], { keepDropped = false, notes = {} }: ReportOptions = {}): ReportTables {
	const all = results.flatMap((r) => r.records);
	return {
		Summary: [['File', file], ...Object.entries(notes), ...results.flatMap(summaryRows)],
		Mapping: mappingRows(results),
		Data: recordRows(keepDropped ? all : all.filter((r) => !isDropped(r))),
		Issues: issueRows(all),
		'Left out': leftOutRows(all),
	};
}

function summaryRows(r: SheetResult): Table {
	const c = counts(r.records);
	return [
		[],
		['Sheet', r.sheet],
		['Header row', r.headerRow + 1],
		['Action', `${r.action.action}: ${r.action.why}`],
		['Category', `${r.category.category}: ${r.category.why}`],
		['Columns mapped', `${Object.keys(r.mapping).length} of ${r.columns.length}`],
		['Rows', c.rows],
		['Moved forward', c.movedForward],
		['Left out', c.leftOut],
		['With issues', c.withIssues],
		...r.transforms.map((t) => ['Transform likely', t.message]),
	];
}

/** Each column and the field it went to, or why not; then required fields no column holds. */
export function mappingRows(results: readonly SheetResult[]): Table {
	const rows: Table = [['Sheet', 'Column', 'Header', 'Field', 'Score', 'Status', 'Why']];
	for (const r of results) {
		const byColumn = new Map(Object.values(r.mapping).map((a) => [a.column, a]));
		const hints = new Map(r.suggestions.map((s) => [s.column, s]));
		for (const c of r.columns) {
			const a = byColumn.get(c.index);
			const hint = hints.get(c.index);
			const status = a ? (a.override ? 'mapping file' : 'mapped') : c.status === 'ignored' ? 'ignored' : hint ? `not mapped (maybe ${hint.field})` : 'not mapped';
			rows.push([r.sheet, c.letter, c.header, a?.field ?? '', a ? Math.round(a.score * 100) / 100 : '', status, (a ?? hint)?.why.join('; ') ?? '']);
		}
		for (const m of r.missing) rows.push([r.sheet, '', '', m.field, '', `missing (required for ${m.actions.join(', ')})`, 'no column holds it']);
	}
	return rows;
}

/** One line per issue, on every row, with whether the row was left out. */
export function issueRows(records: readonly RosterRecord[]): Table {
	const rows: Table = [['Sheet', 'Row', 'Name', 'Field', 'Value', 'Kind', 'Message', 'Left out']];
	for (const r of records) {
		const out = isDropped(r) ? 'yes' : '';
		for (const i of r.issues) rows.push([r.values['file.sheet'] ?? '', r.row, who(r), i.field, r.values[i.field] ?? '', ISSUE_KIND[i.kind], i.message.replace(/; row dropped$/, ''), out]);
	}
	return rows;
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
export function sheetEntry(file: string, r: SheetResult, output: string): BatchEntry {
	return { file, sheet: r.sheet, action: r.action.action, category: r.category.category, ...counts(r.records), output };
}

/** The batch summary's one table: a line per sheet written, or per file that failed, and why. */
export function batchRows(entries: readonly BatchEntry[]): Table {
	const rows: Table = [['File', 'Sheet', 'Action', 'Category', 'Rows', 'Moved forward', 'Left out', 'With issues', 'Workbook', 'Error']];
	for (const e of entries) rows.push([e.file, e.sheet, e.action ?? '', e.category ?? '', e.rows ?? '', e.movedForward ?? '', e.leftOut ?? '', e.withIssues ?? '', e.output ?? '', e.error ?? '']);
	return rows;
}
