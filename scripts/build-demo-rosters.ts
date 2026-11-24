// Builds the demo rosters in demo/rosters/ from the NPPES sample in demo/rosters/npis.json
// (scripts/sample-npis.ts draws it).
//   node scripts/build-demo-rosters.ts
// Each file is a different sender's style, so the demo shows header detection, mapping, cleanup and
// checks on shapes real rosters come in. NPIs, names, credentials, taxonomies and practice addresses
// are NPPES's. Which provider sits under which group is random, and every tax ID is a placeholder
// (99-99xxxxx). Seeded, so a rebuild gives the same files.
import { readFileSync, writeFileSync } from 'node:fs';
import xlsx from 'xlsx';

type Address = { line1: string; line2?: string; city: string; state: string; zip: string; phone?: string };
type Person = { npi: string; first: string; middle?: string; last: string; credential?: string; sex?: string; taxonomy?: string; taxonomyName?: string; licenseState?: string | null; license?: string | null; address: Address };
type Org = { npi: string; name: string; taxonomy?: string; taxonomyName?: string; address: Address };

const dir = new URL('../demo/rosters/', import.meta.url);
const { individual: people, organization: orgs } = JSON.parse(readFileSync(new URL('npis.json', dir), 'utf8')) as { individual: Person[]; organization: Org[] };

// ─── Helpers ────────────────────────────────────────────────
let seed = 20261124;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const chance = (p: number) => rand() < p;

