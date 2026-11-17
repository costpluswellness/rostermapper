// Validate: turn NPPES and Census answers into checks per record, and checks into issues. Shared by
// the CLI and the UI, so both drop and flag the same rows. Pure: answers come through LookupFns,
// live from lookup.ts in Node, or through the CLI's local server in the browser.
import { addressLine, censusChecks, nppesBillingChecks, nppesProviderChecks, wantsNameSearch, type CensusMatch, type Check, type CheckStatus, type NppesRecord } from './rules';
import type { Issue, RosterRecord } from '../standardize/records';

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

/** Where validateRecords gets its answers: NPPES and Census, live (lookup.ts) or through the UI's local server. Each throws when its source doesn't answer. */
export interface LookupFns {
	npi(npi: string): Promise<NppesRecord | null>;
	address(line: string): Promise<CensusMatch | null>;
	byName(query: NameQuery): Promise<NppesRecord[]>;
}

export interface LookupOptions {
	/** Answers from earlier files or runs, added to in place. Ones that failed are asked again. */
	lookups?: Lookups | undefined;
	progress?: ((done: number, total: number) => void) | undefined;
}

/** Empty answer maps. */
export const noLookups = (): Lookups => ({ nppes: new Map(), census: new Map(), names: new Map() });

/**
 * Validate records in one go, as the CLI and the UI's run do: look up their NPIs and addresses
 * (see lookupAll), apply what's trusted (Census addresses, NPPES legal names), and add the checks'
 * failures and warnings to each record's issues. Changes the records in place; resolves to the answers.
 */
export async function validateRecords(records: RosterRecord[], on: Sources, lookup: LookupFns, options: LookupOptions = {}): Promise<Lookups> {
	const lookups = await lookupAll(records.map((r) => r.values), on, lookup, options);
	if (!on.nppes && !on.census) return lookups;
	for (const record of records) {
		const checks = recordChecks(record.values, lookups, on);
		const fixes = autoFixes(checks);
		for (const [field, value] of Object.entries(fixes)) {
			record.values[field] = value;
			checks.delete(field);
		}
		record.issues = record.issues.filter((i) => !(i.field in fixes && (i.kind === 'missing' || i.kind === 'format')));
		record.issues.push(...checkIssues(checks));
	}
	return lookups;
}

/**
 * Look up every NPI and address in these records' values (4 at a time), then search NPPES by name
 * for providers whose NPI is under another last name. Only the sources turned on. Resolves to the
 * answers; a source that didn't answer is stored as a LookupError.
 */
export async function lookupAll(
	values: readonly Readonly<Record<string, string>>[],
	on: Sources,
	lookup: LookupFns,
	{ lookups = noLookups(), progress }: LookupOptions = {},
): Promise<Lookups> {
	if (!values.length || (!on.nppes && !on.census)) return lookups;
	const names = (lookups.names ??= new Map());
	const answer = <T>(p: Promise<T>) => p.catch((e: Error) => ({ error: e.message }));
	const known = (map: Map<string, unknown>, key: string) => map.has(key) && !failed(map.get(key));
	const runAll = async (jobs: (() => Promise<void>)[]) => {
		let done = 0;
		const total = jobs.length;
		await Promise.all(Array.from({ length: 4 }, async () => {
			for (let job; (job = jobs.shift()); ) {
				await job();
				progress?.(++done, total);
			}
		}));
	};
	const { npis, lines } = lookupTargets(values);
	await runAll([
		...(on.nppes ? [...npis] : []).filter((n) => !known(lookups.nppes, n)).map((n) => async () => void lookups.nppes.set(n, await answer(lookup.npi(n)))),
		...(on.census ? [...lines] : []).filter((l) => !known(lookups.census, l)).map((l) => async () => void lookups.census.set(l, await answer(lookup.address(l)))),
	]);
	if (on.nppes) {
		const searches = nameSearches(values, lookups).filter((q) => !known(names, nameKey(q)));
		await runAll(searches.map((q) => async () => void names.set(nameKey(q), await answer(lookup.byName(q)))));
	}
	return lookups;
}

/** Suggestions applied without asking (Census city, state, ZIP and suite; NPPES legal names): field → value. */
export function autoFixes(checks: ReadonlyMap<string, readonly Check[]>): Record<string, string> {
	const fixes: Record<string, string> = {};
	for (const list of checks.values()) {
		for (const c of list) if (c.auto && c.status === 'suggest' && c.suggestion !== undefined) Object.assign(fixes, { [c.field]: c.suggestion }, c.also);
	}
	return fixes;
}
