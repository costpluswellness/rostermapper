// Turn NPPES and Census answers into checks per record, and checks into issues. Shared by the UI
// (Validate's "Run checks") and the CLI (--no-ui), so both drop and flag the same rows. Pure: the
// answers are fetched elsewhere (see lookup.ts in the CLI, the local server in the UI).
import { addressLine, censusChecks, nppesBillingChecks, nppesProviderChecks, wantsNameSearch, type CensusMatch, type Check, type CheckStatus, type NppesRecord } from './validate';
import type { Issue } from './records';

/** A lookup that failed: the source didn't answer. */
export interface LookupError {
	error: string;
}

/** Answers by NPI, by one-line address and by provider name (see nameKey). null: the source has no such NPI or address. */
export interface Lookups {
	nppes: Map<string, NppesRecord | null | LookupError>;
	census: Map<string, CensusMatch | null | LookupError>;
	/** Active individual NPIs NPPES has under a first and last name. */
	names?: Map<string, NppesRecord[] | LookupError>;
}

/** An NPPES search by name: first, last and the practice state (searched without it when it finds no one). */
export interface NameQuery {
	first: string;
	last: string;
	state: string;
}

/** The key a name search is stored under in Lookups.names. */
export const nameKey = (q: NameQuery): string => [q.first, q.last, q.state].join('|').toLowerCase();

/** Which sources may be used. */
export interface Sources {
	nppes: boolean;
	census: boolean;
}

export const RANK: Record<CheckStatus, number> = { fail: 0, suggest: 1, warn: 2, ok: 3, skip: 4 };

const failed = (v: unknown): v is LookupError => !!v && typeof v === 'object' && 'error' in v;

/** The NPIs and address lines to look up for these records' values. */
export function lookupTargets(values: Iterable<Readonly<Record<string, string>>>): { npis: Set<string>; lines: Set<string> } {
	const npis = new Set<string>();
	const lines = new Set<string>();
	for (const v of values) {
		for (const f of ['provider.npi', 'billing.npi']) if (/^\d{10}$/.test(v[f] ?? '')) npis.add(v[f]!);
		for (const p of ['practice', 'billing'] as const) {
			const line = addressLine(v, p);
			if (line) lines.add(line);
		}
	}
	return { npis, lines };
}

/**
 * The NPPES name searches these records need, once their NPIs have been looked up: providers whose
 * NPI is under a different last name. A second round of lookups, after the NPIs.
 */
export function nameSearches(values: Iterable<Readonly<Record<string, string>>>, lookups: Lookups): NameQuery[] {
	const queries = new Map<string, NameQuery>();
	for (const v of values) {
		const record = lookups.nppes.get(v['provider.npi'] ?? '');
		if (record === undefined || failed(record) || !wantsNameSearch(v, record)) continue;
		const q = { first: v['provider.first_name']!, last: v['provider.last_name']!, state: v['practice.state'] ?? '' };
		queries.set(nameKey(q), q);
	}
	return [...queries.values()];
}

/** Every check for one record's values: field → its checks, worst first. Only sources that answered (or failed) are used. */
export function recordChecks(values: Readonly<Record<string, string>>, lookups: Lookups, on: Sources = { nppes: true, census: true }): Map<string, Check[]> {
	const all: Check[] = [];
	const { nppes, census } = lookups;
	const got = <T>(map: Map<string, T | LookupError>, key: string): T | null => {
		const v = map.get(key);
		return v === undefined || failed(v) ? null : v;
	};
	for (const field of ['provider.npi', 'billing.npi']) {
		const npi = values[field];
		if (!on.nppes || !npi || !nppes.has(npi)) continue;
		const answer = nppes.get(npi);
		if (failed(answer)) all.push({ field, status: 'warn', source: 'NPPES', detail: `NPPES didn't answer: ${answer.error}` });
		else if (field === 'billing.npi') all.push(...nppesBillingChecks(values, got(nppes, npi)));
		else {
			const byName = lookups.names?.get(nameKey({ first: values['provider.first_name'] ?? '', last: values['provider.last_name'] ?? '', state: values['practice.state'] ?? '' }));
			all.push(...nppesProviderChecks(values, got(nppes, npi), byName === undefined || failed(byName) ? undefined : byName));
		}
	}
	for (const prefix of on.census ? (['practice', 'billing'] as const) : []) {
		const line = addressLine(values, prefix);
		const answer = census.get(line);
		if (failed(answer)) all.push({ field: `${prefix}.address_1`, status: 'warn', source: 'Census', detail: `The Census geocoder didn't answer: ${answer.error}` });
		else if (census.has(line) || /^PO Box/i.test(values[`${prefix}.address_1`] ?? '')) all.push(...censusChecks(values, prefix, got(census, line)));
	}
	const byField = new Map<string, Check[]>();
	for (const c of all) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
	for (const list of byField.values()) list.sort((a, b) => RANK[a.status] - RANK[b.status]);
	return byField;
}

/** Issues from checks: a failure is `invalid` (and drops the row when the check says so), a warning is `warning` (unless quiet). */
export function checkIssues(checks: ReadonlyMap<string, readonly Check[]>): Issue[] {
	const issues: Issue[] = [];
	for (const list of checks.values()) {
		for (const c of list) {
			if (c.status === 'fail') issues.push({ field: c.field, kind: 'invalid', message: c.detail, ...(c.drop && { drop: true as const }) });
			else if (c.status === 'warn' && !c.quiet) issues.push({ field: c.field, kind: 'warning', message: c.detail });
		}
	}
	return issues;
}

/** Suggestions applied without asking (Census city, state, ZIP and suite; NPPES legal names): field → value. */
export function autoFixes(checks: ReadonlyMap<string, readonly Check[]>): Record<string, string> {
	const fixes: Record<string, string> = {};
	for (const list of checks.values()) {
		for (const c of list) if (c.auto && c.status === 'suggest' && c.suggestion !== undefined) Object.assign(fixes, { [c.field]: c.suggestion }, c.also);
	}
	return fixes;
}
