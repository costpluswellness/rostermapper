// The data for the demo site's home page story: a few rows of a sample roster as sent and as Roster
// Mapper cleans them, and the network they describe. Runs the built library (dist/, so `pnpm build`
// first) without lookups: what shows is mapping and standardizing; the app adds the NPPES and Census
// checks.
import { readFileSync } from 'node:fs';
import xlsx from 'xlsx';

type Issue = { field: string; kind: string; message: string; drop?: boolean };
type Rec = { row: number; values: Record<string, string>; issues: Issue[] };
type Result = { sheet: string; headerRow: number; action: { action: string; why: string }; category: { category: string; why: string };
	mapping: Record<string, { column: number }>; records: Rec[]; transforms: { message: string }[] };

const text = (v: unknown) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

/** The file's sheets as the sender wrote them: CSV text untouched, Excel cells as Excel shows them. */
function asSent(bytes: Buffer, file: string): Map<string, string[][]> {
	const wb = /\.csv$/i.test(file) ? xlsx.read(bytes.toString('utf8'), { type: 'string', raw: true }) : xlsx.read(bytes, { type: 'buffer' });
	return new Map(wb.SheetNames.map((n) => [n, xlsx.utils.sheet_to_json<unknown[]>(wb.Sheets[n]!, { header: 1, raw: false, defval: '', blankrows: true }).map((r) => r.map(text))]));
}

// ─── The home page's story: a few messy rows → cleaned → providers, locations and billing ───
type Entity = { values: Record<string, string>; rows: number[] };
type Entities = { providers: Entity[]; locations: Entity[]; billing: Entity[]; providerLocations: [number, number][]; locationBilling: [number, number][] };
export type Story = {
	file: string;
	headers: string[];
	rows: { n: number; raw: string[]; clean: string[]; changed: number[]; drop?: string }[];
	graph: { providers: Node[]; locations: Node[]; billing: Node[]; links: [string, string][] };
};
type Node = { id: string; title: string; sub: string; rows: number[] };

const STORY_FIELDS = ['network.action_type', 'provider.first_name', 'provider.last_name', 'provider.npi', 'practice.city', 'practice.state', 'practice.phone', 'network.effective_date'];

/**
 * A handful of rows from one sample that tell the whole story: providers seen at two locations,
 * written differently each time, one under another group, and one row that can't move forward.
 */
export async function buildStory(root: URL, file: string): Promise<Story> {
	const lib = (await import(new URL('dist/index.js', root).href)) as { runSheets: (name: string, sheets: unknown[]) => Promise<Result[]>; groupEntities: (records: Rec[]) => Entities };
	const { readWorkbook } = (await import(new URL('dist/workbook.js', root).href)) as { readWorkbook: (b: Uint8Array) => unknown[] };
	const bytes = readFileSync(new URL(`demo/rosters/${file}`, root));
	const sent = asSent(bytes, file);
	const [r] = await lib.runSheets(file, readWorkbook(bytes));
	if (!r) throw new Error(`${file}: no sheet`);
	const raw = sent.get(r.sheet) ?? [];
	const cols = STORY_FIELDS.map((f) => r.mapping[f]?.column ?? -1);
	const forward = r.records.filter((x) => !x.issues.some((i) => i.drop));
	const all = lib.groupEntities(forward);

	// Providers at two or more locations (two at most), then one under a different billing entity.
	const pick = new Set<number>();
	const billingOf = (p: number) => new Set(all.providerLocations.filter(([pp]) => pp === p).flatMap(([, l]) => all.locationBilling.filter(([ll]) => ll === l).map(([, b]) => b)));
	const multi = all.providers.map((_, p) => p).filter((p) => all.providerLocations.filter(([pp]) => pp === p).length > 1).slice(0, 2);
	for (const p of multi) all.providers[p]!.rows.forEach((n) => pick.add(n));
	const theirs = new Set(multi.flatMap((p) => [...billingOf(p)]));
	const other = all.providers.findIndex((_, p) => ![...billingOf(p)].some((b) => theirs.has(b)));
	if (other >= 0) pick.add(all.providers[other]!.rows[0]!);
	const dropped = r.records.find((x) => x.issues.some((i) => i.drop));
	if (dropped) pick.add(dropped.row);

	const chosen = r.records.filter((x) => pick.has(x.row)).sort((a, b) => a.row - b.row);
	const rows = chosen.map((rec) => {
		const cells = raw[rec.row - 1] ?? [];
		const rawCells = cols.map((c) => (c >= 0 ? cells[c] ?? '' : ''));
		const clean = STORY_FIELDS.map((f) => text(rec.values[f]));
		const drop = rec.issues.find((i) => i.drop)?.message;
		return { n: rec.row, raw: rawCells, clean, changed: clean.flatMap((v, i) => (v !== rawCells[i] ? [i] : [])), ...(drop && { drop }) };
	});
	const g = lib.groupEntities(chosen.filter((x) => !x.issues.some((i) => i.drop)));
	const v = (e: Entity, f: string) => e.values[f] ?? '';
	return {
		file,
		headers: cols.map((c) => raw[r.headerRow]?.[c] ?? ''),
		rows,
		graph: {
			providers: g.providers.map((e, i) => ({ id: `p${i}`, title: `${v(e, 'provider.first_name')} ${v(e, 'provider.last_name')}${v(e, 'provider.degree') ? `, ${v(e, 'provider.degree')}` : ''}`, sub: `NPI ${v(e, 'provider.npi')}`, rows: e.rows })),
			locations: g.locations.map((e, i) => ({ id: `l${i}`, title: v(e, 'practice.address_1'), sub: `${v(e, 'practice.city')}, ${v(e, 'practice.state')} ${v(e, 'practice.zip')}`, rows: e.rows })),
			billing: g.billing.map((e, i) => ({ id: `b${i}`, title: v(e, 'billing.legal_name') || text(chosen.find((x) => e.rows.includes(x.row))?.values['practice.dba']) || 'Billing entity', sub: `TIN ${v(e, 'billing.tax_id')} · NPI ${v(e, 'billing.npi')}`, rows: e.rows })),
			links: [...g.providerLocations.map(([p, l]) => [`p${p}`, `l${l}`] as [string, string]), ...g.locationBilling.map(([l, b]) => [`l${l}`, `b${b}`] as [string, string])],
		},
	};
}
