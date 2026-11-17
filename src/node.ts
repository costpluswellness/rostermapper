// Roster Mapper in Node, without the UI: read roster files from disk, run the pipeline with live
// NPPES and Census lookups (cached on disk, see validate/lookup.ts), and write the default output, one
// workbook per sheet. The CLI is a thin layer over this; embed it as `rostermapper/node`.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseMapping } from './map/mapping';
import { runSheets, type RunOptions } from './pipeline';
import { readWorkbook, type Sheet } from './read/workbook';
import { sheetWorkbooks, toBatchSummary } from './export/report';
import { sheetEntry, type BatchEntry, type ReportOptions, type SheetResult } from './export/tables';
import type { LookupFns } from './validate/checks';
import { lookupAddress, lookupNpi, searchNpiByName } from './validate/lookup';

export { cacheFile, diskCacheOn, lookupAddress, lookupNpi, lookupStats, searchNpiByName, useDiskCache } from './validate/lookup';

/** The default output folder, relative to where it runs. */
export const OUTPUT_DIR = 'output';

/** NPPES and Census, live (and cached on disk). */
export const liveLookup: LookupFns = { npi: lookupNpi, address: lookupAddress, byName: searchNpiByName };

export interface MapFileOptions extends Omit<RunOptions, 'lookup'> {
	/** Only these sheets, by name. Default: every sheet with data. */
	sheets?: readonly string[] | undefined;
	/** Where lookups go. Default: live NPPES and Census; false for none. */
	lookup?: LookupFns | false | undefined;
}

export interface MappedFile {
	/** The file's name, without its folder. */
	file: string;
	/** Every sheet in the file, as read (SSNs removed). */
	sheets: Sheet[];
	/** One per sheet mapped, in file order. */
	results: SheetResult[];
}

/** Read a roster's sheets from disk. Throws "File not found: …" or "Could not read …: why". */
export function readRoster(path: string): Sheet[] {
	try {
		return readWorkbook(readFileSync(path));
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		throw new Error(code === 'ENOENT' ? `File not found: ${path}` : `Could not read ${path}: ${(e as Error).message}`);
	}
}

/** Read a mapping file (CSV or xlsx of `column,field` lines). `errors`: lines that were skipped, and why. */
export function readMappingFile(path: string): { name: string; bytes: Uint8Array; overrides: Record<string, string>; errors: string[] } {
	let bytes;
	try {
		bytes = readFileSync(path);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		throw new Error(code === 'ENOENT' ? `Mapping file not found: ${path}` : `Could not read ${path}: ${(e as Error).message}`);
	}
	return { name: basename(path), bytes, ...parseMapping(readWorkbook(bytes)[0]?.rows ?? []) };
}

/** Read a roster and map, standardize, validate and review its sheets. Writes nothing; see writeOutput. */
export async function mapFile(path: string, { sheets: only, lookup = liveLookup, onStep, ...options }: MapFileOptions = {}): Promise<MappedFile> {
	const file = basename(path);
	const sheets = readRoster(path);
	let chosen = sheets;
	if (only) {
		const missing = only.filter((name) => !sheets.some((s) => s.name === name));
		if (missing.length) throw new Error(`No sheet named "${missing[0]}". Sheets: ${sheets.map((s) => s.name).join(', ')}`);
		chosen = sheets.filter((s) => only.includes(s.name));
	}
	if (onStep && (await onStep({ step: 'read', file, sheets: chosen.filter((s) => s.rows.length) })) === false) return { file, sheets, results: [] };
	const results = await runSheets(file, chosen, { ...options, onStep, ...(lookup && { lookup }) });
	return { file, sheets, results };
}

/**
 * The default output: one workbook per sheet (Summary, Mapping, Data, Issues and Left out tabs) in
 * `dir`, named RM_<file>_<sheet>.xlsx, with the time added when that name is taken. Resolves to a
 * batch entry per sheet: the workbook written, or why none was (a sheet with no records).
 */
