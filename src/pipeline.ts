// The pipeline both entry points run: read → map → standardize → validate → review → export.
// runSheets does the middle steps on a file's sheets; reading the bytes and writing the result are the
// caller's, since they differ in Node and the browser (see node.ts and ui/). The CLI's default run and
// the UI's run call it the same way, so they map, flag and drop the same rows. Pass `onStep` to see
// each step's result as it finishes: the CLI's --steps and the UI's step-by-step mode use it to debug.
import { automap, type AutomapOptions } from './map/automap';
import type { Row } from './schema/types';
import { validateRecords, type LookupFns, type Lookups, type Sources } from './validate/checks';
import { groupEntities, type Entities } from './review/entities';
import type { SheetResult } from './export/tables';

export const STEPS = ['read', 'map', 'standardize', 'validate', 'review', 'export'] as const;
export type Step = (typeof STEPS)[number];

/** One line per step, for help text and the UI. */
export const STEP_SUMMARY: Record<Step, string> = {
	read: 'Read xlsx, xls or csv into sheets of rows; SSNs removed',
	map: 'Find the header row, match columns to schema fields, detect action and category',
	standardize: 'Clean each value into its standard format; drop rows that cannot move forward',
	validate: 'Check NPIs with NPPES and addresses with the Census geocoder',
	review: 'Group rows into providers, practice locations and billing entities',
	export: 'Write a workbook per sheet: Summary, Mapping, Data, Issues, Left out',
};

/** A sheet to map: its name and rows, as readWorkbook returns them. */
export interface SheetInput {
	name: string;
	rows: readonly Row[];
}

/** A value Validate changed on its own (a Census ZIP, an NPPES legal name). */
export interface Change {
	sheet: string;
	row: number;
	field: string;
	from: string;
	to: string;
}

/** What a step produced, for step-by-step runs. `read` and `export` come from the caller. */
export type StepEvent =
	| { step: 'read'; file: string; sheets: readonly SheetInput[] }
	| { step: 'map'; results: readonly SheetResult[] }
	| { step: 'standardize'; results: readonly SheetResult[] }
	| { step: 'validate'; results: readonly SheetResult[]; sources: Sources; ran: boolean; changes: readonly Change[]; lookups: Lookups }
	| { step: 'review'; results: readonly SheetResult[]; entities: readonly Entities[] }
	| { step: 'export'; files: readonly string[] };

/** Resolves to false to stop the run after this step. */
export type OnStep = (event: StepEvent) => void | boolean | Promise<void | boolean>;

export interface RunOptions extends Pick<AutomapOptions, 'action' | 'category' | 'headerRow' | 'overrides' | 'constants' | 'effectiveDate' | 'schema'> {
	/** Which lookups may send data out. Default: both, when `lookup` is given. */
	sources?: Sources | undefined;
	/** Where Validate's answers come from. Without it, Validate runs no lookups. */
	lookup?: LookupFns | undefined;
	/** Answers kept from earlier files, reused and added to. */
	lookups?: Lookups | undefined;
	/** Validate's progress: lookups done of total. */
	progress?: ((done: number, total: number) => void) | undefined;
	/** Called after each step; return false to stop there. */
	onStep?: OnStep | undefined;
}

/** Thrown when an onStep handler stops the run; `results` holds what was done so far. */
export class StoppedEarly extends Error {
	constructor(readonly step: Step, readonly results: SheetResult[]) {
		super(`Stopped after ${step}`);
	}
}

/**
 * Map, standardize, validate and review a file's sheets. Sheets with no rows are skipped; a sheet with
 * no records is kept (with none), for the caller to report. Lookups for all the sheets run together.
 */
export async function runSheets(fileName: string, sheets: readonly SheetInput[], options: RunOptions = {}): Promise<SheetResult[]> {
	const { sources: given, lookup, lookups, progress, onStep, ...mapOptions } = options;
	const sources: Sources = lookup ? (given ?? { nppes: true, census: true }) : { nppes: false, census: false };
	const step = async (event: StepEvent) => {
		if (onStep && (await onStep(event)) === false) throw new StoppedEarly(event.step, results);
	};

	// Map and standardize happen in one pass (automap); with onStep they're reported one after the other.
	const results: SheetResult[] = sheets
		.filter((s) => s.rows.length)
		.map((s) => ({ sheet: s.name, ...automap(s.rows, { ...mapOptions, fileName, sheetName: s.name }) }));
	await step({ step: 'map', results });
	await step({ step: 'standardize', results });

	const records = results.flatMap((r) => r.records);
	const before = onStep ? records.map((r) => ({ ...r.values })) : [];
	const answers = lookup ? await validateRecords(records, sources, lookup, { lookups, progress }) : (lookups ?? { nppes: new Map(), census: new Map() });
	if (onStep) {
		const changes: Change[] = [];
		records.forEach((r, i) => {
			for (const [field, to] of Object.entries(r.values)) {
				const from = before[i]![field] ?? '';
				if (from !== to) changes.push({ sheet: r.values['file.sheet'] ?? '', row: r.row, field, from, to });
			}
		});
		await step({ step: 'validate', results, sources, ran: !!lookup && (sources.nppes || sources.census), changes, lookups: answers });
		await step({ step: 'review', results, entities: results.map((r) => groupEntities(r.records.filter((x) => !x.issues.some((i) => i.drop)))) });
	}
	return results;
}
