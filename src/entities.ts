// Group a sheet's records into the things they describe: providers, practice locations and
// billing entities, plus which provider works at which location and which location bills
// through which entity. A roster row is one provider × location × billing combination.
import type { RosterRecord } from './records';

export type EntityKind = 'provider' | 'practice' | 'billing';

export interface Entity {
	/** What makes it unique: NPI for providers, address for locations, TIN + group NPI + address for billing. */
	key: string;
	/** Field id → value, the first non-empty value across its rows. Only this entity's fields. */
	values: Record<string, string>;
	/** Sheet row numbers that mention it. */
	rows: number[];
	/** Number of issues on those rows, for this entity's fields. */
	issues: number;
}

export interface Entities {
	providers: Entity[];
	locations: Entity[];
	billing: Entity[];
	/** [provider index, location index] pairs. */
	providerLocations: [number, number][];
	/** [location index, billing index] pairs. */
	locationBilling: [number, number][];
}

// Which fields identify each kind. A row with none of them has no entity of that kind.
const KEYS: Record<EntityKind, string[]> = {
	provider: ['provider.npi'],
	practice: ['practice.address_1', 'practice.address_2', 'practice.zip'],
	billing: ['billing.tax_id', 'billing.npi', 'billing.address_1', 'billing.zip'],
};

// Rows without an NPI still describe a provider; fall back to name and birth date.
const PROVIDER_FALLBACK = ['provider.last_name', 'provider.first_name', 'provider.date_of_birth'];

/** Group records into unique providers, locations and billing entities, and link them. */
export function groupEntities(records: readonly RosterRecord[]): Entities {
	const providers = new Group('provider');
	const locations = new Group('practice');
	const billing = new Group('billing');
	const providerLocations = new Set<string>();
	const locationBilling = new Set<string>();

	for (const record of records) {
		const p = providers.add(record, keyOf(record, KEYS.provider) || keyOf(record, PROVIDER_FALLBACK));
		const l = locations.add(record, keyOf(record, KEYS.practice) || keyOf(record, ['practice.location_name', 'practice.dba']));
		const b = billing.add(record, keyOf(record, KEYS.billing));
		if (p !== null && l !== null) providerLocations.add(`${p},${l}`);
		if (l !== null && b !== null) locationBilling.add(`${l},${b}`);
	}

	return {
		providers: providers.entities,
		locations: locations.entities,
		billing: billing.entities,
		providerLocations: pairs(providerLocations),
		locationBilling: pairs(locationBilling),
	};
}

class Group {
	readonly entities: Entity[] = [];
	private readonly index = new Map<string, number>();

	constructor(private readonly kind: EntityKind) {}

	/** Add a record to the entity with this key; returns its index, or null for an empty key. */
	add(record: RosterRecord, key: string): number | null {
		if (!key) return null;
		let i = this.index.get(key);
		if (i === undefined) {
			i = this.entities.push({ key, values: {}, rows: [], issues: 0 }) - 1;
			this.index.set(key, i);
		}
		const entity = this.entities[i]!;
		entity.rows.push(record.row);
		for (const [field, value] of Object.entries(record.values)) {
			if (field.startsWith(`${this.kind}.`) && value && !entity.values[field]) entity.values[field] = value;
		}
		entity.issues += record.issues.filter((issue) => issue.field.startsWith(`${this.kind}.`)).length;
		return i;
	}
}

// Case- and spacing-insensitive, so "100 Elm St" and "100 ELM ST " are one location.
const keyOf = (record: RosterRecord, fields: readonly string[]) =>
	fields.some((f) => record.values[f]) ? fields.map((f) => (record.values[f] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|') : '';

const pairs = (set: Set<string>) => [...set].map((s) => s.split(',').map(Number) as [number, number]);
