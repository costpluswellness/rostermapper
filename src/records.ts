// Export: turn mapped rows into roster records, one per data row, every schema field present.
// Each value is cleaned (see clean.ts) unless `clean` is false; inverted yes/no columns are
// always flipped so values keep their meaning.
import type { Action } from './action';
import { cellText, isBlank } from './cells';
import { cleanValue, NO, YES } from './clean';
import { fieldList } from './fields';
import { fileValues, type FileInfo } from './file';
import type { Assignment, BodyRow, Schema } from './types';

export interface Issue {
	field: string;
	/** Which step raised it: a required field is blank (Map), a value can't be cleaned (Standardize), a value fails a check (Validate).
	 *  `warning` is a source that couldn't confirm the value, or disagrees with it enough to check by hand.
	 *  `default` is a note, not a problem: the value came from the Upload step's default, not the sender. */
	kind: 'missing' | 'format' | 'invalid' | 'warning' | 'default';
	message: string;
	/** The row can't move forward: it's left out of the export (see isDropped). */
	drop?: true;
}

export interface RosterRecord {
	/** Row number in the sheet (1-based), to trace a record back to the file. */
	row: number;
	/** Field id → value: the `file.*` fields, then the schema fields in schema order. Empty string when the file has no value. */
	values: Record<string, string>;
	/** Problems with this row, such as a required field with no value. */
	issues: Issue[];
}

export const EFFECTIVE_DATE = 'network.effective_date';

/** True when an issue keeps the row out of the export: a missing or unreadable NPI, an NPI NPPES rejects, or an ADD with no practice address or TIN. */
export const isDropped = (record: { issues: readonly Issue[] }): boolean => record.issues.some((i) => i.drop);

const NPI_FIELDS = ['provider.npi', 'billing.npi'];

/** The NPI every row must have: the provider's in an individual roster, the billing entity's in a facility roster. */
export const primaryNpi = (category?: string): string => (category === 'facility' ? 'billing.npi' : 'provider.npi');

// What an ADD row must have to be loaded: a location to list the provider at, and a TIN to pay.
// UPDATE and TERM rows often leave them out, so only ADD rows are dropped without them.
const ADD_NEEDS: [string, string][] = [
	['practice.address_1', 'no practice address'],
	['billing.tax_id', 'no billing TIN'],
];

/**
 * Mark the issues that drop a row: the primary NPI is blank (or "N/A"), any NPI fails
 * standardization (not 10 digits, bad check digit), or an ADD has no practice address or no TIN.
 * Idempotent, so it can run again after a value is fixed by hand. Changes `record.issues` in place.
 */
export function applyDropRules(record: { values: Readonly<Record<string, string>>; issues: Issue[] }, category?: string): void {
	for (const issue of record.issues) if (issue.kind === 'format' && NPI_FIELDS.includes(issue.field)) issue.drop = true;
	const needs: [string, string][] = [[primaryNpi(category), 'no NPI'], ...(record.values['network.action_type'] === 'ADD' ? ADD_NEEDS : [])];
	const blank = needs.filter(([field]) => !record.values[field]);
	record.issues = record.issues.filter((i) => !(i.kind === 'missing' && needs.some(([field]) => field === i.field)));
	record.issues.unshift(...blank.map(([field, what]) => ({ field, kind: 'missing' as const, message: `${what}; row dropped`, drop: true as const })));
}
export const DEFAULT_NOTE = 'effective date from Upload default';

/**
 * Build one record per body row. `actions` holds each row's action, in the same order. `file` is
 * written into every record as the `file.*` fields. `constants` fills fields no column maps to.
 * `effectiveDate` fills a blank effective date, after the column and the constant.
 */
export function buildRecords(
	schema: Schema,
	body: readonly BodyRow[],
	mapping: Readonly<Record<string, Assignment>>,
	actions: readonly Action[],
	{ clean = true, file, constants = {}, effectiveDate }: { clean?: boolean | undefined; file?: FileInfo | undefined; constants?: Readonly<Record<string, string>> | undefined; effectiveDate?: string | undefined } = {},
): RosterRecord[] {
	const fields = fieldList(schema).map(({ id, spec }) => ({ id, type: spec.type, values: spec.values ?? [], required: spec.required ?? [] }));

	return body.map(({ index, cells }, i) => {
		const action = actions[i]!;
		const values: Record<string, string> = file ? fileValues(file) : {};
		const issues: Issue[] = [];

		for (const { id, type, values: kinds, required } of fields) {
			const assigned = mapping[id];
			const cell = assigned ? cells[assigned.column] : undefined;
			let value = isBlank(cell) ? '' : cellText(cell);
			if (!assigned && constants[id]?.trim()) value = constants[id].trim(); // one value for every row
			if (id === EFFECTIVE_DATE && !value && effectiveDate?.trim()) {
				value = effectiveDate.trim();
				issues.push({ field: id, kind: 'default', message: DEFAULT_NOTE });
			}
			let issue: string | undefined;

			if (id === 'network.action_type') value = action;
			else if (clean && value) ({ value, issue } = cleanValue(id, type, value, kinds));

			if (assigned?.inverted && value && !issue) {
				if (YES.test(value)) value = '0';
				else if (NO.test(value)) value = '1';
				else issue = `can't read "${value}" as yes or no`;
			}

			if (issue) issues.push({ field: id, kind: 'format', message: issue });

			if (!value && required.includes(action)) issues.push({ field: id, kind: 'missing', message: `missing; required for ${action}` });
			values[id] = value;
		}
		const record = { row: index + 1, values, issues };
		applyDropRules(record, file?.category);
		return record;
	});
}
