// Command-line interface: parse the arguments, run the pipeline (see node.ts and pipeline.ts) and say
// what happened. src/cli/bin.ts runs it.
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ACTIONS, type Action } from '../map/action';
import { fieldList } from '../schema/fields';
import { schema } from '../schema/schema.generated';
import { FILE_CATEGORIES, type FileCategory } from '../map/file';
import { bodyRows, detectHeaderRow } from '../map/profile';
import { isDropped } from '../standardize/records';
import { toCsv, toIssuesCsv } from '../export/csv';
import { toReport } from '../export/report';
import { hasProblem, type ReportOptions, type SheetResult } from '../export/tables';
import type { LookupFns } from '../validate/checks';
import { runSheets, STEPS, STEP_SUMMARY, StoppedEarly, type OnStep, type StepEvent } from '../pipeline';
import type { Sheet } from '../read/workbook';
import {
	cacheFile, diskCacheOn, isDirectory, liveLookup, lookupStats, mapFiles, OUTPUT_DIR, readMappingFile, readRoster, useDiskCache, writeOutput,
} from '../node';
import { fieldsText, mappingTable, sheetSummary, stepReport } from './print';
import { openUi, type Session, type UiFiles } from './server';
import { version } from '../../package.json';

const HELP = `Map provider roster files to the Roster Mapper schema.

Usage
  rostermapper <file> [options]      run every step and save the result to output/
  rostermapper <file|folder>...      several files (or every one in a folder), into
                                     output/<date-time>/, with a summary.xlsx
  rostermapper <file> --steps        the same, one step at a time, showing each
                                     step's result (to debug a roster)
  rostermapper <file> --ui           open the UI with this file loaded
  rostermapper                       open the UI and upload files there
  rostermapper fields [--json]       list the schema's fields

Steps
${STEPS.map((s, i) => `  ${i + 1}. ${s.padEnd(12)} ${STEP_SUMMARY[s]}`).join('\n')}

The output is one workbook per sheet, RM_<file>_<sheet>.xlsx, with Summary,
Mapping, Data, Issues and Left out tabs. Rows that can't move forward are left
out of Data and listed, with the reason, on Left out: no NPI (blank or N/A), an
NPI that fails standardization, one NPPES doesn't have, has deactivated or lists
under a different first and last name, or an ADD with no TIN.

Options
  -s, --sheet <name>     only this sheet (default: ask, or every sheet when not
                         interactive; the UI opens the first)
  -a, --action <type>    the file's action: add, update or term (default: from an
                         action column, then TERM in the sheet or file name, else add)
  -c, --category <kind>  individual or facility (default: facility when the sheet
                         or file name says so, else from the columns)
      --header-row <n>   header is on row n (default: detected)
      --effective-date <YYYY-MM-DD>
                         for rows whose effective date is blank (each gets a note)
      --contract-id <id>        write this contract ID into every record
      --sender-email <email>    write the sender's email into every record
      --allow <field=values>    keep these values as written instead of flagging
                         them, for a field with a fixed list (repeatable):
                         --allow provider_type=AHP,PHYS
  -m, --mapping <file>   a CSV of overrides, "column,field" per line: the field
                         for a header, or "ignore" to skip that column
      --no-nppes         don't send NPIs to the NPPES NPI Registry
      --no-census        don't send addresses to the US Census geocoder
      --no-cache         look everything up again (answers are otherwise kept in
                         ~/.cache/rostermapper/lookups.json between runs)
  -o, --output <path>    a folder (default: output/), or one file: .xlsx (every
                         sheet in one workbook), .csv or .json (the records, with
                         the rows left out in <name>_issues.csv)
      --keep-dropped     write dropped rows to Data (or the .csv/.json) too
      --steps            run one step at a time and print each step's result;
                         in a terminal, wait for Enter between steps (q stops)
      --why              print the mapping and the reasons behind it
      --json             print the full result (mapping and records) as JSON
      --ui               open the UI in the browser instead
      --send <url>       with --ui: a "Send" button next to Download that POSTs
                         the result (every sheet's records, mapping and counts)
                         as JSON to this URL, with the page's query string
  -v, --version          print the version
  -h, --help             print this help

Examples
  rostermapper roster.xlsx                    # output/RM_roster_Sheet1.xlsx
  rostermapper roster.xlsx --steps            # debug: see each step's result
  rostermapper roster.xlsx --sheet "Adds" --action term
  rostermapper roster.xlsx --mapping sender-overrides.csv
  rostermapper inbox/                         # output/20261117-143005/RM_….xlsx + summary.xlsx
  rostermapper roster.xlsx -o result.xlsx     # every sheet in one workbook
  rostermapper roster.xlsx -o clean.csv       # rows left out, and why: clean_issues.csv
`;

