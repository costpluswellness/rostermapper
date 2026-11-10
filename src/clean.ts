// Clean: put each value in the format the data dictionary promises, and flag values that can be
// told wrong from the value alone (NPI check digit, IRS tax ID prefix, NUCC taxonomy code). A value
// that can't be fixed is kept as written and reported, never dropped. Checks against outside
// sources (NPPES, Census) are Validate's.
import { NUCC, NUCC_VERSION } from './nucc.generated';
import { DEA, isValidNpi, STATES, TAXONOMY, type ValueType } from './profile/value-type';
import type { OutputType } from './types';

export interface Cleaned {
	value: string;
	/** Why the value couldn't be cleaned. Absent when it could. */
	issue?: string;
}

type Cleaner = (value: string) => Cleaned;

const ok = (value: string): Cleaned => ({ value });
const bad = (value: string, issue: string): Cleaned => ({ value, issue });
const digits = (value: string) => value.replace(/\D/g, '');

/**
 * Clean one value of a field. Empty values stay empty. The cleaner comes from the field itself
 * (special cases), else the field's main value type in the schema (`values`, so any phone, ZIP,
 * state, NPI, … field is cleaned), else its output type (dates, yes/no).
 */
export function cleanValue(field: string, type: OutputType, value: string, values: readonly ValueType[] = []): Cleaned {
	const text = value.replace(/\s+/g, ' ').trim();
	if (!text) return ok('');
	const cleaner = cleanerFor(field, type, values);
	return cleaner ? cleaner(text) : ok(text);
}

/** True if values of this field are put in a standard format (not just trimmed). */
export const isStandardized = (field: string, type: OutputType, values: readonly ValueType[] = []): boolean =>
	field === 'network.action_type' || !!cleanerFor(field, type, values); // the action is always ADD, UPDATE or TERM

/** Names, cities, addresses and other text a person may need to fix by hand: no strict format. */
export const isFreeText = (field: string, type: OutputType, values: readonly ValueType[] = []): boolean => {
	if (field === 'network.action_type') return false;
	const cleaner = cleanerFor(field, type, values);
	return !cleaner || cleaner === titleCase || cleaner === middleName || cleaner === address;
};

const cleanerFor = (field: string, type: OutputType, values: readonly ValueType[]): Cleaner | undefined =>
	BY_FIELD[field] ?? (values[0] && BY_VALUE[values[0]]) ?? BY_TYPE[type];

// ─── Dates ──────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Two-digit years: birth dates are 19xx, every other date 20xx.
const date = (century: number): Cleaner => (value) => {
	const parts = dateParts(value, century);
	if (!parts) return bad(value, `can't read "${value}" as a date`);
	const [y, m, d] = parts;
	const check = new Date(Date.UTC(y, m - 1, d));
	if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return bad(value, `"${value}" is not a real date`);
	return ok(`${y}-${pad(m, 2)}-${pad(d, 2)}`);
};

function dateParts(value: string, century: number): [number, number, number] | null {
	let m: RegExpMatchArray | null;
	if ((m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([ T].*)?$/))) return [+m[1]!, +m[2]!, +m[3]!];
	if ((m = value.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/))) return [year(m[3]!, century), +m[1]!, +m[2]!];
	if ((m = value.match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/))) return [+m[1]!, +m[2]!, +m[3]!];
	if ((m = value.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/)) && MONTHS.includes(m[1]!.toLowerCase())) {
		return [+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!];
	}
	// Excel serial day number (days since 1899-12-30), when a date cell was stored as a number.
	if (/^\d{5}$/.test(value) && +value > 10000 && +value < 80000) {
		const d = new Date(Date.UTC(1899, 11, 30) + +value * 86400000);
		return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
	}
	return null;
}

const year = (y: string, century: number) => (y.length === 2 ? century + +y : +y);
const pad = (n: number | string, width: number) => String(n).padStart(width, '0');

// ─── Identifiers and numbers ────────────────────────────────

const npi: Cleaner = (value) => {
	const d = digits(value);
	if (d.length !== 10) return bad(value, `NPI "${value}" is not 10 digits`);
	return isValidNpi(d) ? ok(d) : bad(d, `NPI ${d} fails the check digit`);
};

// Two-digit prefixes the IRS assigns to EINs.
const EIN_PREFIXES = new Set(
	[[1, 6], [10, 16], [20, 27], [30, 48], [50, 68], [71, 77], [80, 88], [90, 95], [98, 99]]
		.flatMap(([a, b]) => Array.from({ length: b! - a! + 1 }, (_, i) => String(a! + i).padStart(2, '0'))),
);

const tin: Cleaner = (value) => {
	let d = digits(value);
	if (d.length === 8) d = '0' + d; // Excel drops leading zeros
	if (d.length !== 9) return bad(value, `tax ID "${value}" is not 9 digits`);
	const formatted = `${d.slice(0, 2)}-${d.slice(2)}`;
	return EIN_PREFIXES.has(d.slice(0, 2)) ? ok(formatted) : bad(formatted, `${d.slice(0, 2)} is not a tax ID prefix the IRS assigns`);
};

