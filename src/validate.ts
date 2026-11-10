// Validate: compare cleaned values with outside sources, field by field. Never changes a value.
// Checks a value can fail on its own (NPI check digit, IRS tax ID prefix, NUCC code) are part of
// cleaning (see clean.ts). Here a record is compared with what NPPES has for its NPI and what the US
// Census geocoder finds for its address; the UI's "Run checks" fetches those through the CLI's local
// server. Everything here is pure, so it runs anywhere.
import { cleanDegree, toTitleCase } from './clean';

/** ok: verified · suggest: the source has a different value · warn: couldn't confirm · fail: wrong · skip: not checked */
export type CheckStatus = 'ok' | 'suggest' | 'warn' | 'fail' | 'skip';

export interface Check {
	field: string;
	status: CheckStatus;
	/** Where the answer came from: "NPPES" or "Census". */
	source: string;
	/** One line on what was checked and what came back. */
	detail: string;
	/** The source's value, for status "suggest". */
	suggestion?: string;
	/** Other fields to set along with it when the suggestion is accepted (an address split into two lines). */
	also?: Record<string, string>;
}

type Values = Readonly<Record<string, string>>;

// ─── NPPES ──────────────────────────────────────────────────

/** The parts of an NPPES API result (v2.1) we compare. */
export interface NppesRecord {
	number: string | number;
	enumeration_type: 'NPI-1' | 'NPI-2' | string;
	basic: {
		status?: string;
		first_name?: string;
		last_name?: string;
		middle_name?: string;
		sex?: string;
		credential?: string;
		organization_name?: string;
	};
	taxonomies?: { code: string; desc?: string; primary?: boolean; license?: string; state?: string }[];
}

const same = (a = '', b = '') => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
const title = toTitleCase;
const credential = (s = '') => cleanDegree(s);

