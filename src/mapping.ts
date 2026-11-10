// Mapping files: a CSV of overrides, `column,field` per line, for headers matching gets wrong.
//   column,field
//   USE DATE,network.effective_date
//   Supervising NPI,ignore
// The same file works for the CLI (--mapping) and the UI (Upload step).
import { cellText, isBlank } from './cells';
import { fieldList } from './fields';
import { schema as defaultSchema } from './schema.generated';
import type { Row, Schema } from './types';

// Field ids that were renamed, so older mapping files keep working.
const RENAMED: Readonly<Record<string, string>> = { 'network.requested_action': 'network.action_type' };

export interface ParsedMapping {
	/** Header → field id or "ignore", ready for `automap(rows, { overrides })`. */
	overrides: Record<string, string>;
	/** Lines that were skipped, and why. */
	errors: string[];
}

/** Read a mapping file's rows (from readWorkbook). A first line of `column,field` is skipped. */
export function parseMapping(rows: readonly Row[], schema: Schema = defaultSchema): ParsedMapping {
	const known = new Set(fieldList(schema).filter((f) => !f.spec.input).map((f) => f.id)); // input fields are typed, not mapped
	const overrides: Record<string, string> = {};
	const errors: string[] = [];
	rows.forEach((row, i) => {
		const text = (c: Row[number]) => (isBlank(c) ? '' : cellText(c).trim());
		const header = text(row[0]);
		const written = text(row[1]);
		const field = RENAMED[written] ?? written;
		if (!header && !field) return;
		if (i === 0 && header.toLowerCase() === 'column' && field.toLowerCase() === 'field') return;
		if (!header || !field) return void errors.push(`line ${i + 1}: needs a column and a field`);
		if (field !== 'ignore' && !known.has(field)) return void errors.push(`line ${i + 1}: unknown field "${field}"`);
		overrides[header] = field;
	});
	return { overrides, errors };
}