interface Output {
	write(text: string): unknown;
}

export interface Io {
	out: Output;
	err: Output;
	/** Ask the user to pick from several sheets. Absent when no one is at a terminal. */
	chooseSheet?: (file: string, sheets: Sheet[]) => Promise<Sheet[] | null>;
	/** --steps: wait before the next step; resolves to false to stop. Absent when no one is at a terminal. */
	pause?: (next: string) => Promise<boolean>;
	/** Open the browser UI. */
	openUi?: (session: Session, files?: UiFiles) => Promise<string>;
	/** stdout is a terminal: with no file and no --ui, open the UI rather than print the help. */
	terminal?: boolean;
	/** NPPES and Census lookups, for Validate. Default: the live sources. */
	lookup?: LookupFns;
	/** Show lookup progress ("Checking 12 of 40…"). Default: when stderr is a terminal. */
	progress?: boolean;
}

const interactive = () => !!(process.stdin.isTTY && process.stderr.isTTY);
const defaultIo = (): Io => ({
	out: process.stdout,
	err: process.stderr,
	...(interactive() ? { chooseSheet: askForSheet, pause: askToContinue } : {}),
	openUi,
	terminal: !!process.stdout.isTTY,
});

const OPTIONS = {
	ui: { type: 'boolean' },
	send: { type: 'string' },
	'no-ui': { type: 'boolean' }, // the default now; still accepted
	sheet: { type: 'string', short: 's' },
	mapping: { type: 'string', short: 'm' },
	action: { type: 'string', short: 'a' },
	category: { type: 'string', short: 'c' },
	'header-row': { type: 'string' },
	'effective-date': { type: 'string' },
	'contract-id': { type: 'string' },
	'sender-email': { type: 'string' },
	allow: { type: 'string', multiple: true },
	'no-nppes': { type: 'boolean' },
	'no-census': { type: 'boolean' },
	'keep-dropped': { type: 'boolean' },
	'no-cache': { type: 'boolean' },
	steps: { type: 'boolean' },
	why: { type: 'boolean' },
	json: { type: 'boolean' },
	output: { type: 'string', short: 'o' },
	version: { type: 'boolean', short: 'v' },
	help: { type: 'boolean', short: 'h' },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

/** The flags every run shares, checked: undefined (after saying why on stderr) when one is wrong. */
interface Settings {
	headerRow?: number | undefined;
	effectiveDate?: string | undefined;
	action?: Action | undefined;
	category?: FileCategory | undefined;
	constants: Record<string, string>;
	mapping?: ReturnType<typeof readMappingFile> | undefined;
	/** --allow: enum field id → values kept as written. */
	allowed?: Record<string, string[]> | undefined;
}

/** Run the CLI with arguments (without "node" and the script path). Resolves to the exit code. */
export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
	const { out, err } = io;
	let opts: Flags, positionals: string[];
	try {
		({ values: opts, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }));
	} catch (e) {
		err.write(`${(e as Error).message}\nRun "rostermapper --help" for usage.\n`);
		return 1;
	}

	if (opts.version) return print(out, version);
	if (opts['no-cache']) useDiskCache(false);
	if (opts.help) return print(out, HELP.trimEnd());
	if (positionals[0] === 'fields') return print(out, fieldsText(opts.json));

	const settings = check(opts, err);
	if (!settings) return 1;
	if (!positionals.length) {
		if (!io.openUi || !(opts.ui || io.terminal)) return print(err, HELP.trimEnd(), 1);
		return startUi(io, { ...lookups(opts), ...(settings.effectiveDate && { effectiveDate: settings.effectiveDate }), ...withInputs(settings) }, {}, opts.send);
	}
	if (positionals.length > 1 || isDirectory(positionals[0]!)) return bulk(positionals, opts, settings, io);
	return single(positionals[0]!, opts, settings, io);
}