/** Compare a provider's values with NPPES. `record` is null when NPPES has no such NPI. */
export function nppesProviderChecks(values: Values, record: NppesRecord | null): Check[] {
	const npi = values['provider.npi'];
	if (!npi) return [];
	if (!record) return [{ field: 'provider.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} is not in NPPES` }];
	if (record.enumeration_type !== 'NPI-1') return [{ field: 'provider.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} belongs to an organization (Type 2), not a provider` }];
	const b = record.basic;
	if (b.status && b.status !== 'A') return [{ field: 'provider.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} is deactivated in NPPES` }];
	const who = [b.last_name, b.first_name].filter(Boolean).join(', ');
	const checks: Check[] = [{ field: 'provider.npi', status: 'ok', source: 'NPPES', detail: `Active individual NPI in NPPES: ${who}${b.credential ? `, ${b.credential}` : ''}` }];

	const compare = (field: string, theirs: string | undefined, label: string, format = title, match: (a: string, c: string) => boolean = same) => {
		const ours = values[field];
		if (!ours || !theirs) return;
		checks.push(match(ours, theirs)
			? { field, status: 'ok', source: 'NPPES', detail: `Matches NPPES ${label}` }
			: { field, status: 'suggest', source: 'NPPES', detail: `NPPES has ${label} "${theirs}"`, suggestion: format(theirs) });
	};
	compare('provider.first_name', b.first_name, 'first name');
	compare('provider.last_name', b.last_name, 'last name');
	// A middle initial matches a full middle name that starts with it.
	compare('provider.middle_name', b.middle_name, 'middle name', title, (a, c) => same(a, c) || (a.replace(/\W/g, '').length === 1 && same(a[0], c[0])));
	compare('provider.gender', b.sex, 'sex', (s) => s.toUpperCase());
	compare('provider.degree', b.credential, 'credential', credential, (a, c) => same(credential(a), credential(c)));

	const taxonomies = record.taxonomies ?? [];
	const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];
	for (const field of ['provider.taxonomy_1', 'provider.taxonomy_2']) {
		const ours = values[field];
		if (!ours || !taxonomies.length) continue;
		const hit = taxonomies.find((t) => t.code === ours);
		checks.push(hit
			? { field, status: 'ok', source: 'NPPES', detail: `Listed in NPPES for this NPI${hit.primary ? ' as primary' : ''}: ${hit.desc ?? ''}` }
			: field === 'provider.taxonomy_1' && primary
				? { field, status: 'suggest', source: 'NPPES', detail: `NPPES lists ${primary.code} (${primary.desc ?? ''}) as primary`, suggestion: primary.code }
				: { field, status: 'warn', source: 'NPPES', detail: `Not among this NPI's taxonomies in NPPES` });
	}
	const license = values['provider.license_number'];
	const licenses = taxonomies.filter((t) => t.license);
	if (license && licenses.length) {
		checks.push(licenses.some((t) => same(t.license, license))
			? { field: 'provider.license_number', status: 'ok', source: 'NPPES', detail: 'Matches a license in NPPES' }
			: { field: 'provider.license_number', status: 'suggest', source: 'NPPES', detail: `NPPES has license ${licenses[0]!.license} (${licenses[0]!.state ?? ''})`, suggestion: licenses[0]!.license!.toUpperCase().replace(/\s+/g, '') });
	}
	return checks;
}

/** Compare a billing entity's values with NPPES for its billing NPI. */
export function nppesBillingChecks(values: Values, record: NppesRecord | null): Check[] {
	const npi = values['billing.npi'];
	if (!npi) return [];
	if (!record) return [{ field: 'billing.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} is not in NPPES` }];
	if (record.enumeration_type !== 'NPI-2') return [{ field: 'billing.npi', status: 'warn', source: 'NPPES', detail: `NPI ${npi} belongs to an individual (Type 1); billing NPIs are usually organizations` }];
	const b = record.basic;
	if (b.status && b.status !== 'A') return [{ field: 'billing.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} is deactivated in NPPES` }];
	const checks: Check[] = [{ field: 'billing.npi', status: 'ok', source: 'NPPES', detail: `Active organization NPI in NPPES: ${b.organization_name ?? ''}` }];
	const name = values['billing.legal_name'];
	if (name && b.organization_name) {
		checks.push(same(name, b.organization_name)
			? { field: 'billing.legal_name', status: 'ok', source: 'NPPES', detail: 'Matches the organization name in NPPES' }
			: { field: 'billing.legal_name', status: 'suggest', source: 'NPPES', detail: `NPPES has "${b.organization_name}"`, suggestion: b.organization_name });
	}
	return checks;
}

// ─── Census geocoder ────────────────────────────────────────

/** The parts of a Census geocoder address match we compare. */
export interface CensusMatch {
	matchedAddress: string;
	addressComponents: { city?: string; state?: string; zip?: string };
}

const isPoBox = (s = '') => /^PO Box\b/i.test(s);

/** The one-line address to look up for an entity ("practice" or "billing"), or "" if it can't be. */
export function addressLine(values: Values, prefix: 'practice' | 'billing'): string {
	const v = (f: string) => values[`${prefix}.${f}`] ?? '';
	if (!v('address_1') || isPoBox(v('address_1')) || !(v('zip') || (v('city') && v('state')))) return '';
	return `${v('address_1')}, ${v('city')}, ${v('state')} ${v('zip')}`.replace(/\s+/g, ' ').trim();
}

// The geocoder matches the street ("1600 PENNSYLVANIA AVE NW") and ignores a suite or unit. Words of
// line 1 beyond the matched street, when line 2 is empty, belong on line 2: "Ste 4".
function splitCheck(values: Values, prefix: 'practice' | 'billing', match: CensusMatch): Check | null {
	const line1 = values[`${prefix}.address_1`] ?? '';
	if (values[`${prefix}.address_2`]) return null;
	const street = match.matchedAddress.split(',')[0]!.trim().split(/\s+/);
	const words = line1.replace(/,/g, ' ').trim().split(/\s+/);
	if (words.length <= street.length || !same(words[0], street[0])) return null; // same house number, extra words
	const rest = words.slice(street.length).join(' ');
	const kept = words.slice(0, street.length).join(' ');
	return {
		field: `${prefix}.address_1`, status: 'suggest', source: 'Census',
		detail: `The Census geocoder matched "${match.matchedAddress.split(',')[0]}"; "${rest}" goes on line 2`,
		suggestion: kept, also: { [`${prefix}.address_2`]: rest },
	};
}

/** Compare an address with the Census geocoder's match. `match` is null when it found none. */
export function censusChecks(values: Values, prefix: 'practice' | 'billing', match: CensusMatch | null): Check[] {
	const field = `${prefix}.address_1`;
	if (isPoBox(values[field])) return [{ field, status: 'skip', source: 'Census', detail: "PO boxes can't be checked with the Census geocoder" }];
	if (!addressLine(values, prefix)) return [];
	if (!match) return [{ field, status: 'warn', source: 'Census', detail: "The Census geocoder couldn't find this address. It may be new, or need checking" }];
	const checks: Check[] = [splitCheck(values, prefix, match) ?? { field, status: 'ok', source: 'Census', detail: `Found by the Census geocoder: ${match.matchedAddress}` }];
	const c = match.addressComponents;
	const part = (name: string, theirs: string | undefined, format: (s: string) => string) => {
		const f = `${prefix}.${name}`;
		const ours = values[f];
		if (!theirs) return;
		if (!ours) checks.push({ field: f, status: 'suggest', source: 'Census', detail: `The Census geocoder has ${name} ${theirs}`, suggestion: format(theirs) });
		else checks.push(same(ours, theirs)
			? { field: f, status: 'ok', source: 'Census', detail: `Matches the Census geocoder` }
			: { field: f, status: 'suggest', source: 'Census', detail: `The Census geocoder has ${name} ${theirs}`, suggestion: format(theirs) });
	};
	part('city', c.city, title);
	part('state', c.state, (s) => s.toUpperCase());
	part('zip', c.zip, (s) => s);
	return checks;
}
