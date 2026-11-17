// Validate: compare cleaned values with outside sources, field by field. Never changes a value.
// Checks a value can fail on its own (NPI check digit, IRS tax ID prefix, NUCC code) are part of
// cleaning (see clean.ts). Here a record is compared with what NPPES has for its NPI and what the US
// Census geocoder finds for its address; the UI's "Run checks" fetches those through the CLI's local
// server. Everything here is pure, so it runs anywhere.
import { cleanDegree, toTitleCase } from '../standardize/clean';

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
	/** The row can't move forward (wrong or unusable NPI). Only with status "fail". */
	drop?: true;
	/** Apply the suggestion without asking; the user can undo it (Census addresses, NPPES legal names). */
	auto?: true;
	/** Shown on the card, but not an issue: the source couldn't confirm, which isn't a fault in the row. */
	quiet?: true;
	/** The roster's value is preferred (degrees, taxonomies): offered one at a time, never in a "Use all". */
	keep?: true;
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

const letters = (s: string) => s.normalize('NFD').toLowerCase().replace(/[^a-z\s-]/g, '');

// Edits to turn a into b; swapping two neighbouring letters ("Jhon" → "John") counts as one.
function editDistance(a: string, b: string): number {
	let before: number[] = [];
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, before[j - 2]! + 1);
		}
		[before, prev] = [prev, row];
	}
	return prev[b.length]!;
}

/**
 * How far apart two names are. "close": a typo, a nickname that starts the full name (Jon/Jonathan),
 * or a shared part of a compound name (Smith/Smith-Jones). "different": nothing in common, so most
 * likely another person. `first`: also close when they start with the same letter, for an initial
 * ("W. Stuart" for Walter) or a nickname (Tom for Thomas).
 */
export function nameDifference(a: string, b: string, { first = false } = {}): 'same' | 'close' | 'different' {
	const [x, y] = [letters(a), letters(b)];
	const [fx, fy] = [x.replace(/[\s-]/g, ''), y.replace(/[\s-]/g, '')];
	if (fx === fy) return 'same';
	if (!fx || !fy || fx.startsWith(fy) || fy.startsWith(fx) || (first && fx[0] === fy[0])) return 'close';
	const parts = new Set(x.split(/[\s-]+/).filter((p) => p.length > 1));
	if (y.split(/[\s-]+/).some((p) => parts.has(p))) return 'close';
	return editDistance(fx, fy) / Math.max(fx.length, fy.length) <= 0.4 ? 'close' : 'different';
}

// Credentials by kind of provider, so "PA-C" and "PA", or "FNP-BC" and "NP", count as the same.
const DEGREE_FAMILIES: [RegExp, string][] = [
	[/^(MD|DO|MBBS|MBBCH|MBCHB|MB|BMBS)(PA|PC|PS|PLLC)?$/, 'physician'], // "MDPA": MD, Professional Association
	[/^(PA|PAC|MPAS|MMS|MPA|RPA)$/, 'physician assistant'],
	[/^(NP|[A-Z]*NP|APRN|APN|ARNP|CNS|CNM|CRNA|DNP|MSN|BSN|RN|CAA)$/, 'nurse practitioner'],
	[/^(PHD|PSYD|LPC|LCSW|LMSW|LMFT|MMFT|LMHC|LCPC|LCMHC|LPCC|LISW|LCADC|LADC|BCBA)$/, 'behavioral health'],
	[/^(PT|DPT|MPT|MSPT)$/, 'physical therapist'],
	[/^(OT|OTR|OTRL|MOT|OTD)$/, 'occupational therapist'],
	[/^(RD|LD|RDN|LDN|CDE|CDCES)$/, 'dietitian'],
	[/^(DDS|DMD)$/, 'dentist'],
];
// Academic degrees that say nothing about the kind of provider.
const GENERIC = new Set(['MS', 'MA', 'BS', 'BA', 'AA', 'MPH', 'MBA', 'MED', 'MHS', 'MHA', 'FACS', 'FACP', 'FAAP', 'FACR', 'ASSOCIATE']);
const degreeFamilies = (s: string) =>
	new Set(credential(s).toUpperCase()
		.replace(/\b([A-Z])\.?\s+(?=[A-Z]\b)/g, '$1') // "M D P A" → "MDPA"
		.split(/[,\s]+/).map((d) => {
			const base = d.replace(/\./g, '').replace(/-(C|BC|S|A|ASSOCIATE)$/, '').replace(/^-+|-+$/g, '').replace(/-/g, ''); // board-certified, supervisor, associate
			return DEGREE_FAMILIES.find(([re]) => re.test(base))?.[1] ?? base;
		}).filter((d) => d && !GENERIC.has(d)));