function check(opts: Flags, err: Output): Settings | undefined {
	const fail = (message: string) => void err.write(`${message}\n`);
	const settings: Settings = { constants: {} };
	if (opts['header-row'] !== undefined) {
		settings.headerRow = Number(opts['header-row']) - 1;
		if (!Number.isInteger(settings.headerRow) || settings.headerRow < 0) return fail('--header-row must be a whole number of 1 or more.');
	}
	const date = opts['effective-date'];
	if (date !== undefined) {
		const d = new Date(`${date}T00:00:00Z`);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(d.getTime()) || !d.toISOString().startsWith(date)) return fail('--effective-date must be a date as YYYY-MM-DD, like 2026-12-01.');
		settings.effectiveDate = date;
	}
	if (opts.action !== undefined) {
		settings.action = ACTIONS.find((a) => a === opts.action!.toUpperCase());
		if (!settings.action) return fail('--action must be add, update or term.');
	}
	if (opts.category !== undefined) {
		settings.category = FILE_CATEGORIES.find((c) => c === opts.category!.toLowerCase());
		if (!settings.category) return fail('--category must be individual or facility.');
	}
	// --contract-id and --sender-email: typed once, written into every record.
	if (opts['contract-id']?.trim()) settings.constants['network.contract_id'] = opts['contract-id'].trim();
	if (opts['sender-email']?.trim()) settings.constants['network.sender_email'] = opts['sender-email'].trim();
	// --allow provider_type=AHP,PHYS: the field by its id or its name, if it has a fixed list of values.
	const enums = fieldList(schema).filter((f) => f.spec.type === 'enum');
	for (const arg of opts.allow ?? []) {
		const [name = '', list = ''] = arg.split(/=(.*)/s);
		const field = enums.find((f) => f.id === name.trim()) ?? enums.find((f) => f.name === name.trim());
		const values = list.split(',').map((v) => v.trim()).filter(Boolean);
		if (!field || !values.length) return fail(`--allow must be field=value,value for a field with a fixed list: ${enums.map((f) => f.name).join(', ')}.`);
		settings.allowed ??= {};
		settings.allowed[field.id] = [...(settings.allowed[field.id] ?? []), ...values];
	}
	if (opts.mapping !== undefined) {
		try {
			settings.mapping = readMappingFile(opts.mapping);
		} catch (e) {
			return fail((e as Error).message);
		}
		for (const e of settings.mapping.errors) err.write(`${opts.mapping}, ${e}\n`);
	}
	return settings;
}

// What every run passes to the pipeline: the flags, live lookups (unless both are off), progress, --steps.
function runOptions(opts: Flags, s: Settings, io: Io, stepOut: Output) {
	const sources = { nppes: !opts['no-nppes'], census: !opts['no-census'] };
	const showProgress = io.progress ?? !!process.stderr.isTTY;
	return {
		headerRow: s.headerRow, action: s.action, category: s.category, overrides: s.mapping?.overrides, constants: s.constants, effectiveDate: s.effectiveDate, allowed: s.allowed,
		sources, lookup: io.lookup ?? liveLookup,
		progress: showProgress ? (done: number, total: number) => io.err.write(`\rChecking ${done} of ${total}…${done === total ? '\r\x1b[K' : ''}`) : undefined,
		onStep: opts.steps ? stepper(io, stepOut) : undefined,
	};
}

// --steps: print each step's result; in a terminal, wait for Enter before the next (q stops).
function stepper(io: Io, out: Output): OnStep {
	return async (event: StepEvent) => {
		out.write(stepReport(event));
		const next = STEPS[STEPS.indexOf(event.step) + 1];
		return !next || !io.pause || io.pause(next);
	};
}

