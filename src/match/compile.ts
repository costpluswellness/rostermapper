import { fieldList } from '../fields';
import { normalizeHeader } from '../profile/normalize';
import type { ValueType } from '../profile/value-type';
import type { Schema } from '../types';

/** A header reduced to words. `core` drops slot words ("secondary", "2"). */
export interface Words {
	full: Set<string>;
	/** The same words in header order: "type of provider" → "type provider", unlike "provider type". */
	seq: string;
	core: Set<string>;
}

export type EntryKind = 'name' | 'alias' | 'inverted' | 'related';

export interface Entry extends Words {
	text: string;
	kind: EntryKind;
}

export interface CompiledField {
	id: string;
	/** Accepted value types, most likely first. */
	types: readonly ValueType[];
	/** 2 for `taxonomy_2`, otherwise 1. */
	slot: number;
	entries: Entry[];
	not: Words[];
}

export interface Matcher {
	words: (norm: string) => Words;
	slotOf: (word: string) => number | undefined;
	qualifiers: Set<string>;
	neutral: Set<string>;
	fields: CompiledField[];
	ignore: Entry[];
}

const norm = (text: string) => normalizeHeader(text).norm;

/** Turn a schema into the lookup structures the matcher needs. Normalizes every alias once. */
export function compile(schema: Schema): Matcher {
	const { vocab } = schema;
	// Longest first, so "date of birth" rewrites before "date".
	const phrases = Object.entries(vocab.abbreviations)
		.map(([from, to]) => [norm(from), norm(to)] as const)
		.filter(([from, to]) => from && from !== to)
		.sort((a, b) => b[0].length - a[0].length);
	const stopwords = new Set(vocab.stopwords);

	function slotOf(word: string): number | undefined {
		if (/^[1-4]$/.test(word)) return Number(word);
		return Object.hasOwn(vocab.slots, word) ? vocab.slots[word] : undefined;
	}

	function words(normalized: string): Words {
		let s = ` ${normalized} `;
		for (const [from, to] of phrases) s = s.split(` ${from} `).join(` ${to} `);
		const seq = s.trim().split(/\s+/).filter((w) => w && !stopwords.has(w));
		const full = new Set(seq);
		const core = new Set([...full].filter((w) => slotOf(w) == null));
		return { full, core, seq: seq.join(' ') };
	}

	const entry = (text: string, kind: EntryKind): Entry => ({ text: norm(text), kind, ...words(norm(text)) });

	const specs = fieldList(schema).filter(({ spec }) => !spec.input); // typed on Upload, never a column's

	// Each field's own name is an implicit alias ("provider.gender" → "gender"). Names shared
	// by two fields get their group prefix ("practice.city" → "practice city").
	const nameCount = new Map<string, number>();
	for (const { name } of specs) nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
	const ownName = (id: string, name: string) => (nameCount.get(name)! > 1 ? id : name).replace(/[._]/g, ' ');

	const fields = specs.map(({ id, name, spec }): CompiledField => ({
		id,
		types: spec.values ?? [],
		slot: Number(id.match(/_(\d)$/)?.[1] ?? 1),
		entries: [
			entry(ownName(id, name), 'name'),
			...spec.aliases.map((a) => entry(a, 'alias')),
			...(spec.inverted ?? []).map((a) => entry(a, 'inverted')),
			...(spec.related ?? []).map((a) => entry(a, 'related')),
		],
		not: (spec.not ?? []).map((a) => words(norm(a))),
	}));

	return {
		words,
		slotOf,
		qualifiers: new Set(vocab.qualifiers),
		neutral: new Set(vocab.neutral),
		fields,
		ignore: vocab.ignore.map((a) => entry(a, 'alias')),
	};
}
