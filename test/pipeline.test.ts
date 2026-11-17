// The pipeline, the CLI and the Node API on a synthetic roster (test/fixtures/roster.csv: made-up
// providers, valid-looking NPIs). No network: lookups are faked.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { automap, isDropped, nppesBillingChecks, nppesProviderChecks, reportTables, runSheets, STEPS, StoppedEarly, type CensusMatch, type LookupFns, type NppesRecord, type StepEvent } from '../src/index';
import { readWorkbook } from '../src/workbook';
import { mapFiles } from '../src/node';
import { main, type Io } from '../src/cli/cli';

const FIXTURE = new URL('fixtures/roster.csv', import.meta.url).pathname;
const sheets = () => readWorkbook(readFileSync(FIXTURE));

// NPPES knows every fixture NPI as an active provider (the group NPI as an organization), except 1999990033.
const people: Record<string, [string, string]> = { '1999990009': ['JANE', 'DOE'], '1999990017': ['JOHN', 'SMITH'], '1999990025': ['ANA', 'LOPEZ'] };
const fakeLookup: LookupFns = {
	npi: async (npi) => {
		if (npi === '1999990058') return { number: npi, enumeration_type: 'NPI-2', basic: { status: 'A', organization_name: 'EXAMPLE FAMILY CLINIC PLLC' } } satisfies NppesRecord;
		const p = people[npi];
		return p ? { number: npi, enumeration_type: 'NPI-1', basic: { status: 'A', first_name: p[0], last_name: p[1] } } : null;
	},
	address: async (line): Promise<CensusMatch | null> =>
		line.startsWith('100 Main St') ? { matchedAddress: '100 MAIN ST, AUSTIN, TX, 78701', addressComponents: { city: 'AUSTIN', state: 'TX', zip: '78701' } } : null,
	byName: async () => [],
};

const quiet = (): Io & { text: () => string } => {
	let text = '';
	const sink = { write: (t: string) => (text += t) };
	return { out: sink, err: sink, lookup: fakeLookup, progress: false, text: () => text };
};

test('read: finds the header under a title row and removes SSNs', () => {
	const [sheet] = sheets();
	assert.equal(sheet!.redacted.columns.length, 1);
	assert.ok(!JSON.stringify(sheet!.rows).includes('123-45-6789'));
});

test('map and standardize: fields, cleaned values, dropped rows', async () => {
	const [r] = await runSheets('roster.csv', sheets());
	assert.ok(r);
	assert.equal(r.headerRow, 1);
	assert.equal(r.action.action, 'MIXED');
	assert.equal(r.category.category, 'individual');
	assert.equal(r.mapping['provider.npi']?.column, 4);
	assert.equal(r.mapping['billing.legal_name']?.column, 9);
	const first = r.records[0]!.values;
	assert.equal(first['provider.first_name'], 'Jane');
	assert.equal(first['provider.degree'], 'MD');
	assert.equal(first['billing.tax_id'], '12-3456789');
	assert.equal(first['practice.state'], 'TX');
	assert.equal(first['practice.phone'], '512-555-0100');
	assert.equal(r.records[1]!.values['network.effective_date'], '2026-12-01');
	assert.equal(r.records[6]!.values['practice.zip'], '08701');
	// Left out: an ADD with no TIN, a TERM with no NPI, an NPI that fails its check digit.
	assert.deepEqual(r.records.filter(isDropped).map((x) => x.row), [6, 7, 8]);
});

test('validate: lookups drop unknown NPIs and apply trusted fixes', async () => {
	const [r] = await runSheets('roster.csv', sheets(), { lookup: fakeLookup });
	const dropped = r!.records.filter(isDropped).map((x) => x.row);
	assert.deepEqual(dropped, [6, 7, 8, 9]); // 1999990033 isn't in (fake) NPPES
	assert.equal(r!.records[0]!.values['billing.legal_name'], 'Example Family Clinic PLLC'); // NPPES's legal name, applied
});

test('validate: a blank taxonomy is filled with NPPES\'s primary; a roster\'s taxonomy is kept', () => {
	const record: NppesRecord = { number: '1999990009', enumeration_type: 'NPI-1', basic: { status: 'A', first_name: 'JANE', last_name: 'DOE' },
		taxonomies: [{ code: '207R00000X', desc: 'Internal Medicine' }, { code: '207Q00000X', desc: 'Family Medicine', primary: true }] };
	const values = { 'provider.npi': '1999990009', 'provider.first_name': 'Jane', 'provider.last_name': 'Doe' };
	const blank = nppesProviderChecks(values, record).find((c) => c.field === 'provider.taxonomy_1');
	assert.equal(blank?.suggestion, '207Q00000X');
	assert.equal(blank?.auto, true);
	const ours = nppesProviderChecks({ ...values, 'provider.taxonomy_1': '207R00000X' }, record).find((c) => c.field === 'provider.taxonomy_1');
	assert.equal(ours?.status, 'ok');
});