async function single(file: string, opts: Flags, settings: Settings, io: Io): Promise<number> {
	const { out, err } = io;
	// With no -o, the result goes to ./output/ (not with --ui or --json). A path ending in / is a folder, made if missing.
	const output = opts.output ?? (!opts.ui && !opts.json ? OUTPUT_DIR : undefined);
	const toDir = output !== undefined && (output === OUTPUT_DIR || /[\\/]$/.test(output) || isDirectory(output));
	const format = output === undefined || toDir ? undefined : extname(output).toLowerCase();
	if (format !== undefined && format !== '.csv' && format !== '.json' && format !== '.xlsx') return print(err, '--output must be a directory or end in .xlsx, .csv or .json.', 1);

	let everySheet: Sheet[];
	try {
		everySheet = readRoster(file);
	} catch (e) {
		return print(err, (e as Error).message, 1);
	}
	let sheets = everySheet;
	if (opts.sheet !== undefined) {
		sheets = sheets.filter((s) => s.name === opts.sheet);
		if (!sheets.length) return print(err, `No sheet named "${opts.sheet}". Sheets: ${everySheet.map((s) => s.name).join(', ')}`, 1);
	}
	sheets = sheets.filter((s) => s.rows.length);

	const ui = opts.ui && !opts.json ? io.openUi : undefined;
	if (opts.ui && !ui) err.write(opts.json ? `--ui is ignored with --json.\n` : `Can't open the UI here; running in the terminal.\n`);
	if (ui) {
		const session = {
			name: basename(file), mappingName: settings.mapping?.name, sheet: opts.sheet, headerRow: settings.headerRow, action: settings.action, category: settings.category,
			effectiveDate: settings.effectiveDate, ...withInputs(settings), ...lookups(opts),
		};
		return startUi({ ...io, openUi: ui }, session, { sheets: everySheet, mapping: settings.mapping?.bytes }, opts.send);
	}

	if (opts.sheet === undefined && sheets.length > 1 && io.chooseSheet) {
		const chosen = await io.chooseSheet(file, sheets);
		if (!chosen) return 1;
		sheets = chosen;
	}

	const stepOut = opts.json ? err : out;
	const options = runOptions(opts, settings, io, stepOut);
	if (options.onStep && (await options.onStep({ step: 'read', file: basename(file), sheets })) === false) return 0;
	const before = { ...lookupStats };
	let results: SheetResult[];
	try {
		results = await runSheets(basename(file), sheets, options);
	} catch (e) {
		if (e instanceof StoppedEarly) return 0;
		throw e;
	}
	lookupLine(opts, before, io);

	// The output holds the rows that move forward; the Left out tab (or the issues file) every row left out, and why.
	const report: ReportOptions = { keepDropped: opts['keep-dropped'] ?? false, notes: { Checked: checkedWith(opts), 'Roster Mapper': version } };
	const written: string[] = [];
	if (output !== undefined && toDir) {
		writeOutput(basename(file), results, output, report).forEach((entry, i) => {
			if (entry.error) return void err.write(`${entry.sheet}: ${entry.error === 'no records' ? 'no records, nothing written' : entry.error}\n`);
			const path = join(output, entry.output!);
			out.write(sheetSummary(results[i]!));
			err.write(`Wrote ${path}\n`);
			written.push(path);
		});
	} else if (output !== undefined && format === '.xlsx') {
		writeFileSync(output, toReport(basename(file), results, report));
		for (const r of results) out.write(sheetSummary(r));
		err.write(`Wrote ${output}\n`);
		written.push(output);
	} else if (output !== undefined) {
		const all = results.flatMap((r) => r.records);
		const dropped = all.filter(isDropped);
		const records = report.keepDropped ? all : all.filter((x) => !isDropped(x));
		const issuesPath = output.slice(0, -format!.length) + '_issues.csv';
		writeFileSync(output, format === '.json' ? JSON.stringify(records, null, 2) + '\n' : toCsv(records));
		writeFileSync(issuesPath, toIssuesCsv(all));
		err.write(`Wrote ${records.length} records to ${output} (${records.filter(hasProblem).length} with issues)` +
			`; ${dropped.length} ${dropped.length === 1 ? 'row' : 'rows'} left out${report.keepDropped && dropped.length ? ' (kept in the output by --keep-dropped)' : ''}, listed with why in ${issuesPath}\n`);
		written.push(output, issuesPath);
	}
	if (options.onStep) await options.onStep({ step: 'export', files: written });

	if (settings.mapping) {
		const unused = [...new Set(results.flatMap((r) => r.unusedOverrides))].filter((h) => results.every((r) => r.unusedOverrides.includes(h)));
		if (unused.length) err.write(`${settings.mapping.name}: no column named ${unused.map((h) => `"${h}"`).join(', ')}\n`);
	}

	if (opts.json) out.write(JSON.stringify({ file, sheets: results }, null, 2) + '\n');
	// A workbook holds the mapping, issues and dropped rows, so the terminal gets just a summary (above).
	else if ((format !== '.xlsx' && !toDir) || opts.why) for (const r of results) out.write(mappingTable(r, opts.why ?? false));
	return 0;
}