/** True when two credentials name different kinds of provider: "MD" and "CRNA", not "PA-C" and "PA". */
export function degreesDiffer(a: string, b: string): boolean {
	const [ours, theirs] = [degreeFamilies(a), degreeFamilies(b)];
	return ours.size > 0 && theirs.size > 0 && ![...theirs].some((d) => ours.has(d));
}

const differs = (ours = '', theirs = '', isFirst = false) => !!ours && !!theirs && nameDifference(ours, theirs, { first: isFirst }) === 'different';

/**
 * Whether NPPES should be searched by the roster's name, to find the provider's real NPI: the NPI's
 * last name is nothing like the roster's (a wrong NPI, or a name change). Needs a first and last name.
 */
export function wantsNameSearch(values: Values, record: NppesRecord | null): boolean {
	const [first, last] = [values['provider.first_name'], values['provider.last_name']];
	return !!first && !!last && record?.enumeration_type === 'NPI-1' && differs(last, record.basic.last_name);
}

/**
 * Compare a provider's values with NPPES. `record` is null when NPPES has no such NPI. `byName`: the
 * active individual NPIs NPPES has under the roster's first and last name, when it was searched (see
 * wantsNameSearch); one other NPI there means the roster's NPI is wrong.
 */
export function nppesProviderChecks(values: Values, record: NppesRecord | null, byName?: readonly NppesRecord[] | null): Check[] {
	const npi = values['provider.npi'];
	if (!npi) return [];
	const reject = (detail: string, suggestion?: string): Check[] => [{ field: 'provider.npi', status: 'fail', source: 'NPPES', detail: `${detail}; row dropped`, drop: true, ...(suggestion && { suggestion }) }];
	if (!record) return reject(`NPI ${npi} is not in NPPES`);
	if (record.enumeration_type !== 'NPI-1') return reject(`NPI ${npi} belongs to an organization (Type 2), not a provider`);
	const b = record.basic;
	if (b.status && b.status !== 'A') return reject(`NPI ${npi} is deactivated in NPPES`);
	const who = [b.last_name, b.first_name].filter(Boolean).join(', ') + (b.credential ? `, ${b.credential}` : '');

	const [first, last] = [values['provider.first_name'] ?? '', values['provider.last_name'] ?? ''];
	const ours = [last, first].filter(Boolean).join(', ') + (values['provider.degree'] ? `, ${values['provider.degree']}` : '');
	const checks: Check[] = [{ field: 'provider.npi', status: 'ok', source: 'NPPES', detail: `Active individual NPI in NPPES: ${who}` }];
	// The provider under another NPI in NPPES: the roster's NPI is wrong. Suggest the right one.
	const others = (byName ?? []).filter((r) => String(r.number) !== npi && r.enumeration_type === 'NPI-1' && (!r.basic.status || r.basic.status === 'A'));
	const lastDiffers = differs(last, b.last_name);
	// No first name ("Metropolitan Anesthesia Consultants" as a last name): the last name decides alone.
	const firstDiffers = first ? differs(first, b.first_name, true) : lastDiffers;
	if (lastDiffers && first && !differs(first, b.last_name) && !differs(last, b.first_name, true)) {
		// First and last swapped ("May, Amanda" for Amanda May): the same person, the columns crossed.
		checks.push({ field: 'provider.first_name', status: 'warn', source: 'NPPES', detail: `NPPES has ${b.first_name} ${b.last_name}: first and last name look swapped` });
	} else if (lastDiffers && others.length === 1) {
		return reject(`NPI ${npi} is ${who} in NPPES; ${first} ${last} is NPI ${others[0]!.number}`, String(others[0]!.number));
	} else if (lastDiffers && firstDiffers) {
		// Both names unlike NPPES's: the NPI belongs to someone else. Don't suggest their name; drop the row.
		const more = others.length > 1 ? ` (${others.length} providers named ${first} ${last} in NPPES)` : '';
		return reject(`NPI ${npi} is ${who} in NPPES, not ${ours}${more}`);
	} else {
		// One name unlike NPPES's: worth a look, beyond the suggestion.
		if (firstDiffers) checks.push({ field: 'provider.first_name', status: 'warn', source: 'NPPES', detail: `NPPES has first name "${b.first_name}", nothing like "${first}"; check the NPI` });
		if (lastDiffers) {
			const searched = byName ? `; NPPES has no other ${first} ${last}, so maybe a name change` : '';
			checks.push({ field: 'provider.last_name', status: 'warn', source: 'NPPES', detail: `NPPES has last name "${b.last_name}", nothing like "${last}"${searched}; check the NPI` });
		}
	}
	// Degrees and taxonomies: the roster's value is kept by default. Providers update NPPES slowly, so
	// its credential and taxonomies are suggestions to accept one by one, and a difference isn't an issue.
	const degree = values['provider.degree'];
	if (degree && b.credential) {
		const kind = degreesDiffer(degree, b.credential) ? ', a different kind of provider' : '';
		checks.push(same(credential(degree), credential(b.credential))
			? { field: 'provider.degree', status: 'ok', source: 'NPPES', detail: 'Matches NPPES credential' }
			: { field: 'provider.degree', status: 'suggest', source: 'NPPES', keep: true, detail: `NPPES has credential "${b.credential}"${kind}; the roster's is kept unless you use it`, suggestion: credential(b.credential) });
	}

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

	const taxonomies = record.taxonomies ?? [];
	const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];
	for (const field of ['provider.taxonomy_1', 'provider.taxonomy_2']) {
		const ours = values[field];
		if (!ours || !taxonomies.length) continue;
		const hit = taxonomies.find((t) => t.code === ours);
		// Taxonomy 1: NPPES's primary. Taxonomy 2: another of its taxonomies the row doesn't have.
		const other = field === 'provider.taxonomy_1' ? primary : taxonomies.find((t) => t.code !== values['provider.taxonomy_1'] && t !== primary) ?? taxonomies.find((t) => t.code !== values['provider.taxonomy_1']);
		checks.push(hit
			? { field, status: 'ok', source: 'NPPES', detail: `Listed in NPPES for this NPI${hit.primary ? ' as primary' : ''}: ${hit.desc ?? ''}` }
			: other
				? { field, status: 'suggest', source: 'NPPES', keep: true, detail: `Not among this NPI's taxonomies in NPPES, which lists ${other.code} (${other.desc ?? ''})${other.primary ? ' as primary' : ''}; the roster's is kept unless you use it`, suggestion: other.code }
				: { field, status: 'warn', source: 'NPPES', quiet: true, detail: `Not among this NPI's taxonomies in NPPES; the roster's is kept` });
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
	if (!record) return [{ field: 'billing.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} is not in NPPES; row dropped`, drop: true }];
	if (record.enumeration_type !== 'NPI-2') return [{ field: 'billing.npi', status: 'warn', source: 'NPPES', detail: `NPI ${npi} belongs to an individual (Type 1); billing NPIs are usually organizations` }];
	const b = record.basic;
	if (b.status && b.status !== 'A') return [{ field: 'billing.npi', status: 'fail', source: 'NPPES', detail: `NPI ${npi} is deactivated in NPPES; row dropped`, drop: true }];
	const checks: Check[] = [{ field: 'billing.npi', status: 'ok', source: 'NPPES', detail: `Active organization NPI in NPPES: ${b.organization_name ?? ''}` }];
	const name = values['billing.legal_name'];
	const theirs = b.organization_name ? orgName(b.organization_name) : '';
	if (name && theirs) {
		if (same(name, theirs) || same(name, b.organization_name)) checks.push({ field: 'billing.legal_name', status: 'ok', source: 'NPPES', detail: 'Matches the organization name in NPPES' });
		// NPPES's legal name is used unless it shares no word with the roster's: then it may be the wrong NPI.
		else if (sharesWord(name, theirs)) checks.push({ field: 'billing.legal_name', status: 'suggest', source: 'NPPES', detail: `NPPES has "${b.organization_name}"`, suggestion: theirs, auto: true });
		else checks.push(
			{ field: 'billing.legal_name', status: 'suggest', source: 'NPPES', detail: `NPPES has "${b.organization_name}"`, suggestion: theirs },
			{ field: 'billing.legal_name', status: 'warn', source: 'NPPES', detail: `NPPES has "${b.organization_name}", nothing like "${name}"; check the billing NPI` },
		);
	}
	return checks;
}

// Words that don't tell two organizations apart.
const ORG_FILLER = new Set(['the', 'of', 'and', 'llc', 'pllc', 'pc', 'pa', 'inc', 'llp', 'lp', 'ltd', 'co', 'corp', 'group', 'associates', 'medical', 'health', 'healthcare', 'clinic', 'center', 'services', 'professional', 'limited', 'liability', 'company', 'corporation', 'association', 'dba', 'texas', 'tx']);
const orgWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !ORG_FILLER.has(w));
const sharesWord = (a: string, b: string) => {
	const ours = new Set(orgWords(a));
	return orgWords(b).some((w) => ours.has(w));
};

const ENTITY_TYPES: [RegExp, string][] = [
	[/\bprofessional limited liability company\b/gi, 'PLLC'],
	[/\blimited liability company\b/gi, 'LLC'],
	[/\blimited liability partnership\b/gi, 'LLP'],
	[/\bprofessional association\b/gi, 'PA'],
	[/\bprofessional corporation\b/gi, 'PC'],
];
const UPPER = new Set(['LLC', 'PLLC', 'PC', 'PA', 'LLP', 'LP', 'MD', 'DO', 'DDS', 'II', 'III', 'IV', 'USA', 'US', 'ASC', 'ENT', 'OB', 'GYN', 'BSW']);

/** An organization name from NPPES (in capitals) as a legal name: "DK PHYSICIANS PROFESSIONAL LIMITED LIABILITY COMPANY" → "DK Physicians PLLC". */
export function orgName(value: string): string {
	let s = value.replace(/\s+/g, ' ').trim();
	for (const [re, short] of ENTITY_TYPES) s = s.replace(re, short);
	return s.split(' ').map((w) => {
		const bare = w.replace(/[^A-Za-z]/g, '').toUpperCase();
		if (UPPER.has(bare) || (bare.length <= 2 && /^[A-Z]+$/.test(w) && !/^(OF|AT|IN|ON|BY|TO)$/.test(bare))) return w.toUpperCase();
		return toTitleCase(w);
	}).join(' ').replace(/\b(Of|And|The|At|For)\b(?!$)/g, (m, _w, i) => (i === 0 ? m : m.toLowerCase()));
}

// ─── Census geocoder ────────────────────────────────────────

/** The parts of a Census geocoder address match we compare. */
export interface CensusMatch {
	matchedAddress: string;
	addressComponents: { city?: string; state?: string; zip?: string };
}

const isPoBox = (s = '') => /^PO Box\b/i.test(s);

// A unit after the street: "Ste 105", "Suite A-500", "Bldg 2", "# 4".
const UNIT = /[\s,]+(?:ste|suite|unit|apt|bldg|building|fl|floor|rm|room|#)\b.*$/i;

/**
 * Line 1 as the geocoder wants it: the street only, from the house number on ("Professional 1 2302
 * Lone Star Rd Ste 160" → "2302 Lone Star Rd"). Used to retry a lookup that found nothing.
 */
export function streetOnly(line1: string): string {
	const words = line1.replace(UNIT, '').replace(/,/g, ' ').trim().split(/\s+/);
	const start = words.findIndex((w, i) => /^\d+[A-Za-z]?$/.test(w) && /[A-Za-z]/.test(words[i + 1] ?? ''));
	return (start > 0 ? words.slice(start) : words).join(' ');
}

/** The one-line address to look up for an entity ("practice" or "billing"), or "" if it can't be. */
export function addressLine(values: Values, prefix: 'practice' | 'billing'): string {
	const v = (f: string) => values[`${prefix}.${f}`] ?? '';
	if (!v('address_1') || isPoBox(v('address_1')) || !(v('zip') || (v('city') && v('state')))) return '';
	return `${v('address_1')}, ${v('city')}, ${v('state')} ${v('zip')}`.replace(/\s+/g, ' ').trim();
}

// The geocoder matches the street ("1600 PENNSYLVANIA AVE NW") and ignores a suite or unit. Words of
// line 1 around the matched street belong on line 2: a suite after it ("Ste 4"), a building name
// before it ("Professional 1"). Added to line 2 when it has something already.
function splitCheck(values: Values, prefix: 'practice' | 'billing', match: CensusMatch): Check | null {
	const line1 = values[`${prefix}.address_1`] ?? '';
	const line2 = values[`${prefix}.address_2`] ?? '';
	const street = match.matchedAddress.split(',')[0]!.trim().split(/\s+/);
	const words = line1.replace(/,/g, ' ').trim().split(/\s+/);
	const start = words.findIndex((w) => same(w, street[0])); // the house number
	if (start < 0 || words.length <= street.length) return null;
	const rest = [...words.slice(start + street.length), ...words.slice(0, start)].join(' ');
	if (!rest) return null;
	const kept = words.slice(start, start + street.length).join(' ');
	return {
		field: `${prefix}.address_1`, status: 'suggest', source: 'Census', auto: true,
		detail: `The Census geocoder matched "${match.matchedAddress.split(',')[0]}"; "${rest}" goes on line 2`,
		suggestion: kept, also: { [`${prefix}.address_2`]: line2 ? `${line2}, ${rest}` : rest },
	};
}

/** Compare an address with the Census geocoder's match. `match` is null when it found none. */
export function censusChecks(values: Values, prefix: 'practice' | 'billing', match: CensusMatch | null): Check[] {
	const field = `${prefix}.address_1`;
	if (isPoBox(values[field])) return [{ field, status: 'skip', source: 'Census', detail: "PO boxes can't be checked with the Census geocoder" }];
	if (!addressLine(values, prefix)) return [];
	if (!match) return [{ field, status: 'warn', source: 'Census', quiet: true, detail: "Not in the Census geocoder's street ranges, common for newer or commercial addresses. Not an error; check it if it looks wrong" }];
	const checks: Check[] = [splitCheck(values, prefix, match) ?? { field, status: 'ok', source: 'Census', detail: `Found by the Census geocoder: ${match.matchedAddress}` }];
	const c = match.addressComponents;
	const part = (name: string, theirs: string | undefined, format: (s: string) => string) => {
		const f = `${prefix}.${name}`;
		const ours = values[f];
		if (!theirs) return;
		if (!ours) checks.push({ field: f, status: 'suggest', source: 'Census', auto: true, detail: `The Census geocoder has ${name} ${theirs}`, suggestion: format(theirs) });
		else checks.push(same(ours, theirs)
			? { field: f, status: 'ok', source: 'Census', detail: `Matches the Census geocoder` }
			: { field: f, status: 'suggest', source: 'Census', auto: true, detail: `The Census geocoder has ${name} ${theirs}`, suggestion: format(theirs) });
	};
	part('city', c.city, title);
	part('state', c.state, (s) => s.toUpperCase());
	part('zip', c.zip, (s) => s);
	return checks;
}
