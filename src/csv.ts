import { fieldList } from './fields';
import { FILE_FIELDS } from './file';
import type { RosterRecord } from './records';
import { schema } from './schema.generated';

/**
 * Records as CSV (RFC 4180): the `file.*` fields (name, sheet, action, category), one column per
 * field id with the network fields (action, effective date, …) first, then `issues` joined with
 * "; ". Records from several sheets can be passed together; `file.sheet` tells them apart. Pass
 * `fields` to fix the columns; defaults to outputFields(records).
 */
export function toCsv(records: readonly RosterRecord[], fields?: readonly string[]): string {
	const columns = fields ?? outputFields(records);
	const lines = [[...columns, 'issues']];
	for (const r of records) lines.push([...columns.map((c) => r.values[c] ?? ''), r.issues.map((i) => `${i.field}: ${i.message}`).join('; ')]);
	return lines.map((line) => line.map(quote).join(',')).join('\r\n') + '\r\n';
}

// Fields marked hidden in the schema (CAQH ID, email, website, …): left out of the output when no
// record has a value for them. Every other field is always a column, empty or not.
const HIDDEN = new Set(fieldList(schema).filter(({ spec }) => spec.hidden).map(({ id }) => id));

/** The output's field columns, in output order: the first record's fields (the built-in schema's when there are none), minus hidden fields no record fills. */
export function outputFields(records: readonly RosterRecord[]): string[] {
	const all = records[0] ? Object.keys(records[0].values) : [...FILE_FIELDS.map((f) => f.id), ...fieldList(schema).map((f) => f.id)];
	return outputOrder(all).filter((f) => !HIDDEN.has(f) || records.some((r) => r.values[f]));
}

const quote = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const isFileField = (f: string) => f.startsWith('file.');

/** Field ids in output order: the `file.*` fields, then the network fields, then the rest in the order given. */
export const outputOrder = (fields: readonly string[]): string[] => [
	...fields.filter(isFileField),
	...fields.filter((f) => f.startsWith('network.')),
	...fields.filter((f) => !isFileField(f) && !f.startsWith('network.')),
];