test('validate: a blank billing legal name is filled from NPPES, for an active organization NPI only', () => {
	const org: NppesRecord = { number: '1999990058', enumeration_type: 'NPI-2', basic: { status: 'A', organization_name: 'DK PHYSICIANS PROFESSIONAL LIMITED LIABILITY COMPANY' } };
	const fill = (record: NppesRecord) => nppesBillingChecks({ 'billing.npi': '1999990058' }, record).find((c) => c.field === 'billing.legal_name');
	assert.equal(fill(org)?.suggestion, 'DK Physicians PLLC');
	assert.equal(fill(org)?.auto, true);
	assert.equal(fill({ ...org, enumeration_type: 'NPI-1' }), undefined); // an individual's NPI
	assert.equal(fill({ ...org, basic: { ...org.basic, status: 'D' } }), undefined); // deactivated
});

test('steps: onStep sees every step in order, and can stop the run', async () => {
	const seen: StepEvent['step'][] = [];
	await runSheets('roster.csv', sheets(), { lookup: fakeLookup, onStep: (e) => void seen.push(e.step) });
	assert.deepEqual(seen, ['map', 'standardize', 'validate', 'review']);
	await assert.rejects(runSheets('roster.csv', sheets(), { onStep: (e) => e.step !== 'standardize' }), StoppedEarly);
});

test('report tables: the workbook tabs', async () => {
	const results = await runSheets('roster.csv', sheets());
	const tables = reportTables('roster.csv', results);
	assert.deepEqual(Object.keys(tables), ['Summary', 'Mapping', 'Data', 'Issues', 'Left out']);
	assert.equal(tables.Data.length, 1 + 4); // header + rows moved forward
	assert.equal(tables['Left out'].length, 1 + 3);
});

test('standardize: allowed values are kept as written, for fields with a fixed list only', () => {
	const rows = [['Provider Type', 'Individual NPI'], ['AHP', '123'], ['phys', '123'], ['Wizard', '123']];
	const issues = (allowed?: Record<string, string[]>) => automap(rows, { allowed }).records.map((r) => r.issues.filter((i) => i.kind === 'format').map((i) => i.field).sort());
	assert.deepEqual(issues(), [['network.provider_type', 'provider.npi'], ['network.provider_type', 'provider.npi'], ['network.provider_type', 'provider.npi']]);
	// Case-insensitive; a value not listed is still flagged; an NPI can't be allowed.
	const allowed = { 'network.provider_type': ['AHP', 'PHYS'], 'provider.npi': ['123'] };
	assert.deepEqual(issues(allowed), [['provider.npi'], ['provider.npi'], ['network.provider_type', 'provider.npi']]);
	assert.equal(automap(rows, { allowed }).records[0]!.values['network.provider_type'], 'AHP');
});

test('CLI: --allow takes a field with a fixed list', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rm-'));
	assert.equal(await main([FIXTURE, '--allow', 'provider_type=AHP,PHYS', '--no-nppes', '--no-census', '-o', dir + '/'], quiet()), 0);
	const io = quiet();
	assert.equal(await main([FIXTURE, '--allow', 'npi=123', '-o', dir + '/'], io), 1);
	assert.match(io.text(), /--allow must be field=value,value for a field with a fixed list: .*provider_type/);
});

test('CLI: writes a workbook per sheet to the output folder', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rm-'));
	const io = quiet();
	assert.equal(await main([FIXTURE, '-o', dir + '/'], io), 0);
	assert.deepEqual(readdirSync(dir), ['RM_roster_Sheet1.xlsx']);
	assert.match(io.text(), /Sheet1 · MIXED · individual/);
});

test('CLI: --steps prints each step', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rm-'));
	const io = quiet();
	assert.equal(await main([FIXTURE, '--steps', '-o', dir + '/'], io), 0);
	for (const step of STEPS) assert.match(io.text(), new RegExp(`━━ ${step} ·`));
});

test('CLI: -o file.csv writes the records and the rows left out', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rm-'));
	assert.equal(await main([FIXTURE, '--no-nppes', '--no-census', '-o', join(dir, 'out.csv')], quiet()), 0);
	assert.equal(readFileSync(join(dir, 'out.csv'), 'utf8').trim().split('\r\n').length, 1 + 4);
	assert.equal(readFileSync(join(dir, 'out_issues.csv'), 'utf8').trim().split('\r\n').length, 1 + 3);
});

test('node: mapFiles maps a folder into a run folder with summary.xlsx', async () => {
	const out = mkdtempSync(join(tmpdir(), 'rm-'));
	const { dir, entries } = await mapFiles([new URL('fixtures', import.meta.url).pathname], { output: out, lookup: false });
	assert.deepEqual(readdirSync(dir).sort(), ['RM_roster_Sheet1.xlsx', 'summary.xlsx']);
	assert.equal(entries[0]?.movedForward, 4);
});
