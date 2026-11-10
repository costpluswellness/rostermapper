// Map: match each column to schema fields by header aliases and rules.
//
// Header rules, in order:
//   1. words        normalized header → abbreviations → drop stopwords → word set
//   2. alias match  exact set = 1.0 · exact but for neutral words ("Location City") = 0.95
//                   tiebreaks: same words in the same order +0.05 ("Provider Type" is provider_type,
//                   "Type of Provider" is degree), then the field's own name +0.02 ("Degree" over "Title")
//                   alias ⊂ header = 0.5 + 0.4 × coverage (neutral words don't count)
//                   retried against the header minus slot words ("Secondary Taxonomy"): −0.05
//   3. reject if    the extra words include a qualifier ("billing", "supervising", …)
//                   the header names a slot the field doesn't hold ("Taxonomy 2" ≠ taxonomy_1)
//                   the header equals a `not` alias, word for word in order
// Value rules (column type vs field values):
//   match +0.1 · strong column type mismatch −0.4 · strong field type, weak column −0.3 · weak/weak −0.15
//   Values never veto: degrees look like state codes, 9-digit ZIPs look like TINs.
// Columns with no header match but a distinctive value type get 0.3 "values only" candidates.

import type { ValueType } from '../profile/value-type';
import type { Assignment, Candidate, ColumnMatch, ColumnProfile, MatchResult, MatchStatus, Rejection, Schema, SheetProfile } from '../types';
import { normalizeHeader } from '../profile/normalize';
import { compile, type CompiledField, type Entry, type Matcher, type Words } from './compile';

/** Highest score a `related` header gets: a candidate worth offering, below what maps a column on its own. */
export const RELATED_MAX = 0.6;

/** Score cutoffs for a column's best candidate. */
export const THRESHOLDS = { mapped: 0.85, weak: 0.5 } as const;

// Types specific enough that a mismatch is strong evidence against a field.
const STRONG = new Set<ValueType>(['npi', 'tin', 'ssn', 'taxonomy', 'date', 'phone', 'zip', 'state', 'gender', 'email', 'url', 'dea']);
// Types specific enough to propose a field from values alone.
const VALUE_ONLY = new Set<ValueType>(['npi', 'tin', 'taxonomy', 'dea', 'phone', 'zip', 'state', 'gender', 'url']);

/**
 * Rank candidate fields for every column, then pick one column per field.
 * `overrides` (header → field id, or "ignore") replace matching for the columns they name and
 * win every field they claim. Headers are compared after normalizing, so case and spacing don't matter.
 * Fields in `unmapped` get no column from matching (an override can still give them one).
 */
export function match(profile: SheetProfile, schema: Schema, overrides: Readonly<Record<string, string>> = {}, unmapped: ReadonlySet<string> = new Set()): MatchResult {
	const matcher = compiled(schema);
	const forced = new Map(Object.entries(overrides).map(([header, field]) => [normalizeHeader(header).norm, field]));
	const columns = profile.columns.map((column) => {
		const field = forced.get(column.norm);
		return field ? overridden(column, field) : matchColumn(column, matcher);
	});
	return { columns, mapping: assign(columns, unmapped) };
}

function overridden(column: ColumnProfile, field: string): ColumnMatch {
	const why = ['mapping file'];
	return {
		index: column.index,
		tokens: [],
		status: field === 'ignore' ? 'ignored' : 'mapped',
		candidates: [{ field, score: 1, raw: 2, why, override: true }],
		rejected: [],
	};
}

// Compiling normalizes every alias, so do it once per schema, not once per sheet.
const cache = new WeakMap<Schema, Matcher>();

function compiled(schema: Schema): Matcher {
	let matcher = cache.get(schema);
	if (!matcher) cache.set(schema, (matcher = compile(schema)));
	return matcher;
}

function matchColumn(column: ColumnProfile, m: Matcher): ColumnMatch {
	const header = m.words(column.norm);
	const candidates: Candidate[] = [];
	const rejected: Rejection[] = [];

	if (header.full.size) {
		for (const field of m.fields) {
			const result = scoreField(header, field, column, m);
			if (!result) continue;
			if ('reject' in result) rejected.push({ field: field.id, why: result.reject });
			else candidates.push(result);
		}

		// Ignore is categorical: containing an ignore term is enough, unless a field matches exactly.
		const ignore = bestEntry(header, m.ignore, m.neutral);
		if (ignore) candidates.push({ field: 'ignore', score: ignore.exact ? 0.98 : 0.88, why: [`ignore "${ignore.entry.text}"`] });
	}

	if (!candidates.some((c) => c.score >= THRESHOLDS.weak)) candidates.push(...valueOnly(column, m.fields));

	candidates.sort((a, b) => (b.raw ?? b.score) - (a.raw ?? a.score));
	return { index: column.index, tokens: [...header.full], status: statusOf(candidates[0]), candidates, rejected };
}