// Several files, or folders of them (see mapFiles): one folder per run with a workbook per sheet and summary.xlsx.
async function bulk(inputs: string[], opts: Flags, settings: Settings, io: Io): Promise<number> {
	const { out, err } = io;
	if (opts.ui || opts.json) return print(err, `--${opts.ui ? 'ui' : 'json'} works on one file at a time.`, 1);
	if (opts.output !== undefined && extname(opts.output) && !isDirectory(opts.output)) return print(err, `With several files, --output must be a folder.`, 1);

	let failed = 0;
	const before = { ...lookupStats };
	const { dir, files, entries } = await mapFiles(inputs, {
		...runOptions(opts, settings, io, out),
		output: opts.output ?? OUTPUT_DIR,
		report: { keepDropped: opts['keep-dropped'] ?? false, notes: { Checked: checkedWith(opts), 'Roster Mapper': version } },
		onFile: ({ index, total, path, dir, entries, results, error }) => {
			err.write(`\n[${index + 1}/${total}] ${path}\n`);
			if (error) err.write(`${error}\n`);
			entries.forEach((e, i) => {
				if (e.output) {
					out.write(sheetSummary(results![i]!));
					err.write(`Wrote ${join(dir, e.output)}\n`);
				} else if (!error) err.write(`${e.sheet}: ${e.error === 'no records' ? 'no records, nothing written' : e.error}\n`);
			});
			if (entries.every((e) => e.error)) failed++;
		},
	});
	if (!files.length) return print(err, `No .xlsx, .xls or .csv files in ${inputs.join(', ')}.`, 1);
	lookupLine(opts, before, io);
	const written = entries.filter((e) => e.output).length;
	err.write(`\n${files.length} ${files.length === 1 ? 'file' : 'files'}: ${written} ${written === 1 ? 'workbook' : 'workbooks'} written` +
		`${failed ? `, ${failed} ${failed === 1 ? 'file' : 'files'} failed` : ''}. See ${dir}/summary.xlsx\n`);
	return failed ? 1 : 0;
}

// "Lookups: 12 asked of NPPES and Census, 30 reused from ~/.cache/rostermapper/lookups.json"
function lookupLine(opts: Flags, before: { asked: number; saved: number }, io: Io): void {
	const asked = lookupStats.asked - before.asked;
	const saved = lookupStats.saved - before.saved;
	if (io.lookup || opts['no-nppes'] && opts['no-census'] || !(saved + asked)) return;
	io.err.write(`Lookups: ${asked} asked of NPPES and Census, ${saved} reused` + (!diskCacheOn() ? ' (--no-cache)\n' : ` from ${cacheFile().replace(homedir(), '~')}\n`));
}

async function startUi({ err, openUi }: Io, session: Session, files: UiFiles = {}, sendTo?: string): Promise<number> {
	if (sendTo !== undefined) {
		let to: URL | undefined;
		try { to = new URL(sendTo); } catch { /* checked below */ }
		if (!to || !/^https?:$/.test(to.protocol)) return print(err, `--send needs an http or https URL, not "${sendTo}"`, 1);
		session = { ...session, send: { label: `Send to ${to.host}` } };
		files = { ...files, sendTo: to.href };
	}
	try {
		const url = await openUi!(session, files);
		err.write(`Roster Mapper → ${url}\nPress Ctrl+C to stop.\n`);
		return 0;
	} catch (e) {
		err.write(`Could not open the UI: ${(e as Error).message}\n`);
		return 1;
	}
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

// --steps in a terminal: Enter runs the next step, q stops.
async function askToContinue(next: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return !/^q/i.test((await rl.question(`Enter: ${next} · q: stop `)).trim());
	} catch {
		return false;
	} finally {
		rl.close();
	}
}

function print(out: Output, text: string, code = 0): number {
	out.write(text + '\n');
	return code;
}

// "NPPES, Census" or what was turned off, for the report's Summary.
function checkedWith(opts: Flags): string {
	const on = [!opts['no-nppes'] && 'NPPES', !opts['no-census'] && 'Census'].filter(Boolean).join(', ');
	return (on || 'no lookups') + (on && !diskCacheOn() ? ' (--no-cache)' : '');
}

// The lookups turned off with --no-nppes / --no-census. Unset ones are left out, so the UI uses the browser's saved choice.
const lookups = (opts: Flags): Pick<Session, 'nppes' | 'census'> => ({
	...(opts['no-nppes'] && { nppes: false }),
	...(opts['no-census'] && { census: false }),
});

// What the UI gets from the flags: --contract-id and --sender-email as inputs, --allow's values.
const withInputs = (s: Settings) => ({ ...(Object.keys(s.constants).length && { inputs: s.constants }), ...(s.allowed && { allowed: s.allowed }) });