const tin = (org: Org) => `99-99${String(orgs.indexOf(org) + 1).padStart(5, '0')}`; // placeholder
const title = (s = '') => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Pllc|Pc|Llc|Pa|Md|Do|Np|Ii|Iii|Iv)\b/g, (m) => m.toUpperCase());
const zip5 = (z: string) => z.slice(0, 5);
const zip9 = (z: string) => (z.length === 9 ? `${z.slice(0, 5)}-${z.slice(5)}` : z);
const phoneDigits = (p = '') => p.replace(/\D/g, '');
const phoneParen = (p = '') => { const d = phoneDigits(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };
const phoneDots = (p = '') => { const d = phoneDigits(p); return d.length === 10 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}` : p; };
const STATE_NAMES: Record<string, string> = { AL: 'Alabama', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', NC: 'North Carolina', NJ: 'New Jersey', NV: 'Nevada', NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', TX: 'Texas', UT: 'Utah', VA: 'Virginia', WA: 'Washington', WI: 'Wisconsin', WV: 'West Virginia' };
const date = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const usDate = (dt: Date) => `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}/${dt.getUTCFullYear()}`;
/** A typo: two digits swapped, so the check digit fails. */
const swapDigits = (npi: string) => npi.slice(0, 3) + npi[4] + npi[3] + npi.slice(5);

function writeCsv(name: string, rows: unknown[][]) {
	const csv = rows.map((r) => r.map((v) => { const s = v == null ? '' : v instanceof Date ? usDate(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n') + '\r\n';
	writeFileSync(new URL(name, dir), csv);
}
function writeBook(name: string, sheets: [string, unknown[][]][], bookType: 'xlsx' | 'biff8' = 'xlsx') {
	const wb = xlsx.utils.book_new();
	for (const [sheet, rows] of sheets) {
		// Dates as Excel day numbers, so the time zone this runs in can't shift them.
		const cells = rows.map((r) => r.map((v) => (v instanceof Date ? { t: 'n', v: (v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000, z: 'm/d/yyyy' } : v)));
		const ws = xlsx.utils.aoa_to_sheet(cells);
		ws['!cols'] = (rows.find((r) => r.length > 3) ?? []).map(() => ({ wch: 16 }));
		xlsx.utils.book_append_sheet(wb, ws, sheet);
	}
	// Fixed timestamps, so a rebuild gives the same bytes.
	wb.Props = { Title: name, Author: 'Roster Mapper demo', CreatedDate: date(2026, 11, 24) };
	writeFileSync(new URL(name, dir), xlsx.write(wb, { type: 'buffer', bookType, compression: true }));
}

const slice = (() => { let at = 0; return (n: number) => people.slice(at, (at += n)); })();
const manifest: { file: string; title: string; format: string; rows: number; blurb: string; shows: string[] }[] = [];

// ─── 1. A tidy workbook: title rows, an Adds and a Terms sheet, a notes tab ─────
{
	const groups = orgs.slice(0, 3);
	const header = ['Provider First Name', 'Middle Initial', 'Provider Last Name', 'Degree', 'Individual NPI', 'Gender', 'Taxonomy Code', 'License State', 'License Number', 'Group NPI', 'Tax ID', 'Group Legal Name', 'Practice Address', 'Suite', 'City', 'State', 'Zip', 'Phone', 'Effective Date'];
	const row = (p: Person, g: Org, eff: Date, opts: { noTaxonomy?: boolean; noLegal?: boolean; at?: Address } = {}) => {
		const a = opts.at ?? p.address;
		return [title(p.first), p.middle?.[0] ?? '', title(p.last), p.credential ?? '', p.npi, p.sex ?? '', opts.noTaxonomy ? '' : p.taxonomy, p.licenseState ?? '', p.license ?? '',
			g.npi, tin(g), opts.noLegal ? '' : g.name, title(a.line1), title(a.line2 ?? ''), title(a.city), a.state, Number(zip5(a.zip)), phoneParen(a.phone), eff];
	};
	const adds = slice(14).map((p, i) => row(p, groups[i % 3]!, date(2027, 1, 1), { noTaxonomy: i === 4 || i === 9, noLegal: i === 6 }));
	// Two providers also see patients at their group's own office.
	adds.splice(3, 0, row(people[1]!, groups[1]!, date(2027, 1, 1), { at: groups[1]!.address }));
	adds.splice(8, 0, row(people[5]!, groups[2]!, date(2027, 1, 1), { at: groups[2]!.address }));
	const terms = slice(4).map((p, i) => row(p, groups[i % 3]!, date(2026, 12, 31)));
	const top = (what: string) => [['Provider roster: ' + what], ['Prepared for the network, November 2026'], []];
	writeBook('tidy-workbook.xlsx', [
		['Adds', [...top('additions'), header, ...adds]],
		['Terms', [...top('terminations'), header, ...terms]],
		['Read Me', [['About this roster'], [], ['Adds: providers joining on January 1, 2027.'], ['Terms: providers leaving on December 31, 2026.'], ['Questions: reply to the sender.']]],
	]);
	manifest.push({ file: 'tidy-workbook.xlsx', title: 'Tidy workbook', format: 'xlsx', rows: adds.length + terms.length,
		blurb: 'Title rows above the header, Adds and Terms tabs, ZIPs that lost their leading zero.',
		shows: ['Title rows above the header', 'An Adds and a Terms sheet; the action comes from the sheet name', 'A Read Me tab at the end to ignore', 'ZIPs stored as numbers, so New England loses its leading zero', 'Blank taxonomies and a blank legal name, filled from NPPES'] });
}

// ─── 2. A hand-edited CSV: an action column and every kind of mess ─────
{
	const groups = orgs.slice(3, 6);
	const list = slice(14);
	const header = ['Action', 'First Name', 'Last Name', 'Credentials', 'NPI', 'Sex', 'Specialty', 'Group Name', 'Group NPI', 'TIN', 'Address', 'Address 2', 'City', 'State', 'Zip Code', 'Phone', 'Fax', 'Effective Date', 'Accepting New Patients'];
	const actions = ['Add', 'add', 'ADD', 'New', 'Update', 'Change', 'Term', 'Terminate'];
	const effs = [usDate(date(2027, 1, 1)), '2027-01-01', 'Jan 1, 2027', '01/01/27', '1-15-2027'];
	const rows = list.map((p, i) => {
		const g = groups[i % 3]!;
		const a = p.address;
		const npi = i === 5 ? swapDigits(p.npi) : i === 11 ? 'N/A' : p.npi;
		const state = chance(0.35) ? (STATE_NAMES[a.state] ?? a.state) : chance(0.5) ? a.state.toLowerCase() : a.state;
		const tinText = pick([tin(g), tin(g).replace('-', ''), tin(g).replace('-', ' ')]);
		const phone = pick([phoneParen, phoneDots, phoneDigits, (x?: string) => x ?? ''])(a.phone);
		const first = chance(0.3) ? p.first.toLowerCase() : chance(0.5) ? p.first : title(p.first);
		const cred = (p.credential ?? '').replace(/^MD$/, 'M.D.').replace(/^DO$/, 'D.O.');
		return [pick(actions), first + (chance(0.15) ? ' ' : ''), title(p.last), cred, npi, p.sex === 'F' ? pick(['F', 'Female', 'f']) : pick(['M', 'Male', 'm']),
			p.taxonomyName ?? '', title(g.name), g.npi, tinText, a.line1, a.line2 ?? '', title(a.city), state, chance(0.5) ? zip9(a.zip) : zip5(a.zip), phone, '', pick(effs), pick(['Y', 'Yes', 'N', ''])];
	});
	rows.splice(7, 0, [...rows[2]!]); // the same provider twice
	writeCsv('hand-edited.csv', [header, ...rows]);
	manifest.push({ file: 'hand-edited.csv', title: 'Hand-edited CSV', format: 'csv', rows: rows.length,
		blurb: 'Every kind of mess: actions, dates, phones and states written any which way, an NPI typo, a duplicate.',
		shows: ['An Action column spelled five ways', 'Dates in five formats, phones in four', 'States spelled out or lower case, ZIP+4', 'An NPI typo that fails its check digit, and one written N/A', 'A duplicate row'] });
}

// ─── 3. A database extract: SCREAMING_SNAKE headers, terminations named in the file ─────
{
	const groups = orgs.slice(6, 8);
	const header = ['PROV_NPI', 'PROV_FIRST_NM', 'PROV_MID_NM', 'PROV_LAST_NM', 'PROV_DEGREE_CD', 'PROV_SEX_CD', 'PRIM_TAXONOMY_CD', 'GRP_NPI', 'GRP_TAX_ID', 'GRP_LEGAL_NM', 'SVC_ADDR_LN_1', 'SVC_ADDR_LN_2', 'SVC_CITY_NM', 'SVC_ST_CD', 'SVC_ZIP_CD', 'SVC_PHONE_NBR', 'TERM_EFF_DATE', 'TERM_RSN_DESC'];
	const reasons = ['LEFT PRACTICE', 'RETIRED', 'RELOCATED', 'CONTRACT ENDED'];
	const rows = slice(10).map((p, i) => {
		const g = groups[i % 2]!;
		const a = p.address;
		return [p.npi, p.first, p.middle ?? '', p.last, (p.credential ?? '').replace(/[.\s]/g, ''), p.sex ?? '', p.taxonomy ?? '', g.npi, tin(g).replace('-', ''), g.name,
			a.line1, a.line2 ?? '', a.city, a.state, a.zip, phoneDigits(a.phone), `2026${['1130', '1231', '1215'][i % 3]}`, pick(reasons)];
	});
	writeCsv('DIRECTORY_EXTRACT_TERMS_20261130.csv', [header, ...rows]);
	manifest.push({ file: 'DIRECTORY_EXTRACT_TERMS_20261130.csv', title: 'Database extract', format: 'csv', rows: rows.length,
		blurb: 'Database column names, YYYYMMDD dates, and no action column: TERM comes from the file name.',
		shows: ['SCREAMING_SNAKE headers (PROV_FIRST_NM, SVC_ST_CD)', 'No action column: TERM comes from the file name', 'Dates as YYYYMMDD, 9-digit ZIPs, tax IDs without a dash', 'A term reason kept as a note'] });
}

// ─── 4. Providers at several locations: one row per provider per location ─────
{
	const sites = orgs.slice(8, 11);
	const header = ['NPI', 'Last Name', 'First Name', 'Title', 'Primary Taxonomy', 'Location Name', 'Location Address', 'Location Address 2', 'Location City', 'Location State', 'Location Zip', 'Location Phone', 'Primary Location', 'Show in Directory', 'PCP Y/N', 'Billing NPI', 'Tax ID', 'Pay To Name', 'Effective Date'];
	const rows: unknown[][] = [];
	const list = slice(10);
	list.forEach((p, i) => {
		const g = sites[i % 3]!;
		const at = [{ name: title(p.address.city) + ' office', a: p.address }, ...(i % 3 !== 2 ? [{ name: title(g.name).replace(/,? (PLLC|PC|LLC|PA|INC\.?)$/i, ''), a: g.address }] : [])];
		if (i === 0) at.push({ name: title(sites[1]!.name), a: sites[1]!.address });
		at.forEach((l, j) => rows.push([p.npi, title(p.last), title(p.first), p.credential ?? '', p.taxonomy ?? '', l.name, title(l.a.line1), title(l.a.line2 ?? ''), title(l.a.city), l.a.state, zip5(l.a.zip),
			phoneParen(l.a.phone), j === 0 ? 'Y' : 'N', 'Y', /^207Q|^207R0|^208D|^363L/.test(p.taxonomy ?? '') ? 'Y' : 'N', g.npi, tin(g), g.name, date(2027, 2, 1)]));
	});
	writeBook('multi-location.xlsx', [['Provider Locations', [header, ...rows]]]);
	manifest.push({ file: 'multi-location.xlsx', title: 'Several locations each', format: 'xlsx', rows: rows.length,
		blurb: 'One row per provider per location, with Y/N flags for primary location, directory and PCP.',
		shows: ['One row per provider per location', 'Primary location, directory and PCP flags as Y/N', 'The Review graph: providers, locations and billing, and how they connect'] });
}

// ─── 5. Facilities in a legacy .xls ─────
{
	const list = orgs.slice(11, 14).concat(orgs.slice(0, 5));
	const header = ['Facility Name', 'Organization NPI', 'Federal Tax ID', 'Taxonomy', 'Facility Type', 'Street Address', 'Address Line 2', 'City', 'State', 'ZIP', 'Phone Number', 'Effective Date'];
	const rows = list.map((o, i) => [o.name, o.npi, tin(o), o.taxonomy ?? '', o.taxonomyName ?? '', o.address.line1, o.address.line2 ?? '', o.address.city, o.address.state, zip5(o.address.zip), phoneDots(o.address.phone), date(2027, 1, 1 + i)]);
	writeBook('facilities.xls', [['Facilities', [header, ...rows]]], 'biff8');
	manifest.push({ file: 'facilities.xls', title: 'Facilities (legacy .xls)', format: 'xls', rows: rows.length,
		blurb: 'Organizations in an Excel 97-2003 file.',
		shows: ['An Excel 97-2003 file', 'Organizations, not individuals: the category is detected as facility', 'Organization NPIs checked against NPPES'] });
}

// ─── 6. Wide: several locations across one row ─────
{
	const groups = orgs.slice(11, 13);
	const list = slice(8);
	const header = ['Provider Name', 'NPI', 'Degree', 'Specialty', 'Group NPI', 'Tax ID', 'Location 1 Address', 'Location 1 City', 'Location 1 State', 'Location 1 Zip', 'Location 2 Address', 'Location 2 City', 'Location 2 State', 'Location 2 Zip', 'Effective Date'];
	const rows = list.map((p, i) => {
		const g = groups[i % 2]!;
		const two = i % 2 === 0 ? [title(g.address.line1), title(g.address.city), g.address.state, zip5(g.address.zip)] : ['', '', '', ''];
		return [`${title(p.last)}, ${title(p.first)}`, p.npi, p.credential ?? '', p.taxonomyName ?? '', g.npi, tin(g), title(p.address.line1), title(p.address.city), p.address.state, zip5(p.address.zip), ...two, date(2027, 1, 1)];
	});
	writeBook('wide-locations.xlsx', [['Roster', [header, ...rows]]]);
	manifest.push({ file: 'wide-locations.xlsx', title: 'Wide: locations across a row', format: 'xlsx', rows: rows.length,
		blurb: 'Two locations on one row, and names as "Last, First": flagged for a transform.',
		shows: ['Two practice addresses on one row: flagged as needing a transform (not built yet)', 'Names as "Last, First" in one column'] });
}

writeFileSync(new URL('manifest.json', dir), JSON.stringify(manifest, null, '\t') + '\n');
console.log(manifest.map((m) => `${m.file}: ${m.rows} rows`).join('\n'));