const zip: Cleaner = (value) => {
	const d = digits(value);
	if (d.length === 9) return ok(d.slice(0, 5)); // ZIP+4
	if (d.length >= 3 && d.length <= 5) return ok(pad(d, 5)); // Excel drops leading zeros
	return bad(value, `ZIP "${value}" is not 5 digits`);
};

const phone: Cleaner = (value) => {
	const extension = value.match(/\s*(?:ext\.?|x)\s*(\d+)\s*$/i);
	let d = digits(extension ? value.slice(0, extension.index) : value);
	if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
	if (d.length !== 10) return bad(value, `phone "${value}" is not 10 digits`);
	const formatted = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
	return extension ? bad(formatted, `extension ${extension[1]} dropped`) : ok(formatted);
};

const pattern = (re: RegExp, label: string): Cleaner => (value) => {
	const upper = value.replace(/\s/g, '').toUpperCase();
	return re.test(upper) ? ok(upper) : bad(value, `"${value}" is not a valid ${label}`);
};
const taxonomy: Cleaner = (value) => {
	const cleaned = pattern(TAXONOMY, 'taxonomy code')(value);
	if (cleaned.issue || NUCC[cleaned.value]) return cleaned;
	return bad(cleaned.value, `${cleaned.value} is not in the NUCC list (${NUCC_VERSION})`);
};

// ─── States ─────────────────────────────────────────────────

const STATE_NAMES: Record<string, string> = {
	alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
	delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
	indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
	massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
	nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
	'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
	'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
	vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
	'puerto rico': 'PR', 'virgin islands': 'VI', guam: 'GU', 'american samoa': 'AS', 'northern mariana islands': 'MP',
};

const state: Cleaner = (value) => {
	const key = value.replace(/\./g, '').trim();
	const code = STATES.has(key.toUpperCase()) ? key.toUpperCase() : STATE_NAMES[key.toLowerCase()];
	return code ? ok(code) : bad(value, `"${value}" is not a US state`);
};

// ─── Choices ────────────────────────────────────────────────

// First matching pattern wins; checked against the lowercased value.
const choice = (label: string, options: [RegExp, string][]): Cleaner => (value) => {
	const found = options.find(([re]) => re.test(value.toLowerCase()));
	return found ? ok(found[1]) : bad(value, `can't read "${value}" as ${label}`);
};

export const YES = /^(y|yes|true|x|1)$/i;
export const NO = /^(n|no|false|0)$/i;

const yesNo = choice('yes or no', [
	[YES, '1'],
	[NO, '0'],
]);

const gender = choice('M or F', [
	[/^(m|male)$/, 'M'],
	[/^(f|female)$/, 'F'],
]);

const providerType = choice('a provider type', [
	[/^app\b|^(advanced practice|advanced practice provider|np|pa|nurse practitioner|physician assistant|midlevel|mid-level)$/, 'APP'],
	[/^(p|pcp|primary care|primary care provider|primary)$/, 'PCP'],
	[/^(s|spc|spec|specialist|specialty|specialty care)$/, 'SPEC'],
	[/^(hosp|hospitalist|hospital)$/, 'HOSP'],
	[/^(bh|behavioral health|behavioral)$/, 'BH'],
]);

const locationType = choice('Primary, Secondary or Alternate', [
	[/^(primary|prim|p)$/, 'Primary'],
	[/^(secondary|second|sec|s)$/, 'Secondary'],
	[/^(alternate|alt|additional|additional office|third|fourth|fifth|sixth)$/, 'Alternate'],
]);

// Some files answer yes/no questions with the category instead: "Primary" for is-primary, "PCP" for is-PCP.
const isPrimary = choice('yes or no', [
	[/^(y|yes|true|x|1|primary|prim)$/, '1'],
	[/^(n|no|false|0|secondary|alternate|additional|additional office|third|fourth|fifth|previous)$/, '0'],
]);

const isPcp = choice('yes or no', [
	[/^(y|yes|true|x|1|pcp|primary care)$/, '1'],
	[/^(n|no|false|0|s|spc|spec|specialist)$/, '0'],
]);

// ─── Text ───────────────────────────────────────────────────

/** "M.D." → "MD", "MD/PhD" → "MD, PhD". Case kept as written. */
export const cleanDegree = (value: string): string =>
	value.split(/\s*[,/;&]\s*|\s+and\s+/i).map((d) => d.replace(/\./g, '').trim()).filter(Boolean).join(', ');
const degree: Cleaner = (value) => ok(cleanDegree(value));

const suffix: Cleaner = (value) => ok(value.replace(/\./g, ''));

// "md 12345" → "MD12345": uppercase, spaces removed. Dashes kept; some states use them.
const license: Cleaner = (value) => ok(value.toUpperCase().replace(/\s+/g, ''));

