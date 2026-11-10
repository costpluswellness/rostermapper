import type { Cell } from './types';

// Cell values that mean "no data" in roster files.
const NULL_TOKENS = new Set(['', 'n/a', 'na', 'none', 'null', 'nil', '-', '--', 'tbd', 'pend', 'pending', 'unknown']);

export function isBlank(value: Cell): boolean {
	if (value == null) return true;
	if (value instanceof Date) return false;
	return NULL_TOKENS.has(String(value).trim().toLowerCase());
}

export function cellText(value: Cell): string {
	return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').trim();
}

// 0 → "A", 25 → "Z", 26 → "AA"
export function columnLetter(index: number): string {
	let letter = '';
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
		letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
	}
	return letter;
}