export function writeOutput(file: string, results: readonly SheetResult[], dir: string = OUTPUT_DIR, options: ReportOptions = {}): BatchEntry[] {
	mkdirSync(dir, { recursive: true });
	const books = new Map(sheetWorkbooks(file, results, options).map((b) => [b.result, b]));
	return results.map((r) => {
		const book = books.get(r);
		if (!book) return { file, sheet: r.sheet, error: 'no records' };
		const path = freeName(join(dir, book.name));
		writeFileSync(path, book.bytes);
		return sheetEntry(file, r, basename(path));
	});
}

export interface MapFilesOptions extends MapFileOptions {
	/** Where the run's folder goes. Default: output/. */
	output?: string | undefined;
	/** Workbook options: keep dropped rows in Data, Summary notes. */
	report?: ReportOptions | undefined;
	/** Called as each file finishes (or fails). */
	onFile?: ((done: { index: number; total: number; path: string; dir: string; entries: BatchEntry[]; results?: SheetResult[]; error?: string }) => void) | undefined;
}

/**
 * Several files, or folders of them: each mapped as on its own, every sheet, into a new folder for
 * the run, <output>/<date-time>/, so a batch never mixes with or overwrites another. summary.xlsx
 * there lists every sheet written and every file that failed, and why. A file that fails doesn't stop
 * the batch. Lookups are shared across files.
 */
export async function mapFiles(inputs: readonly string[], { output = OUTPUT_DIR, report, onFile, ...options }: MapFilesOptions = {}): Promise<{ dir: string; files: string[]; entries: BatchEntry[] }> {
	const files = rosterFiles(inputs);
	let dir = join(output, timestamp());
	for (let n = 2, base = dir; exists(dir); n++) dir = `${base}_${n}`; // two batches in the same second
	const entries: BatchEntry[] = [];
	const lookups = options.lookups ?? { nppes: new Map(), census: new Map(), names: new Map() };
	for (const [index, path] of files.entries()) {
		let done: BatchEntry[];
		let results: SheetResult[] | undefined;
		let error: string | undefined;
		try {
			({ results } = await mapFile(path, { ...options, lookups }));
			done = writeOutput(basename(path), results, dir, report);
			if (!done.length) done = [{ file: basename(path), sheet: '', error: 'no data' }];
		} catch (e) {
			error = (e as Error).message;
			done = [{ file: basename(path), sheet: '', error }];
		}
		entries.push(...done);
		onFile?.({ index, total: files.length, path, dir, entries: done, ...(results && { results }), ...(error && { error }) });
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'summary.xlsx'), toBatchSummary(entries));
	return { dir, files, entries };
}

/** Roster files: each file given, and each folder's own spreadsheets (not its subfolders'). */
export function rosterFiles(inputs: readonly string[]): string[] {
	return inputs.flatMap((input) => (isDirectory(input) ? readdirSync(input).filter(isRoster).sort().map((name) => join(input, name)) : [input]));
}

/** A roster in a folder: a spreadsheet, but not Excel's lock files (~$…), hidden files or Roster Mapper's own output (RM_…, summary.xlsx). */
export const isRoster = (name: string): boolean => /\.(xlsx|xls|csv)$/i.test(name) && !/^(~\$|\.|RM_)/.test(name) && name !== 'summary.xlsx';

/** The local time as 20261117-143005. */
export function timestamp(d = new Date()): string {
	const two = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** The path, or when it's taken, the path with the time added: RM_x_Sheet1_20261117-143005.xlsx (then _2, _3, …). */
export function freeName(path: string): string {
	if (!exists(path)) return path;
	const ext = extname(path);
	const base = `${path.slice(0, -ext.length)}_${timestamp()}`;
	for (let n = 1; ; n++) {
		const name = `${base}${n > 1 ? `_${n}` : ''}${ext}`;
		if (!exists(name)) return name;
	}
}

export function exists(path: string): boolean {
	try {
		return statSync(path), true;
	} catch {
		return false;
	}
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