// "FORT WORTH" or "fort worth" → "Fort Worth". Mixed case is kept: "McAllen" stays "McAllen".
// Used for cities and names: basic cleaning only; Validate checks values against sources.
/** "FORT WORTH" → "Fort Worth", always (used for values from sources, which come in caps). */
export const toTitleCase = (value: string): string =>
	value.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
const titleCase: Cleaner = (value) => ok(value === value.toUpperCase() || value === value.toLowerCase() ? toTitleCase(value) : value);
// Middle names are often an initial with a dot: "J." → "J", "J. R." → "J R". Hyphens and apostrophes stay.
const middleName: Cleaner = (value) => titleCase(value.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim());

// "P.O. Box 1100", "POB 1100", "Post Office Box #1100", "PO BOX 1100" → "PO Box 1100". Other text kept.
const address: Cleaner = (value) =>
	ok(value.replace(/\b(?:p\.?\s*o\.?\s*b(?:ox)?\.?|post\s+office\s+box)\s*#?\s*(?=\d)/gi, 'PO Box '));
const email: Cleaner = (value) => ok(value.toLowerCase());

// ─── Which cleaner for which field ──────────────────────────

const BY_FIELD: Record<string, Cleaner> = {
	'provider.npi': npi,
	'billing.npi': npi,
	'billing.tax_id': tin,
	'practice.zip': zip,
	'billing.zip': zip,
	'practice.phone': phone,
	'practice.fax': phone,
	'practice.state': state,
	'billing.state': state,
	'provider.license_state': state,
	'provider.date_of_birth': date(1900),
	'provider.gender': gender,
	'provider.taxonomy_1': taxonomy,
	'provider.taxonomy_2': taxonomy,
	'provider.dea_number': pattern(DEA, 'DEA number'),
	'provider.degree': degree,
	'provider.suffix': suffix,
	'provider.email': email,
	'network.sender_email': email,
	'practice.city': titleCase,
	'billing.city': titleCase,
	'provider.first_name': titleCase,
	'provider.middle_name': middleName,
	'provider.last_name': titleCase,
	'provider.license_number': license,
	'practice.address_1': address,
	'practice.address_2': address,
	'billing.address_1': address,
	'billing.address_2': address,
	'network.provider_type': providerType,
	'network.location_type': locationType,
	'network.is_primary_location': isPrimary,
	'network.is_pcp': isPcp,
};

// By a field's main value type in the schema, so new fields of these kinds are cleaned too.
const BY_VALUE: Partial<Record<ValueType, Cleaner>> = {
	npi,
	tin,
	zip,
	phone,
	state,
	gender,
	date: date(2000),
	taxonomy,
	dea: pattern(DEA, 'DEA number'),
	boolean: yesNo,
};

const BY_TYPE: Partial<Record<OutputType, Cleaner>> = {
	date: date(2000),
	boolean: yesNo,
};

// ─── Rules, for the UI ───────────────────────────────────────

// What each cleaner does, in one short line. Shown when hovering a field name in the UI.
const RULES = new Map<Cleaner, string>([
	[npi, 'Becomes 10 digits; check digit verified'],
	[tin, 'Becomes XX-XXXXXXX; prefix must be one the IRS assigns'],
	[taxonomy, 'Becomes an uppercase code in the NUCC list'],
	[zip, 'Becomes 5 digits; leading zeros that Excel drops are restored'],
	[phone, 'Becomes XXX-XXX-XXXX'],
	[state, 'Becomes a two-letter code'],
	[gender, 'Becomes M or F'],
	[yesNo, 'Yes/No becomes 1/0'],
	[isPrimary, 'Yes/No becomes 1/0'],
	[isPcp, 'Yes/No becomes 1/0'],
	[providerType, 'Becomes SPEC, PCP, BH, APP or HOSP'],
	[locationType, 'Becomes Primary, Secondary or Alternate'],
	[degree, 'Dots removed: M.D. becomes MD'],
	[suffix, 'Dots removed'],
	[email, 'Becomes lowercase'],
	[address, 'PO boxes become PO Box 123'],
	[titleCase, 'ALL CAPS or lowercase becomes Title Case'],
	[middleName, 'Dots removed; ALL CAPS or lowercase becomes Title Case'],
	[license, 'Becomes uppercase, spaces removed'],
]);

/** How a field's values are standardized, in one short line ("Used as written" if they aren't). */
export function standardRule(field: string, type: OutputType, values: readonly ValueType[] = []): string {
	if (field === 'network.action_type') return 'ADD, UPDATE or TERM only';
	const cleaner = cleanerFor(field, type, values);
	if (!cleaner) return 'Used as written';
	if (RULES.has(cleaner)) return RULES.get(cleaner)!;
	if (type === 'date') return 'Becomes YYYY-MM-DD';
	if (values[0] === 'taxonomy') return 'Becomes an uppercase NUCC code';
	if (values[0] === 'dea') return 'Becomes an uppercase DEA number';
	return 'Standardized';
}
