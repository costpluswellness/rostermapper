// Draws a random sample of real NPIs from NPPES for the demo rosters (demo/rosters/).
//   node scripts/sample-npis.ts [individuals=60] [organizations=14]
// NPIs are assigned at random across their number space, so this makes up random 10-digit numbers
// that pass the check digit and keeps the ones NPPES has, active: a uniform random sample with no
// search criteria to bias it. About one guess in twelve is a real NPI. Writes demo/rosters/npis.json
// with only the fields the rosters use; scripts/build-demo-rosters.ts turns that into the files.
import { writeFileSync } from 'node:fs';

const [wantInd = 60, wantOrg = 14] = process.argv.slice(2).map(Number);
const API = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=';

/** Luhn over 80840 + the first nine digits (the NPI check digit). */
function checkDigit(nine: string): string {
	let sum = 24; // 80840's contribution
	for (let i = 0; i < 9; i++) {
		let d = Number(nine[8 - i]);
		if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
		sum += d;
	}
	return String((10 - (sum % 10)) % 10);
}
const randomNpi = () => { const nine = '1' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'); return nine + checkDigit(nine); };

type Address = { address_purpose: string; address_1: string; address_2?: string; city: string; state: string; postal_code: string; telephone_number?: string; country_code: string };
type Rec = {
	number: string; enumeration_type: 'NPI-1' | 'NPI-2';
	basic: { status?: string; first_name?: string; last_name?: string; middle_name?: string; credential?: string; sex?: string; gender?: string; organization_name?: string };
	addresses: Address[]; taxonomies: { code: string; desc: string; primary: boolean; state?: string; license?: string }[];
};

async function lookup(npi: string): Promise<Rec | null> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(API + npi, { signal: AbortSignal.timeout(15000) }).catch(() => null);
		if (res?.ok) return ((await res.json()) as { results?: Rec[] }).results?.[0] ?? null;
		if (attempt >= 3) return null;
		await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
	}
}

const loc = (r: Rec) => r.addresses.find((a) => a.address_purpose === 'LOCATION');
const keep = (r: Rec) => {
	const a = loc(r);
	const t = r.taxonomies.find((x) => x.primary) ?? r.taxonomies[0];
	return {
		npi: r.number,
		type: r.enumeration_type === 'NPI-1' ? 'individual' : 'organization',
		...(r.enumeration_type === 'NPI-1'
			? { first: r.basic.first_name, middle: r.basic.middle_name, last: r.basic.last_name, credential: r.basic.credential, sex: r.basic.sex ?? r.basic.gender }
			: { name: r.basic.organization_name }),
		taxonomy: t?.code, taxonomyName: t?.desc, licenseState: t?.state, license: t?.license,
		address: a && { line1: a.address_1, line2: a.address_2 || undefined, city: a.city, state: a.state, zip: a.postal_code, phone: a.telephone_number },
	};
};

const found = { individual: [] as ReturnType<typeof keep>[], organization: [] as ReturnType<typeof keep>[] };
const want = { individual: wantInd, organization: wantOrg };
const seen = new Set<string>();
let asked = 0;
async function worker() {
	while (found.individual.length < want.individual || found.organization.length < want.organization) {
		const npi = randomNpi();
		if (seen.has(npi)) continue;
		seen.add(npi);
		asked++;
		const r = await lookup(npi);
		// Active (NPPES lists deactivated ones without a status) with a US practice location.
		if (!r || r.basic.status !== 'A' || loc(r)?.country_code !== 'US') continue;
		const k = keep(r);
		const list = found[k.type as 'individual' | 'organization'];
		if (list.length < want[k.type as 'individual' | 'organization']) list.push(k);
		process.stderr.write(`\r${asked} asked · ${found.individual.length}/${want.individual} individuals · ${found.organization.length}/${want.organization} organizations`);
	}
}
await Promise.all(Array.from({ length: 6 }, worker));
process.stderr.write('\n');
const out = new URL('../demo/rosters/npis.json', import.meta.url);
writeFileSync(out, JSON.stringify({ drawn: new Date().toISOString().slice(0, 10), asked, ...found }, null, '\t') + '\n');
console.log(`Wrote ${out.pathname}`);
