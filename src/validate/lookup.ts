// Fetch NPPES and Census answers. Used by the UI's local server (browsers can't call these sources:
// no CORS) and by the CLI with --no-ui. Only an NPI, a provider's name or an address line is sent.
// Answers are kept in memory while the process runs and on disk between runs (see the disk cache
// below), so testing the same roster again doesn't ask NPPES again.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { streetOnly, type CensusMatch, type NppesRecord } from './rules';

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

/** Answers so far: from the disk cache, or asked of NPPES and Census. */
export const lookupStats = { saved: 0, asked: 0 };

async function cached<T>(key: string, fetchOne: () => Promise<T>): Promise<T> {
	if (!cache.has(key)) {
		const saved = fromDisk(key);
		lookupStats[saved ? 'saved' : 'asked']++;
		cache.set(key, saved ? Promise.resolve(saved.value) : fetchOne().then((value) => (toDisk(key, value), value)));
	}
	try {
		return (await cache.get(key)) as T;
	} catch (e) {
		cache.delete(key); // let a later run retry; failures are never saved
		throw e;
	}
}

// ─── Disk cache ─────────────────────────────────────────────
// One JSON file, ~/.cache/rostermapper/lookups.json (or $ROSTERMAPPER_CACHE_DIR), readable only by
// this user: it holds NPIs, provider names and practice addresses from rosters. NPPES answers are
// reused for 7 days, Census answers for 90. Delete the file to start over; --no-cache skips it.
const DAY = 86_400_000;
const MAX_AGE: Record<string, number> = { nppes: 7 * DAY, 'nppes-name': 7 * DAY, census: 90 * DAY };
type Entry = { at: number; value: unknown };
let disk: { path: string; entries: Record<string, Entry>; timer?: ReturnType<typeof setTimeout> } | null | undefined;

/** Turn the disk cache off (--no-cache) or back on. On by default. */
export function useDiskCache(on: boolean): void {
	disk = on ? undefined : null;
}

/** False after useDiskCache(false). */
export const diskCacheOn = (): boolean => disk !== null;

/** Where the disk cache lives. */
export const cacheFile = (): string =>
	join(process.env.ROSTERMAPPER_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'rostermapper'), 'lookups.json');

function openDisk() {
	if (disk !== undefined) return disk;
	const path = cacheFile();
	let entries: Record<string, Entry> = {};
	try {
		entries = JSON.parse(readFileSync(path, 'utf8'));
	} catch {} // none yet, or unreadable: start empty
	disk = { path, entries };
	process.once('exit', saveDisk);
	return disk;
}

function fromDisk(key: string): Entry | undefined {
	const entry = openDisk()?.entries[key];
	const maxAge = MAX_AGE[key.slice(0, key.indexOf(':'))] ?? 0;
	return entry && Date.now() - entry.at < maxAge ? entry : undefined;
}

function toDisk(key: string, value: unknown): void {
	const d = openDisk();
	if (!d) return;
	d.entries[key] = { at: Date.now(), value };
	d.timer ??= setTimeout(saveDisk, 2000);
	d.timer.unref?.();
}

function saveDisk(): void {
	if (!disk) return;
	clearTimeout(disk.timer);
	delete disk.timer;
	try {
		mkdirSync(join(disk.path, '..'), { recursive: true, mode: 0o700 });
		const tmp = `${disk.path}.${process.pid}`;
		writeFileSync(tmp, JSON.stringify(disk.entries), { mode: 0o600 });
		renameSync(tmp, disk.path);
		chmodSync(disk.path, 0o600);
	} catch {} // a cache that can't be written just means asking the source again
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
