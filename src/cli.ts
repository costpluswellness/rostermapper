// Command-line interface. src/bin.ts runs it.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ACTIONS, type Action } from './action';
import { automap, type AutomapResult } from './automap';
import { toCsv } from './csv';
import { fieldList } from './fields';
import { FILE_CATEGORIES, outputName, type FileCategory } from './file';
import { bodyRows, detectHeaderRow } from './profile';
import { schema } from './schema.generated';
import { parseMapping } from './mapping';
import { openUi, type Session, type UiFiles } from './ui';
import { readWorkbook, type Sheet } from './workbook';
import { version } from '../package.json';

const HELP = `Map a provider roster file to the Roster Mapper schema.

Usage
  node dist/cli.js                    open the UI and upload a file there
  node dist/cli.js <file> [options]   open the UI with this file loaded
  node dist/cli.js fields [--json]    list the schema's fields

The UI opens by default. The options below set where it starts; you can change
them in the UI. With --no-ui, --json or when output is piped, results print to
the terminal instead.

Options
      --no-ui            print to the terminal instead of opening the UI
  -s, --sheet <name>     only this sheet (default: the first in the UI; in the
                         terminal, ask, or every sheet when not interactive)
  -a, --action <type>    the file's action: add, update or term (default: detected
                         from an action column, then TERM in the sheet or file
                         name, else add)
  -c, --category <kind>  what the file lists: individual or facility (default:
                         facility when the sheet or file name says so, else
                         individual when a column holds the provider's NPI,
                         name, birth date or gender)
      --header-row <n>   header is on row n (default: detected)
      --effective-date <YYYY-MM-DD>
                         use this date where a row's effective date is blank;
                         each filled row gets a note saying so
      --contract-id <id>  write this contract ID into every record
      --sender-email <email>
                         write the sender's email into every record
      --no-nppes         in the UI, don't send NPIs to the NPPES NPI Registry
      --no-census        in the UI, don't send addresses to the US Census
                         geocoder (both are on unless turned off here or in
                         the UI; checks that need no lookup always run)
      --why              show the reasons behind each mapping
  -m, --mapping <file>   a CSV of overrides, "column,field" per line: the field
                         for a header, or "ignore" to skip that column
  -o, --output <path>    write the roster: one record per row, every field, plus
                         the row number and issues. A .csv or .json file holds
                         every sheet; a directory gets one CSV per sheet with
                         records, named RM_<file>_<sheet>.csv
      --json             print the full result (mapping and records) as JSON
  -v, --version          print the version
  -h, --help             print this help

Examples
  node dist/cli.js roster.xlsx
  node dist/cli.js roster.xlsx --sheet "Adds" --action term
  node dist/cli.js roster.xlsx --mapping sender-overrides.csv
  node dist/cli.js roster.xlsx --no-ui --why
  node dist/cli.js roster.xlsx -o clean.csv
  node dist/cli.js roster.xlsx -o out/     # out/RM_roster_Sheet1.csv
`;

interface Output {
	write(text: string): unknown;
}

export interface Io {
	out: Output;
	err: Output;
	/** Ask the user to pick from several sheets. Absent when no one is at a terminal. */
	chooseSheet?: (file: string, sheets: Sheet[]) => Promise<Sheet[] | null>;
	/** Open the browser UI. Absent when output is piped. */
	openUi?: (session: Session, files?: UiFiles) => Promise<string>;
}

const defaultIo = (): Io => ({
	out: process.stdout,
	err: process.stderr,
	...(process.stdin.isTTY && process.stderr.isTTY ? { chooseSheet: askForSheet } : {}),
	...(process.stdout.isTTY ? { openUi } : {}),
});

