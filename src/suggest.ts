// Suggestions for the Map step: columns no field took that probably belong to a field nothing
// mapped. They come from the matcher's own candidates, for fields that are still free:
//   · for a required or preferred field, any of the column's candidates
//   · for an optional field, only the column's best candidate; a weaker one usually means the
//     header is about a field another column holds ("Directory Verbiage Primary Specialty")
// and the candidate must be
//   · a header match scoring at least SUGGEST_MIN ("Prov Lic" → license_number), or
//   · a values-only guess when the values are distinctive (NPIs, TINs, taxonomies, DEAs, emails, URLs).
// Values-only guesses for states, ZIPs and phones are left out: every address block has them.
// Each column and each field appears in at most one suggestion, best score first.
import type { Assignment, ColumnMatch, ColumnProfile } from './types';

export const SUGGEST_MIN = 0.35;
const DISTINCT_VALUES = new Set(['npi', 'tin', 'taxonomy', 'dea', 'email', 'url']);

export interface Suggestion {
	field: string;
	column: number;
	score: number;
	why: string[];
}

/** `wanted`: the required and preferred fields for the sheet's actions. */
export function suggest(
	columns: readonly (ColumnProfile & Pick<ColumnMatch, 'status' | 'candidates'>)[],
	mapping: Readonly<Record<string, Assignment>>,
	wanted: ReadonlySet<string> = new Set(),
): Suggestion[] {
	const taken = new Set(Object.values(mapping).map((a) => a.column));
	const pairs = columns
		.filter((c) => !taken.has(c.index) && c.status !== 'ignored' && c.header.trim() && c.filled > 0)
		.flatMap((c) => {
			const fields = c.candidates.filter((k) => k.field !== 'ignore');
			return fields
				.filter((k, i) => !mapping[k.field] && (i === 0 || wanted.has(k.field)))
				.filter((k) => (k.why[0]?.startsWith('values only') ? DISTINCT_VALUES.has(c.type) : k.score >= SUGGEST_MIN))
				.map((k) => ({ field: k.field, column: c.index, score: k.score, why: k.why }));
		})
		.sort((a, b) => b.score - a.score);

	const fields = new Set<string>();
	const used = new Set<number>();
	return pairs.filter((p) => {
		if (fields.has(p.field) || used.has(p.column)) return false;
		fields.add(p.field);
		used.add(p.column);
		return true;
	});
}
