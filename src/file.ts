// The file-level fields every record carries: which file and sheet it came from, the sheet's
// action and whether the sheet lists individual providers or facilities. They aren't mapped from
// columns; they're set once per sheet and written into every record (`file.name`, `file.sheet`,
// `file.action`, `file.category`). The name and sheet also name the output file (see outputName).
import type { Action } from './action';
import type { Assignment } from './types';

export const FILE_ACTIONS = ['adds', 'terms', 'update', 'mixed'] as const;
/** The sheet's action as written in the output: ADD → adds, TERM → terms, UPDATE → update, MIXED → mixed. */
export type FileAction = (typeof FILE_ACTIONS)[number];

export const FILE_CATEGORIES = ['individual', 'facility'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export interface FileInfo {
	/** File name and extension. */
	name: string;
	/** Selected sheet name. */
	sheet: string;
	action: FileAction;
	category: FileCategory;
}

/** The file fields in output order, for the data dictionary. */
export const FILE_FIELDS: readonly { id: `file.${keyof FileInfo}`; type: 'string' | 'enum'; description: string; format?: string }[] = [
	{ id: 'file.name', type: 'string', description: 'File name and extension' },
	{ id: 'file.sheet', type: 'string', description: 'Selected sheet name' },
	{ id: 'file.action', type: 'enum', description: 'The file action: set by the user, otherwise detected (see Action)', format: '`adds`, `terms`, `update`, `mixed`' },
	{ id: 'file.category', type: 'enum', description: 'Whether the sheet lists individual providers or facilities', format: '`individual` or `facility`' },
];

const TO_FILE_ACTION: Record<Action | 'MIXED', FileAction> = { ADD: 'adds', TERM: 'terms', UPDATE: 'update', MIXED: 'mixed' };

/** The sheet's action as it's written in the output. */
export const fileAction = (action: Action | 'MIXED'): FileAction => TO_FILE_ACTION[action];

/** `file.*` id → value, in output order. */
export const fileValues = (file: FileInfo): Record<string, string> => ({
	'file.name': file.name,
	'file.sheet': file.sheet,
	'file.action': file.action,
	'file.category': file.category,
});

export type CategorySource = 'option' | 'sheet name' | 'file name' | 'columns' | 'default';

export interface DetectedCategory {
	category: FileCategory;
	source: CategorySource;
	/** Plain-language reason. */
	why: string;
}

export interface CategoryInput {
	/** Set by the caller; skips detection. */
	category?: FileCategory | undefined;
	fileName?: string | undefined;
	sheetName?: string | undefined;
	/** Field id → column, from matching. */
	mapping?: Readonly<Record<string, Pick<Assignment, 'column'>>> | undefined;
}

// Words in a sheet or file name that mark a facility roster. "Hospital" is left out: files of
// hospital-based physicians are common.
const FACILITY_WORD = /\b(facilit(y|ies)|ancillar(y|ies)|organi[sz]ations?|type ?(2|ii))\b/i;
// Columns that only an individual provider has, and columns a facility row is identified by.
const INDIVIDUAL_FIELDS = ['provider.npi', 'provider.first_name', 'provider.last_name', 'provider.date_of_birth', 'provider.gender'];
const FACILITY_FIELDS = ['practice.dba', 'practice.location_name', 'billing.legal_name', 'billing.npi'];

/** Whether a sheet or file name marks a facility roster: "Facilities", "Ancillary Adds.xlsx". */
export function namesFacility(name: string): boolean {
	return FACILITY_WORD.test(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' '));
}

/**
 * Individual or facility, in order of precedence: the caller says so; the sheet name or the file
 * name mentions facilities; the columns identify a person (NPI, first or last name, birth date,
 * gender) → individual, or only a practice or billing organization → facility; otherwise individual.
 */
export function detectCategory({ category, fileName, sheetName, mapping = {} }: CategoryInput): DetectedCategory {
	if (category) return { category, source: 'option', why: `set to ${category}` };
	if (sheetName && namesFacility(sheetName)) return { category: 'facility', source: 'sheet name', why: `sheet name "${sheetName}" mentions facilities` };
	if (fileName && namesFacility(fileName)) return { category: 'facility', source: 'file name', why: `file name "${fileName}" mentions facilities` };
	const person = INDIVIDUAL_FIELDS.filter((f) => mapping[f]);
	if (person.length) return { category: 'individual', source: 'columns', why: `columns map to ${person.join(', ')}` };
	const org = FACILITY_FIELDS.filter((f) => mapping[f]);
	if (org.length) return { category: 'facility', source: 'columns', why: `no column identifies a person; columns map to ${org.join(', ')}` };
	return { category: 'individual', source: 'default', why: 'no column identifies a person or an organization' };
}

/**
 * The output file's name: `RM_<file>_<sheet>.<ext>`, the roster's name without its extension and the
 * sheet name with their spaces dropped. "Q3 Roster.xlsx" / "LOC TERM" → `RM_Q3Roster_LOCTERM.csv`.
 */
export function outputName(file: FileInfo, ext: string): string {
	const source = noSpaces(file.name.replace(/\.[^.]+$/, '')) || 'roster';
	const sheet = noSpaces(file.sheet) || 'sheet';
	return `RM_${source}_${sheet}.${ext.replace(/^\./, '')}`;
}

const noSpaces = (s: string) => s.replace(/\s+/g, '');