/** Run the CLI with arguments (without "node" and the script path). Resolves to the exit code. */
export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
	const { out, err } = io;
	let args;
	try {
		args = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				'no-ui': { type: 'boolean' },
				sheet: { type: 'string', short: 's' },
				mapping: { type: 'string', short: 'm' },
				action: { type: 'string', short: 'a' },
				category: { type: 'string', short: 'c' },
				'header-row': { type: 'string' },
				'effective-date': { type: 'string' },
				'contract-id': { type: 'string' },
				'sender-email': { type: 'string' },
				'no-nppes': { type: 'boolean' },
				'no-census': { type: 'boolean' },
				why: { type: 'boolean' },
				json: { type: 'boolean' },
				output: { type: 'string', short: 'o' },
				version: { type: 'boolean', short: 'v' },
				help: { type: 'boolean', short: 'h' },
			},
		});
	} catch (e) {
		err.write(`${(e as Error).message}\nRun "node dist/cli.js --help" for usage.\n`);
		return 1;
	}
	const { values: opts, positionals } = args;

	if (opts.version) return print(out, version);
	if (opts.help) return print(out, HELP.trimEnd());
	if (!positionals.length) {
		if (!io.openUi || opts['no-ui']) return print(err, HELP.trimEnd(), 1);
		const effectiveDate = parseDate(opts['effective-date'], err);
		if (effectiveDate === null) return 1;
		return startUi(io, { ...lookups(opts), ...(effectiveDate && { effectiveDate }), ...withInputs(opts) });
	}
	if (positionals[0] === 'fields') return fields(out, opts.json);
	return map(positionals[0]!, opts, io);
}

interface MapOptions {
	'no-ui'?: boolean | undefined;
	mapping?: string | undefined;
	sheet?: string | undefined;
	action?: string | undefined;
	category?: string | undefined;
	'header-row'?: string | undefined;
	'effective-date'?: string | undefined;
	'contract-id'?: string | undefined;
	'sender-email'?: string | undefined;
	'no-nppes'?: boolean | undefined;
	'no-census'?: boolean | undefined;
	why?: boolean | undefined;
	json?: boolean | undefined;
	output?: string | undefined;
}

async function map(file: string, opts: MapOptions, io: Io): Promise<number> {
	const { out, err, chooseSheet, openUi } = io;
	let headerRow: number | undefined;
	if (opts['header-row'] !== undefined) {
		headerRow = Number(opts['header-row']) - 1;
		if (!Number.isInteger(headerRow) || headerRow < 0) {
			err.write(`--header-row must be a whole number of 1 or more.\n`);
			return 1;
		}
	}

	const effectiveDate = parseDate(opts['effective-date'], err);
	if (effectiveDate === null) return 1;

	const toDir = opts.output !== undefined && isDirectory(opts.output);
	const format = opts.output === undefined || toDir ? undefined : extname(opts.output).toLowerCase();
	if (format !== undefined && format !== '.csv' && format !== '.json') {
		err.write(`--output must be a directory or end in .csv or .json.\n`);
		return 1;
	}

	let action: Action | undefined;
	if (opts.action !== undefined) {
		action = ACTIONS.find((a) => a === opts.action!.toUpperCase());
		if (!action) {
			err.write(`--action must be add, update or term.\n`);
			return 1;
		}
	}

	let category: FileCategory | undefined;
	if (opts.category !== undefined) {
		category = FILE_CATEGORIES.find((c) => c === opts.category!.toLowerCase());
		if (!category) {
			err.write(`--category must be individual or facility.\n`);
			return 1;
		}
	}

	let mapping: { name: string; bytes: Uint8Array; overrides: Record<string, string> } | undefined;
	if (opts.mapping !== undefined) {
		try {
			const bytes = readFileSync(opts.mapping);
			const { overrides, errors } = parseMapping(readWorkbook(bytes)[0]?.rows ?? []);
			for (const e of errors) err.write(`${opts.mapping}, ${e}\n`);
			mapping = { name: basename(opts.mapping), bytes, overrides };
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			err.write(code === 'ENOENT' ? `Mapping file not found: ${opts.mapping}\n` : `Could not read ${opts.mapping}: ${(e as Error).message}\n`);
			return 1;
		}
	}

	let sheets, everySheet;
	try {
		sheets = readWorkbook(readFileSync(file));
		everySheet = sheets;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		err.write(code === 'ENOENT' ? `File not found: ${file}\n` : `Could not read ${file}: ${(e as Error).message}\n`);
		return 1;
	}

	if (opts.sheet !== undefined) {
		const match = sheets.filter((s) => s.name === opts.sheet);
		if (!match.length) {
			err.write(`No sheet named "${opts.sheet}". Sheets: ${sheets.map((s) => s.name).join(', ')}\n`);
			return 1;
		}
		sheets = match;
	}
	sheets = sheets.filter((s) => s.rows.length);
	const ui = openUi && !opts['no-ui'] && !opts.json ? openUi : undefined;

	if (!ui && opts.sheet === undefined && sheets.length > 1 && chooseSheet) {
		const chosen = await chooseSheet(file, sheets);
		if (!chosen) return 1;
		sheets = chosen;
	}

	const results = sheets.map((s) => ({
		sheet: s.name,
		...automap(s.rows, { fileName: basename(file), sheetName: s.name, headerRow, action, category, overrides: mapping?.overrides, constants: inputs(opts), effectiveDate }),
	}));

	if (opts.output && toDir) {
		for (const r of results) {
			if (!r.records.length) {
				err.write(`${r.sheet}: no records, nothing written\n`);
				continue;
			}
			const path = join(opts.output, outputName(r.file, 'csv'));
			writeFileSync(path, toCsv(r.records));
			err.write(`Wrote ${r.records.length} records to ${path} (${r.records.filter(hasProblem).length} with issues)\n`);
		}
	} else if (opts.output) {
		const records = results.flatMap((r) => r.records);
		writeFileSync(opts.output, format === '.csv' ? toCsv(records) : JSON.stringify(records, null, 2) + '\n');
		err.write(`Wrote ${records.length} records to ${opts.output} (${records.filter(hasProblem).length} with issues)\n`);
	}

	if (mapping && !ui) {
		const unused = [...new Set(results.flatMap((r) => r.unusedOverrides))].filter((h) => results.every((r) => r.unusedOverrides.includes(h)));
		if (unused.length) err.write(`${mapping.name}: no column named ${unused.map((h) => `"${h}"`).join(', ')}\n`);
	}

	if (ui) {
		const session = { name: basename(file), mappingName: mapping?.name, sheet: opts.sheet, headerRow, action, category, effectiveDate, ...withInputs(opts), ...lookups(opts) };
		return startUi({ ...io, openUi: ui }, session, { sheets: everySheet, mapping: mapping?.bytes });
	} else if (opts.json) out.write(JSON.stringify({ file, sheets: results }, null, 2) + '\n');
	else for (const result of results) out.write(table(result, opts.why ?? false));
	return 0;
}

