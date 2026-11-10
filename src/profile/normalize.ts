export interface NormalizedHeader {
	norm: string;
	hints: string[];
}

// "Rendering Provider N.P.I." → "rendering provider npi"
// "PROV_FIRST_NM"             → "prov first nm"
// "Billing-Provider-NPI"      → "billing provider npi"
// Parentheticals are pulled out as hints: "provider_type (SPEC/PCP/ANCL/other)".
export function normalizeHeader(raw: unknown): NormalizedHeader {
	const hints: string[] = [];
	const norm = (raw == null ? '' : String(raw).trim())
		.replace(/\(([^)]*)\)/g, (_, hint: string) => {
			if (hint.trim()) hints.push(hint.trim());
			return ' ';
		})
		.replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, '')) // N.P.I. → NPI
		.replace(/([a-z])([A-Z])/g, '$1 $2') // TaxId → Tax Id
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // NPIType → NPI Type
		.replace(/([A-Za-z])(\d)/g, '$1 $2') // Taxonomy1 → Taxonomy 1
		.replace(/(\d)([A-Za-z])/g, '$1 $2') // 1Code → 1 Code
		.replace(/&/g, ' and ')
		.replace(/[^A-Za-z0-9]+/g, ' ')
		.trim()
		.toLowerCase();
	return { norm, hints };
}