function scoreField(header: Words, field: CompiledField, column: ColumnProfile, m: Matcher): Candidate | { reject: string } | null {
	const hit = bestEntry(header, field.entries, m.neutral);
	if (!hit) return null;

	const qualifiers = hit.extra.filter((w) => m.qualifiers.has(w));
	if (qualifiers.length) return { reject: `qualifier "${qualifiers.join(', ')}"` };
	if (field.not.some((n) => n.seq === header.seq)) return { reject: 'listed under not' };

	const digitSlots = hit.extra.filter((w) => /^\d$/.test(w)).map(Number);
	const slots = new Set(digitSlots.length ? digitSlots : hit.extra.map(m.slotOf).filter((s) => s != null));
	if (slots.size && !slots.has(field.slot)) return { reject: `slot ${[...slots].join(',')} ≠ ${field.slot}` };

	const why = [`${hit.exact ? 'exact' : 'contains'} ${hit.entry.kind} "${hit.entry.text}"`];
	if (hit.entry.kind === 'inverted') why.push('inverted (Y = hide)');

	const adjust = typeAdjust(column.type, field.types);
	if (adjust) why.push(`${adjust > 0 ? '+' : ''}${adjust} values ${column.type}${adjust < 0 ? `, expects ${field.types[0]}` : ''}`);

	const order = hit.exact && hit.entry.seq === header.seq && hit.entry.kind !== 'related' ? 0.05 : 0;
	const name = hit.exact && hit.entry.kind === 'name' ? 0.02 : 0;
	let raw = hit.score + adjust + order + name;
	if (hit.entry.kind === 'related') raw = Math.min(raw, RELATED_MAX); // a maybe, even with matching values
	return { field: field.id, score: clamp(raw), raw, why, ...(hit.entry.kind === 'inverted' && { inverted: true as const }) };
}

interface EntryHit {
	score: number;
	entry: Entry;
	exact: boolean;
	/** Header words the entry doesn't account for. */
	extra: string[];
}

// Best-scoring entry whose words all appear in the header.
function bestEntry(header: Words, entries: readonly Entry[], neutral: Set<string>): EntryHit | null {
	let best: EntryHit | null = null;
	for (const entry of entries) {
		if (!entry.full.size) continue;
		for (const [words, penalty] of [[header.full, 0], [header.core, -0.05]] as const) {
			if (!isSubset(entry.full, words)) continue;
			const rest = minus(words, entry.full).filter((w) => !neutral.has(w));
			const exact = rest.length === 0;
			const base = exact
				? words.size === entry.full.size ? 1 : 0.95
				: 0.5 + 0.4 * (entry.full.size / (entry.full.size + rest.length));
			// A related header is only a maybe: it never scores above RELATED_MAX.
			const score = entry.kind === 'related' ? Math.min(base + penalty, RELATED_MAX) : base + penalty;
			if (!best || score > best.score) best = { score, entry, exact, extra: minus(header.full, entry.full) };
		}
	}
	return best;
}

// Columns the header didn't explain: propose fields from a distinctive value type.
function valueOnly(column: ColumnProfile, fields: readonly CompiledField[]): Candidate[] {
	if (!VALUE_ONLY.has(column.type) || column.confidence < 0.9) return [];
	return fields
		.filter((f) => f.slot === 1 && f.types[0] === column.type)
		.map((f) => ({ field: f.id, score: 0.3, why: [`values only: ${column.type}`] }));
}

function typeAdjust(columnType: ValueType, fieldTypes: readonly ValueType[]): number {
	if (columnType === 'empty' || !fieldTypes.length) return 0;
	if (fieldTypes.includes(columnType)) return 0.1;
	if (STRONG.has(columnType)) return -0.4;
	return STRONG.has(fieldTypes[0]!) ? -0.3 : -0.15;
}

function statusOf(top: Candidate | undefined): MatchStatus {
	if (!top) return 'unmapped';
	if (top.field === 'ignore') return 'ignored';
	if (top.score >= THRESHOLDS.mapped) return 'mapped';
	return top.score >= THRESHOLDS.weak ? 'weak' : 'unmapped';
}

// Greedy: highest-scoring (column, field) pairs first, each column and field used once.
// A weak match is only used if it is the column's best field, never as a fallback after
// the column lost its best field to another column ("Primary Location City" → is_primary_location).
function assign(columns: readonly ColumnMatch[], unmapped: ReadonlySet<string>): Record<string, Assignment> {
	const pairs = columns.flatMap((c) => {
		const fields = c.candidates.filter((k) => k.field !== 'ignore' && (k.override || !unmapped.has(k.field)));
		return fields
			.filter((k, i) => k.score >= THRESHOLDS.mapped || (i === 0 && k.score >= THRESHOLDS.weak))
			.map((k) => ({ ...k, column: c.index }));
	});
	pairs.sort((a, b) => (b.raw ?? b.score) - (a.raw ?? a.score));

	const mapping: Record<string, Assignment> = {};
	const used = new Set<number>();
	for (const pair of pairs) {
		if (mapping[pair.field] || used.has(pair.column)) continue;
		mapping[pair.field] = pair;
		used.add(pair.column);
	}
	return mapping;
}

const clamp = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((w) => !b.has(w));