async function startUi({ err, openUi }: Io, session: Session, files: UiFiles = {}): Promise<number> {
	try {
		const url = await openUi!(session, files);
		err.write(`Roster Mapper → ${url}\nPress Ctrl+C to stop. Use --no-ui to print to the terminal instead.\n`);
		return 0;
	} catch (e) {
		err.write(`Could not open the UI: ${(e as Error).message}\n`);
		return 1;
	}
}

function table(result: AutomapResult & { sheet: string }, why: boolean): string {
	const assigned = new Map(Object.values(result.mapping).map((a) => [a.column, a]));
	const suggested = new Map(result.suggestions.map((s) => [s.column, s]));
	const width = Math.min(40, Math.max(6, ...result.columns.map((c) => oneLine(c.header).length)));
	const lines = [
		'',
		`${result.sheet} · header on row ${result.headerRow + 1} · ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'} · ` +
			`${assigned.size} of ${fieldList(schema).length} fields mapped`,
		`action ${result.action.action} · ${result.action.why}`,
		`category ${result.category.category} · ${result.category.why}`,
		...result.transforms.map((t) => `transform likely · ${t.message}`),
		...missingLines(result),
		recordsLine(result),
		'',
	];
	for (const column of result.columns) {
		const a = assigned.get(column.index);
		const hint = suggested.get(column.index);
		const target = a ? `${a.field}  ${a.score.toFixed(2)}` : column.status === 'ignored' ? '(ignored)' : hint ? `- (maybe ${hint.field})` : '-';
		const header = (oneLine(column.header) || '(blank)').slice(0, width).padEnd(width);
		lines.push(`  ${column.letter.padEnd(3)} ${header}  ${column.type.padEnd(8)}  ${target}`);
		if (why && a) lines.push(`      ${''.padEnd(width)}  ${''.padEnd(8)}  ${a.why.join('; ')}`);
	}
	return lines.join('\n') + '\n';
}

