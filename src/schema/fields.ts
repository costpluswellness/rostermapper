import type { FieldSpec, Schema } from './types';

export interface SchemaField {
	/** "provider.npi" */
	id: string;
	/** "provider" */
	group: string;
	/** "npi" */
	name: string;
	spec: FieldSpec;
}

/** Every field in the schema, in schema order. */
export function fieldList(schema: Schema): SchemaField[] {
	return Object.entries(schema.fields).flatMap(([group, fields]) =>
		Object.entries(fields).map(([name, spec]) => ({ id: `${group}.${name}`, group, name, spec })),
	);
}
