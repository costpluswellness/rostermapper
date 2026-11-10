// Field levels, per action: required (a row must have it; missing is flagged), preferred (fill it
// if the file has it; never flagged) or optional (neither). Plus which required fields a sheet lacks.
import type { Action } from './action';
import { fieldList } from './fields';
import type { Assignment, Schema } from './types';

// Always has a value, even without a column: detectAction fills it in.
const DERIVED = new Set(['network.action_type']);

export interface MissingField {
	field: string;
	/** The actions present in the sheet that require this field. */
	actions: Action[];
}

/** Field ids a row with this action must have. */
export function requiredFields(schema: Schema, action: Action): string[] {
	return fieldList(schema)
		.filter(({ spec }) => spec.required?.includes(action))
		.map(({ id }) => id);
}

/** Field ids that should be filled for this action, if the file has them. */
export function preferredFields(schema: Schema, action: Action): string[] {
	return fieldList(schema)
		.filter(({ spec }) => spec.preferred?.includes(action))
		.map(({ id }) => id);
}

export type FieldLevel = 'required' | 'preferred' | 'optional';

/** A field's level for a set of actions: the strongest it has for any of them. */
export function fieldLevel(spec: { required?: readonly Action[]; preferred?: readonly Action[] }, actions: Iterable<Action>): FieldLevel {
	const list = [...actions];
	if (list.some((a) => spec.required?.includes(a))) return 'required';
	if (list.some((a) => spec.preferred?.includes(a))) return 'preferred';
	return 'optional';
}

/** Required fields with no mapped column, for the given actions. */
export function missingFields(schema: Schema, mapping: Readonly<Record<string, Assignment>>, actions: readonly Action[]): MissingField[] {
	const missing = new Map<string, Action[]>();
	for (const action of new Set(actions)) {
		for (const field of requiredFields(schema, action)) {
			if (mapping[field] || DERIVED.has(field)) continue;
			missing.set(field, [...(missing.get(field) ?? []), action]);
		}
	}
	return [...missing].map(([field, actions]) => ({ field, actions }));
}
