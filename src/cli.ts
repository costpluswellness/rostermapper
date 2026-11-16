// Command-line interface. src/bin.ts runs it.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ACTIONS, type Action } from './action';
import { automap, type AutomapResult } from './automap';
import { autoFixes, checkIssues, lookupTargets, nameKey, nameSearches, recordChecks, type Lookups, type Sources } from './checks';
import { toCsv, toIssuesCsv } from './csv';
import { fieldList } from './fields';
import { FILE_CATEGORIES, outputName, type FileCategory } from './file';
import { bodyRows, detectHeaderRow } from './profile';
import { schema } from './schema.generated';
import { parseMapping } from './mapping';
import { lookupAddress, lookupNpi, searchNpiByName } from './lookup';
import { isDropped, type RosterRecord } from './records';
import type { CensusMatch, NppesRecord } from './validate';
import { openUi, type Session, type UiFiles } from './ui';
import { readWorkbook, type Sheet } from './workbook';
import { version } from '../package.json';

const HELP = `Map a provider roster file to the Roster Mapper schema.

Usage
  node dist/cli.js                    open the UI and upload a file there
  node dist/cli.js <file> [options]   open the UI with this file loaded
  node dist/cli.js fields [--json]    list the schema's fields

The UI opens by default. The options below set where it starts; you can change
them in the UI. With --no-ui, --json or when output is piped, every step runs in
the terminal instead: map, standardize, validate (NPPES and Census lookups) and,
with -o, export.

Rows that can't move forward are dropped from the output and written, with the
reason, to an issues file next to it (*_issues.csv, always written with -o): no NPI (blank or N/A), an NPI that fails standardization, an NPI NPPES
doesn't have, has deactivated or lists under a different first and last name.

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
      --no-nppes         don't send NPIs to the NPPES NPI Registry
      --no-census        don't send addresses to the US Census geocoder (both
                         are on unless turned off here or in the UI; checks
                         that need no lookup always run)
      --keep-dropped     write dropped rows to the output too (with -o); they
                         are listed in the *_issues.csv file either way
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
  node dist/cli.js roster.xlsx -o clean.csv       # rows left out, and why: clean_issues.csv
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
	/** NPPES and Census lookups, for Validate without the UI. Default: the live sources. */
	lookup?: {
		npi(npi: string): Promise<NppesRecord | null>;
		address(line: string): Promise<CensusMatch | null>;
		byName(query: { first: string; last: string; state: string }): Promise<NppesRecord[]>;
	};
	/** Show lookup progress ("Checking 12 of 40…"). Default: when stderr is a terminal. */
	progress?: boolean;
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
				'keep-dropped': { type: 'boolean' },
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
	'keep-dropped'?: boolean | undefined;
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

	if (!ui) await validate(results.flatMap((r) => r.records), { nppes: !opts['no-nppes'], census: !opts['no-census'] }, io);

	// The output holds the rows that move forward; the issues file every row left out, and why.
	const keep = opts['keep-dropped'] ?? false;
	const write = (path: string, records: RosterRecord[], asJson: boolean) =>
		writeFileSync(path, asJson ? JSON.stringify(records, null, 2) + '\n' : toCsv(records));
	const wrote = (path: string, records: RosterRecord[], dropped: RosterRecord[], issuesPath: string) =>
		err.write(`Wrote ${records.length} records to ${path} (${records.filter(hasProblem).length} with issues)` +
			`; ${dropped.length} ${dropped.length === 1 ? 'row' : 'rows'} left out${keep && dropped.length ? ' (kept in the output by --keep-dropped)' : ''}, listed with why in ${issuesPath}\n`);
	if (opts.output && toDir) {
		for (const r of results) {
			if (!r.records.length) {
				err.write(`${r.sheet}: no records, nothing written\n`);
				continue;
			}
			const dropped = r.records.filter(isDropped);
			const records = keep ? r.records : r.records.filter((x) => !isDropped(x));
			const path = join(opts.output, outputName(r.file, 'csv'));
			const issuesPath = join(opts.output, outputName(r.file, 'csv', '_issues'));
			write(path, records, false);
			writeFileSync(issuesPath, toIssuesCsv(r.records));
			wrote(path, records, dropped, issuesPath);
		}
	} else if (opts.output) {
		const all = results.flatMap((r) => r.records);
		const dropped = all.filter(isDropped);
		const records = keep ? all : all.filter((x) => !isDropped(x));
		const issuesPath = opts.output.slice(0, -format!.length) + '_issues.csv';
		write(opts.output, records, format === '.json');
		writeFileSync(issuesPath, toIssuesCsv(all));
		wrote(opts.output, records, dropped, issuesPath);
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

// Validate without the UI: look up every NPI and address (4 at a time), then search NPPES by name for
// providers whose NPI has another last name. Apply what the UI applies on its own (Census addresses,
// NPPES legal names) and add the checks' failures and warnings to each record's issues.
async function validate(records: RosterRecord[], on: Sources, io: Io): Promise<void> {
	if (!records.length || (!on.nppes && !on.census)) return;
	const lookup = io.lookup ?? { npi: lookupNpi, address: lookupAddress, byName: searchNpiByName };
	const { npis, lines } = lookupTargets(records.map((r) => r.values));
	const lookups: Lookups = { nppes: new Map(), census: new Map(), names: new Map() };
	const progress = io.progress ?? !!process.stderr.isTTY;
	const answer = <T>(p: Promise<T>) => p.catch((e: Error) => ({ error: e.message }));
	const runAll = async (jobs: (() => Promise<void>)[]) => {
		let done = 0;
		const total = jobs.length;
		await Promise.all(Array.from({ length: 4 }, async () => {
			for (let job; (job = jobs.shift()); ) {
				await job();
				if (progress) io.err.write(`\rChecking ${++done} of ${total}…`);
			}
		}));
		if (progress && done) io.err.write('\r\x1b[K');
	};
	await runAll([
		...(on.nppes ? [...npis] : []).map((n) => async () => void lookups.nppes.set(n, await answer(lookup.npi(n)))),
		...(on.census ? [...lines] : []).map((l) => async () => void lookups.census.set(l, await answer(lookup.address(l)))),
	]);
	if (on.nppes) await runAll(nameSearches(records.map((r) => r.values), lookups).map((q) => async () => void lookups.names!.set(nameKey(q), await answer(lookup.byName(q)))));
	for (const record of records) {
		const checks = recordChecks(record.values, lookups, on);
		const fixes = autoFixes(checks);
		for (const [field, value] of Object.entries(fixes)) {
			record.values[field] = value;
			checks.delete(field);
		}
		record.issues = record.issues.filter((i) => !(i.field in fixes && (i.kind === 'missing' || i.kind === 'format')));
		record.issues.push(...checkIssues(checks));
	}
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
		...droppedLines(result),
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
			const key = `${kind === 'format' ? 'unreadable' : kind === 'default' ? 'defaulted' : kind === 'invalid' ? 'rejected' : kind} ${field}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	const flagged = records.filter(hasProblem).length;
	const dropped = records.filter(isDropped).length;
	const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([what, n]) => `${n} ${what}`);
	return `${records.length} records · ${dropped} dropped · ${flagged} with issues${top.length ? ` (${top.join(', ')}${counts.size > 3 ? ', …' : ''})` : ''}`;
}

// One line per dropped row, with why: "  dropped row 12 (Smith, Jane): provider.npi: no NPI; row dropped".
function droppedLines({ records }: AutomapResult, max = 20): string[] {
	const dropped = records.filter(isDropped);
	const line = (r: RosterRecord) => {
		const who = [r.values['provider.last_name'], r.values['provider.first_name']].filter(Boolean).join(', ') || r.values['billing.legal_name'] || '';
		return `  dropped row ${r.row}${who ? ` (${who})` : ''}: ${r.issues.filter((i) => i.drop).map((i) => `${i.field}: ${i.message}`).join('; ')}`;
	};
	return [...dropped.slice(0, max).map(line), ...(dropped.length > max ? [`  … and ${dropped.length - max} more dropped rows`] : [])];
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
