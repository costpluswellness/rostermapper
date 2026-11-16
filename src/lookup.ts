// Fetch NPPES and Census answers. Used by the UI's local server (browsers can't call these sources:
// no CORS) and by the CLI with --no-ui. Only an NPI or an address line is sent; answers are cached for
// as long as the process runs.
import { streetOnly, type CensusMatch, type NppesRecord } from './validate';

const NPPES = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=';
const NPPES_SEARCH = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-1&limit=10';
// The current address ranges first, then the 2020 census's, which still has some the current ones lost.
const CENSUS = ['Public_AR_Current', 'Public_AR_Census2020'].map((b) => `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=${b}&format=json&address=`);
const cache = new Map<string, Promise<unknown>>();

/** NPPES's record for a 10-digit NPI, or null when it has none. Throws when NPPES doesn't answer. */
export const lookupNpi = (npi: string): Promise<NppesRecord | null> =>
	cached(`nppes:${npi}`, async () => ((await getJson(NPPES + npi)) as { results?: NppesRecord[] }).results?.[0] ?? null);

/** Active individual NPIs under a first and last name, in a state (then anywhere, when none there). Throws when NPPES doesn't answer. */
export const searchNpiByName = ({ first, last, state }: { first: string; last: string; state?: string }): Promise<NppesRecord[]> =>
	cached(`nppes-name:${[first, last, state ?? ''].join('|').toLowerCase()}`, async () => {
		const search = async (st?: string) => {
			const query = new URLSearchParams({ first_name: first, last_name: last, ...(st && { state: st }) });
			return ((await getJson(`${NPPES_SEARCH}&${query}`)) as { results?: NppesRecord[] }).results ?? [];
		};
		const found = state ? await search(state) : [];
		return found.length ? found : search();
	});

/**
 * The Census geocoder's best match for a one-line address ("street, city, ST zip"), or null when it
 * finds none. Tries the street alone (no suite, no building name before the house number), then the
 * 2020 address ranges. Throws when it doesn't answer.
 */
export const lookupAddress = (address: string): Promise<CensusMatch | null> =>
	cached(`census:${address.toLowerCase()}`, async () => {
		const [line1 = '', ...rest] = address.split(',');
		const street = [streetOnly(line1), ...rest].join(',');
		for (const base of CENSUS) {
			for (const line of new Set([address, street])) {
				const match = ((await getJson(base + encodeURIComponent(line))) as { result?: { addressMatches?: CensusMatch[] } }).result?.addressMatches?.[0];
				if (match) return match;
			}
		}
		return null;
	});

async function cached<T>(key: string, fetchOne: () => Promise<T>): Promise<T> {
	if (!cache.has(key)) cache.set(key, fetchOne());
	try {
		return (await cache.get(key)) as T;
	} catch (e) {
		cache.delete(key); // let a later run retry
		throw e;
	}
}

// NPPES answers 403 or 429 when asked too fast, and both sources have the odd 5xx: wait and retry,
// 1, 2, then 4 seconds, before giving up.
const RETRY = new Set([403, 429, 500, 502, 503, 504]);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function getJson(url: string): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
		if (res.ok) return res.json();
		if (attempt >= 3 || !RETRY.has(res.status)) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
		await wait(1000 * 2 ** attempt);
	}
}
