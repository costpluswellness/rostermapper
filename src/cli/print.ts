// What the CLI prints: the mapping table, per-sheet summaries, and each step's result for --steps.
import { ACTIONS } from '../map/action';
import { fieldList } from '../schema/fields';
import { schema } from '../schema/schema.generated';
import { isDropped, type RosterRecord } from '../standardize/records';
import { counts, hasProblem, ISSUE_KIND, who, type SheetResult } from '../export/tables';
import { STEP_SUMMARY, type StepEvent } from '../pipeline';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Two lines per sheet: "Data Table · ADD · individual · 34 of 42 columns mapped" and the row counts. */
export function sheetSummary(r: SheetResult): string {
	const c = counts(r.records);
	return `${r.sheet} · ${r.action.action} · ${r.category.category} · ${Object.keys(r.mapping).length} of ${r.columns.length} columns mapped\n` +
		`  ${c.rows} rows: ${c.movedForward} moved forward, ${c.leftOut} left out, ${c.withIssues} with issues\n`;
}

/** The mapping (with --why, the reasons) and the records' issues: printed for -o *.csv / *.json, and with --why. */
export function mappingTable(r: SheetResult, why: boolean): string {
	const { head, columns } = mapLines(r, why);
	return [...head, recordsLine(r), ...droppedLines(r), '', ...columns].join('\n') + '\n';
}

// The sheet's header row, action, category and transform hints, then one line per column: letter, header, value type, field and score.
function mapLines(result: SheetResult, why: boolean): { head: string[]; columns: string[] } {
	const assigned = new Map(Object.values(result.mapping).map((a) => [a.column, a]));
	const suggested = new Map(result.suggestions.map((s) => [s.column, s]));
	const width = Math.min(40, Math.max(6, ...result.columns.map((c) => oneLine(c.header).length)));
	const lines = [
		'',
		`${result.sheet} · header on row ${result.headerRow + 1} · ${plural(result.rowCount, 'row')} · ${assigned.size} of ${fieldList(schema).length} fields mapped`,
		`action ${result.action.action} · ${result.action.why}`,
		`category ${result.category.category} · ${result.category.why}`,
		...result.transforms.map((t) => `transform likely · ${t.message}`),
		...missingLines(result),
	];
	const columns: string[] = [];
	for (const column of result.columns) {
		const a = assigned.get(column.index);
		const hint = suggested.get(column.index);
		const target = a ? `${a.field}  ${a.score.toFixed(2)}` : column.status === 'ignored' ? '(ignored)' : hint ? `- (maybe ${hint.field})` : '-';
		const header = (oneLine(column.header) || '(blank)').slice(0, width).padEnd(width);
		columns.push(`  ${column.letter.padEnd(3)} ${header}  ${column.type.padEnd(8)}  ${target}`);
		if (why && a) columns.push(`      ${''.padEnd(width)}  ${''.padEnd(8)}  ${a.why.join('; ')}`);
	}
	return { head: lines, columns };
}

// "missing for ADD: provider.degree, practice.phone", one line per action.
function missingLines({ missing }: SheetResult): string[] {
	const byAction = new Map<string, string[]>();
	for (const { field, actions } of missing) for (const a of actions) byAction.set(a, [...(byAction.get(a) ?? []), field]);
	return [...byAction].map(([action, fields]) => `missing for ${action}: ${fields.join(', ')}`);
}

// "17 records · 3 dropped · 5 with issues (2 missing provider.npi, …)"
function recordsLine({ records }: SheetResult): string {
	const tally = new Map<string, number>();
	for (const { issues } of records) {
		for (const { field, kind } of issues) {
			const key = `${kind === 'format' ? 'unreadable' : kind === 'default' ? 'defaulted' : kind === 'invalid' ? 'rejected' : kind} ${field}`;
			tally.set(key, (tally.get(key) ?? 0) + 1);
		}
	}
	const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([what, n]) => `${n} ${what}`);
	return `${records.length} records · ${records.filter(isDropped).length} dropped · ${records.filter(hasProblem).length} with issues${top.length ? ` (${top.join(', ')}${tally.size > 3 ? ', …' : ''})` : ''}`;
}

// One line per dropped row, with why: "  dropped row 12 (Smith, Jane): provider.npi: no NPI; row dropped".
function droppedLines({ records }: SheetResult, max = 20): string[] {
	const dropped = records.filter(isDropped);
	const line = (r: RosterRecord) => {
		const name = who(r);
		return `  dropped row ${r.row}${name ? ` (${name})` : ''}: ${r.issues.filter((i) => i.drop).map((i) => `${i.field}: ${i.message}`).join('; ')}`;
	};
	return [...dropped.slice(0, max).map(line), ...(dropped.length > max ? [`  … and ${dropped.length - max} more dropped rows`] : [])];
}