// Numbered menu on stderr, so stdout stays clean for --json. Enter picks the first sheet.
async function askForSheet(file: string, sheets: Sheet[]): Promise<Sheet[] | null> {
	const width = Math.max(...sheets.map((s) => s.name.length));
	process.stderr.write(`\n${file} has ${sheets.length} sheets:\n`);
	sheets.forEach((s, i) => {
		const rows = bodyRows(s.rows, detectHeaderRow(s.rows)).length;
		process.stderr.write(`  ${String(i + 1).padStart(2)}  ${s.name.padEnd(width)}  ${rows} ${rows === 1 ? 'row' : 'rows'}\n`);
	});
	process.stderr.write(`   a  all sheets\n`);

	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		for (;;) {
			const answer = (await rl.question('Sheet [1]: ')).trim();
			if (answer.toLowerCase() === 'a') return sheets;
			const n = answer === '' ? 1 : Number(answer);
			const sheet = sheets[n - 1] ?? sheets.find((s) => s.name === answer);
			if (sheet) return [sheet];
			process.stderr.write(`Enter 1-${sheets.length}, a sheet name, or "a".\n`);
		}
	} catch {
		return null; // Ctrl+C or end of input
	} finally {
		rl.close();
	}
}

// A record with an issue other than a note (the effective date default is a note, not a problem).
const hasProblem = (r: { issues: { kind: string }[] }) => r.issues.some((i) => i.kind !== 'default');

// "17 records · 3 with issues (2 missing provider.npi, …)"
function recordsLine({ records }: AutomapResult): string {
	const counts = new Map<string, number>();
	for (const { issues } of records) {
		for (const { field, kind } of issues) {
			const key = `${kind === 'format' ? 'unreadable' : kind === 'default' ? 'defaulted' : kind} ${field}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	const flagged = records.filter(hasProblem).length;
	const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([what, n]) => `${n} ${what}`);
	return `${records.length} records · ${flagged} with issues${top.length ? ` (${top.join(', ')}${counts.size > 3 ? ', …' : ''})` : ''}`;
}

// "missing for ADD: provider.degree, practice.phone", one line per action.
function missingLines({ missing }: AutomapResult): string[] {
	const byAction = new Map<string, string[]>();
	for (const { field, actions } of missing) for (const a of actions) byAction.set(a, [...(byAction.get(a) ?? []), field]);
	return [...byAction].map(([action, fields]) => `missing for ${action}: ${fields.join(', ')}`);
}

function fields(out: Output, json = false): number {
	const all = fieldList(schema).map(({ id, spec }) => ({ id, type: spec.type, required: spec.required ?? [], preferred: spec.preferred ?? [], description: spec.description }));
	if (json) return print(out, JSON.stringify(all, null, 2));
	const width = Math.max(...all.map((f) => f.id.length));
	const req = (f: (typeof all)[number]) => ACTIONS.map((a) => (f.required.includes(a) ? 'R' : f.preferred.includes(a) ? 'p' : '·')).join('');
	return print(out, `${'field'.padEnd(width)}  ${'type'.padEnd(7)}  AUT  description\n` +
		all.map((f) => `${f.id.padEnd(width)}  ${f.type.padEnd(7)}  ${req(f)}  ${f.description}`).join('\n') +
		'\n\nAUT = level for ADD, UPDATE, TERM: R required (rows missing it are flagged), p preferred, · optional');
}

function print(out: Output, text: string, code = 0): number {
	out.write(text + '\n');
	return code;
}

// The lookups turned off with --no-nppes / --no-census. Unset ones are left out, so the UI uses the browser's saved choice.
const lookups = (opts: { 'no-nppes'?: boolean | undefined; 'no-census'?: boolean | undefined }): Pick<Session, 'nppes' | 'census'> => ({
	...(opts['no-nppes'] && { nppes: false }),
	...(opts['no-census'] && { census: false }),
});

// --contract-id and --sender-email: the input fields, typed once and written into every record.
function inputs(opts: Pick<MapOptions, 'contract-id' | 'sender-email'>): Record<string, string> {
	const values: Record<string, string> = {};
	if (opts['contract-id']?.trim()) values['network.contract_id'] = opts['contract-id'].trim();
	if (opts['sender-email']?.trim()) values['network.sender_email'] = opts['sender-email'].trim();
	return values;
}

const withInputs = (opts: Pick<MapOptions, 'contract-id' | 'sender-email'>) => {
	const values = inputs(opts);
	return Object.keys(values).length ? { inputs: values } : {};
};

// --effective-date: undefined when absent, null (after saying why) when it isn't a real YYYY-MM-DD date.
function parseDate(value: string | undefined, err: Output): string | undefined | null {
	if (value === undefined) return undefined;
	const d = new Date(`${value}T00:00:00Z`);
	if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)) return value;
	err.write(`--effective-date must be a date as YYYY-MM-DD, like 2026-12-01.\n`);
	return null;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
