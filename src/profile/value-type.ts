// Self-contained (no imports) so scripts/build-schema.ts can load it directly.

/** US state and territory codes. */
export const STATES: ReadonlySet<string> = new Set(
	('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
		'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP').split(' '),
);

const DATE_RE =
	/^(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}([ T].*)?|(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01]))$/;

/** NUCC taxonomy code: 207Q00000X. */
export const TAXONOMY = /^\d{3}[0-9A-Z]{6}X$/i;
/** DEA registration number: AB1234567. */
export const DEA = /^[A-Z]{2}\d{7}$/i;

const text = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

// Luhn over "80840" + the first 9 digits (the CMS NPI check digit).
export function isValidNpi(digits: string): boolean {
	const s = '80840' + digits.slice(0, 9);
	let sum = 0;
	for (let i = s.length - 1, double = true; i >= 0; i--, double = !double) {
		let n = Number(s[i]);
		if (double) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
	}
	return (10 - (sum % 10)) % 10 === Number(digits[9]);
}

// Priority order: the first type that reaches the threshold wins.
const TESTS = {
	npi: (v) => /^\d{10}$/.test(text(v)) && isValidNpi(text(v)),
	ssn: (v) => /^\d{3}-\d{2}-\d{4}$/.test(text(v)),
	tin: (v) => /^\d{2}-?\d{7}$/.test(text(v)),
	taxonomy: (v) => TAXONOMY.test(text(v)),
	date: (v) => v instanceof Date || DATE_RE.test(text(v)),
	phone: (v) => /^\+?1?[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/.test(text(v)),
	zip: (v) => /^\d{5}(-\d{4})?$/.test(text(v)),
	state: (v) => STATES.has(text(v).toUpperCase()),
	gender: (v) => /^(m|f|male|female)$/i.test(text(v)),
	boolean: (v) => /^(y|n|yes|no|true|false|x)$/i.test(text(v)),
	email: (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(text(v)),
	url: (v) => /^(https?:\/\/)?(www\.)?[a-z0-9\-]+(\.[a-z0-9\-]+)+(\/\S*)?$/i.test(text(v)),
	dea: (v) => DEA.test(text(v)),
	integer: (v) => /^-?\d+$/.test(text(v)),
	number: (v) => /^-?[\d,]*\.?\d+$/.test(text(v)),
} satisfies Record<string, (value: unknown) => boolean>;

type TestedType = keyof typeof TESTS;

/** A column's value type. `enum` = few distinct values; `text` = anything else. */
export type ValueType = TestedType | 'enum' | 'text' | 'empty';

export const VALUE_TYPES: readonly ValueType[] = [...(Object.keys(TESTS) as TestedType[]), 'enum', 'text', 'empty'];

export interface DetectedType {
	type: ValueType;
	confidence: number;
	/** Share of values passing each test. */
	scores: Partial<Record<TestedType, number>>;
}

/** Detect the type of a column from its non-blank values. */
export function detectType(values: readonly unknown[], threshold = 0.8): DetectedType {
	if (!values.length) return { type: 'empty', confidence: 1, scores: {} };

	const scores: DetectedType['scores'] = {};
	for (const [type, test] of Object.entries(TESTS) as [TestedType, (v: unknown) => boolean][]) {
		const hits = values.filter(test).length;
		if (hits) scores[type] = hits / values.length;
	}
	for (const type of Object.keys(TESTS) as TestedType[]) {
		const score = scores[type] ?? 0;
		if (score >= threshold) return { type, confidence: score, scores };
	}

	const distinct = new Set(values.map((v) => text(v).toLowerCase())).size;
	if (distinct <= 12 && distinct / values.length <= 0.5) return { type: 'enum', confidence: 1, scores };
	return { type: 'text', confidence: 1, scores };
}