// Issues of some kinds, counted by field: "  provider.npi  3 unreadable".
function issueTally(records: readonly RosterRecord[], kinds: readonly string[]): string[] {
	const tally = new Map<string, number>();
	for (const r of records) for (const i of r.issues) if (kinds.includes(i.kind)) tally.set(`${i.field}  ${ISSUE_KIND[i.kind]}`, (tally.get(`${i.field}  ${ISSUE_KIND[i.kind]}`) ?? 0) + 1);
	return [...tally].sort((a, b) => b[1] - a[1]).map(([what, n]) => `  ${String(n).padStart(4)}  ${what}`);
}

/** One step's result, for --steps. */
export function stepReport(event: StepEvent): string {
	const head = `\n━━ ${event.step} · ${STEP_SUMMARY[event.step]}`;
	switch (event.step) {
		case 'read':
			return [head, `${event.file}: ${plural(event.sheets.length, 'sheet')} with data`,
				...event.sheets.map((s) => {
					const r = 'redacted' in s ? (s as { redacted: { columns: number[]; cells: number } }).redacted : undefined;
					const ssn = r && (r.columns.length || r.cells) ? ` · SSNs removed: ${plural(r.columns.length, 'column')}, ${plural(r.cells, 'cell')}` : '';
					return `  ${s.name} · ${plural(s.rows.length, 'row')} read${ssn}`;
				})].join('\n') + '\n';
		case 'map':
			return [head, ...event.results.flatMap((r) => {
				const { head: lines, columns } = mapLines(r, true);
				return [...lines, '', ...columns];
			})].join('\n') + '\n';
		case 'standardize':
			return [head, ...event.results.flatMap((r) => ['', `${r.sheet} · ${recordsLine(r)}`, ...issueTally(r.records, ['format', 'missing', 'default']), ...droppedLines(r)])].join('\n') + '\n';
		case 'validate': {
			if (!event.ran) return `${head}\nskipped: no lookups (--no-nppes and --no-census, or none configured)\n`;
			const on = [event.sources.nppes && `NPPES ${plural(event.lookups.nppes.size, 'NPI')}`, event.sources.census && `Census ${plural(event.lookups.census.size, 'address', 'addresses')}`].filter(Boolean).join(' · ');
			const records = event.results.flatMap((r) => r.records);
			const changes = event.changes.slice(0, 30).map((c) => `  row ${c.row} ${c.field}: ${c.from || '(blank)'} → ${c.to}`);
			return [head, `checked ${on}${event.lookups.names?.size ? ` · ${plural(event.lookups.names.size, 'name search', 'name searches')}` : ''}`,
				`${plural(event.changes.length, 'value')} changed by trusted sources${event.changes.length ? ':' : ''}`, ...changes,
				...(event.changes.length > 30 ? [`  … and ${event.changes.length - 30} more`] : []),
				...((t) => (t.length ? ['issues from lookups:', ...t] : ['no issues from lookups']))(issueTally(records, ['invalid', 'warning'])),
				`${records.filter(isDropped).length} rows left out in all`].join('\n') + '\n';
		}
		case 'review':
			return [head, ...event.results.map((r, i) => {
				const e = event.entities[i]!;
				const combos = new Set(r.records.filter((x) => !isDropped(x)).map((x) => [x.values['provider.npi'], x.values['practice.address_1'], x.values['practice.zip'], x.values['billing.tax_id']].join('|'))).size;
				return `${r.sheet} · ${plural(e.providers.length, 'provider')} · ${plural(e.locations.length, 'practice location')} · ${plural(e.billing.length, 'billing entity', 'billing entities')} · ${plural(combos, 'combination')}`;
			})].join('\n') + '\n';
		case 'export':
			return [head, ...event.files.map((f) => `  ${f}`)].join('\n') + '\n';
	}
}

/** The data dictionary, as `rostermapper fields` prints it. */
export function fieldsText(json = false): string {
	const all = fieldList(schema).map(({ id, spec }) => ({ id, type: spec.type, required: spec.required ?? [], preferred: spec.preferred ?? [], description: spec.description }));
	if (json) return JSON.stringify(all, null, 2);
	const width = Math.max(...all.map((f) => f.id.length));
	const level = (f: (typeof all)[number]) => ACTIONS.map((a) => (f.required.includes(a) ? 'R' : f.preferred.includes(a) ? 'p' : '·')).join('');
	return `${'field'.padEnd(width)}  ${'type'.padEnd(7)}  AUT  description\n` +
		all.map((f) => `${f.id.padEnd(width)}  ${f.type.padEnd(7)}  ${level(f)}  ${f.description}`).join('\n') +
		'\n\nAUT = level for ADD, UPDATE, TERM: R required (rows missing it are flagged), p preferred, · optional';
}
