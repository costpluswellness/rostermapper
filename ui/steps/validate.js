// Checks: look up NPIs and addresses, draw each entity's checks as a card (Review's graph and table),
// accept or undo suggestions. A run does the same in one go (validateRecords), applying only trusted fixes.
import { RANK, applyDropRules, checkIssues, lookupAll, lookupTargets, recordChecks } from '../rostermapper.js';
import { $, LOOKUP, esc, plural } from '../lib.js';
import { SOURCE_NAME, state } from '../state.js';
import { render, run, setSource, status } from '../app.js';
import { srcOf } from './entities.js';
// Only outside sources: NPPES and Census lookups, through the CLI's server (checks a value can fail
// on its own, like the NPI check digit, are Standardize's). A suggestion can be accepted per cell ("Use"); accepted
// values replace the cleaned ones for that entity's rows and move forward.
// Every check for one record's values: field → its checks, worst first (see checks.ts).
const checksFor = (values) => recordChecks(values, state.lookups, state.sources);

// Apply accepted suggestions and replace "invalid" and "warning" issues with the current checks'.
// A check that drops the row (wrong NPI) drops it from the export too.
// Checks run on the values before acceptance, so the lookups they used stay the same.
export function applyValidation() {
  state.checks = new Map();
  state.before = new Map();
  for (const r of state.result.records) {
    const before = { ...r.values };
    state.before.set(r.row, before);
    for (const [f, acc] of state.accepted.get(r.row) ?? []) r.values[f] = acc.value;
    const checks = checksFor(before);
    for (const f of (state.accepted.get(r.row) ?? new Map()).keys()) checks.delete(f);
    state.checks.set(r.row, checks);
    r.issues = r.issues.filter((i) => i.kind !== 'invalid' && i.kind !== 'warning' && !(i.kind === 'missing' && r.values[i.field]) && !(i.kind === 'format' && state.accepted.get(r.row)?.has(i.field)));
    r.issues.push(...checkIssues(checks));
    applyDropRules(r, state.result.file.category);
  }
}

// Cards: one per provider, location and billing entity, in its colour, showing only the values that
// get checked. Each checked value is highlighted with its result (hover for the source). One mark per
// card (its worst check; hover for all of them). Problems are listed in the card, each with "Use"
// when the source suggests a value.
const ACRONYMS = { npi: 'NPI', tax_id: 'Tax ID', zip: 'ZIP', address_1: 'Address', address_2: 'Address line 2', taxonomy_1: 'Taxonomy', taxonomy_2: 'Taxonomy 2', legal_name: 'Legal name', license_number: 'License', first_name: 'First name', middle_name: 'Middle name', last_name: 'Last name' };
const LABEL = (f) => { const n = f.split('.')[1]; return ACRONYMS[n] ?? n[0].toUpperCase() + n.slice(1).replace(/_/g, ' '); };
export const MARK = { ok: '✓', suggest: '⚠', warn: '⚠', fail: '✕', skip: '·' };
// The NPPES NPI Registry's page for an NPI, linked from every NPI on a card.
export const npiUrl = (npi) => `https://npiregistry.cms.hhs.gov/provider-view/${encodeURIComponent(npi)}`;
// A line alternates fields and separators: [F(a), ' · ', F(b)]. A field may carry a label (F(f, 'NPI ')).
// Empty fields drop out with their separator; a line with no values is dropped.
const F = (f, pre = '') => ({ f, pre });
const none = (text) => `<span class="none">${text}</span>`;
// Per kind: the fields checked, the card's title and lines, and what to say when a key value is missing.
const CARD = {
  provider: {
    fields: ['provider.npi', 'provider.first_name', 'provider.middle_name', 'provider.last_name', 'provider.degree', 'provider.gender', 'provider.taxonomy_1', 'provider.taxonomy_2', 'provider.license_number'],
    title: () => [F('provider.first_name'), ' ', F('provider.middle_name'), ' ', F('provider.last_name'), ', ', F('provider.degree')],
    lines: () => [[F('provider.npi', 'NPI ')], [F('provider.gender'), ' · ', F('provider.taxonomy_1'), ' · ', F('provider.taxonomy_2')], [F('provider.license_number', 'License ')]],
    missing: (v) => [!v['provider.npi'] && 'No NPI', !v['provider.taxonomy_1'] && 'No taxonomy'],
  },
  practice: {
    fields: ['practice.address_1', 'practice.city', 'practice.state', 'practice.zip'],
    title: (v) => [v['practice.location_name'] || v['practice.dba'] || 'Practice location'],
    lines: () => addressLines('practice'),
    missing: (v) => [!v['practice.address_1'] && 'No address'],
  },
  billing: {
    fields: ['billing.legal_name', 'billing.tax_id', 'billing.npi', 'billing.address_1', 'billing.city', 'billing.state', 'billing.zip'],
    title: (v) => [v['billing.legal_name'] ? F('billing.legal_name') : 'No legal name'],
    lines: () => [[F('billing.tax_id', 'TIN '), ' · ', F('billing.npi', 'NPI ')], ...addressLines('billing')],
    missing: () => [],
  },
};
const CARD_KINDS = [
  ['provider', 'Providers', () => state.entities.providers],
  ['practice', 'Practice locations', () => state.entities.locations],
  ['billing', 'Billing', () => state.entities.billing],
];
const addressLines = (p) => [[F(`${p}.address_1`)], [F(`${p}.address_2`)], [F(`${p}.city`), ', ', F(`${p}.state`), ' ', F(`${p}.zip`)]];
const problem = (s) => s === 'fail' || s === 'suggest' || s === 'warn';

function renderLine(parts, values, marks) {
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0] === 'No legal name' ? none(parts[0]) : esc(parts[0]);
  // Segments of [text, mark, link]; neighbouring values with the same result share one highlight.
  const segs = [];
  let sep = '';
  for (const p of parts) {
    if (typeof p === 'string') { sep = p; continue; }
    const value = values[p.f];
    if (!value) continue;
    // Only problems are highlighted: a value is taken as confirmed unless marked otherwise (the card's ✓ says it was checked).
    const m = ['skip', 'ok'].includes(marks.get(p.f)?.status) ? undefined : marks.get(p.f);
    const link = p.f.endsWith('.npi') && /^\d{10}$/.test(value) ? npiUrl(value) : '';
    const last = segs.at(-1);
    if (last && !p.pre && !link && !last[2] && last[1]?.status === m?.status) { last[0] += sep + value; if (m) last[1].tip += `\n${m.tip}`; }
    else { if (last) segs.push([sep, undefined]); if (p.pre) segs.push([p.pre, undefined]); segs.push([value, m && { ...m }, link]); }
  }
  // An NPI is a link to its page in the NPPES NPI Registry.
  return segs.map(([t, m, link]) => {
    const text = m ? `<span class="v ${m.status}" title="${esc(m.tip)}">${esc(t)}</span>` : esc(t);
    return link ? `<a class="npi" href="${link}" target="_blank" rel="noopener" title="Open in the NPPES NPI Registry">${text}<span class="arrow" aria-hidden="true">↗</span></a>` : text;
  }).join('');
}

// One entity's checks: its values (first non-empty per field, as elsewhere), each checked field's
// check or accepted suggestion, its worst status, and a highlight per value. Values Standardize
// couldn't clean are highlighted too, so one card shows both steps.
function entityChecks(kind, entity) {
  const card = CARD[kind];
  const values = {};
  const items = [];
  for (const f of [...card.fields, `${kind}.address_2`, `${kind}.location_name`, `${kind}.dba`]) {
    const r = srcOf(entity, f)?.clean;
    values[f] = r?.values[f] ?? '';
    if (!card.fields.includes(f) || !r) continue;
    const acc = state.accepted.get(r.row)?.get(f);
    const check = state.checks.get(r.row)?.get(f)?.[0];
    if (acc || check) items.push({ f, row: r.row, value: values[f], acc, check });
  }
  const status = items.reduce((worst, i) => (i.acc ? worst : !worst || RANK[i.check.status] < RANK[worst] ? i.check.status : worst), null);
  // A value filled in or changed on its own (a taxonomy or legal name from NPPES, a Census city) is
  // green, so it can be reviewed; a suggestion still waiting for "Use" stays orange.
  const autoTip = (i) => state.before.get(i.row)?.[i.f] ? `Auto-changed from ${i.acc.source}: ${changeText(i)}` : `Auto-filled from ${i.acc.source} (the roster had none)`;
  const marks = new Map(items.map((i) => [i.f, i.acc
    ? i.acc.auto ? { status: 'filled', tip: autoTip(i) } : { status: 'ok', tip: `Accepted from ${i.acc.source}` }
    : { status: i.check.status, tip: `${i.check.source}: ${i.check.detail}` }]));
  for (const [f, a] of state.accepted.get(entity.rows[0]) ?? []) if (a.with) marks.set(f, a.auto ? { status: 'filled', tip: `Auto-filled from ${a.source}` } : { status: 'ok', tip: `Accepted from ${a.source}` });
  const formats = [];
  for (const f of card.fields) {
    const issue = srcOf(entity, f)?.clean.issues.find((i) => i.field === f && i.kind === 'format');
    if (issue && !marks.get(f)) { marks.set(f, { status: 'fail', tip: issue.message }); formats.push({ f, issue }); }
  }
  return { values, items, status: formats.length ? 'fail' : status, marks, formats };
}

/**
 * One entity as a card: { mark, head, lines, fixes }, all HTML. The mark is its worst check (hover
 * for all); fixes are the problems, each with "Use" when the source suggests a value. Shared by
 * Validate's cards and Review's table and graph.
 */
export function entityCard(kind, entity) {
  const card = CARD[kind];
  const { values, items, status: checked, marks, formats } = entityChecks(kind, entity);
  // Values the entity's rows are missing (a ZIP, a billing NPI), each typed in place on the card.
  const blanks = new Map();
  for (const row of entity.rows) {
    for (const i of state.byRow.get(row)?.clean.issues ?? []) if (i.kind === 'missing' && i.field.startsWith(`${kind}.`) && !blanks.has(i.field)) blanks.set(i.field, i);
  }
  const status = blanks.size && (!checked || checked === 'ok' || checked === 'skip') ? 'warn' : checked;
  const hover = [...items.map((i) => i.acc ? `✓ ${LABEL(i.f)}: accepted from ${i.acc.source}` : `${MARK[i.check.status]} ${LABEL(i.f)}: ${i.check.detail}`),
    ...formats.map(({ f, issue }) => `✕ ${LABEL(f)}: ${issue.message}`), ...[...blanks.keys()].map((f) => `⚠ ${LABEL(f)}: missing`)].join('\n');
  // A mark only for a problem (⚠ or ✕): a value is taken as confirmed unless marked.
  const mark = status && status !== 'ok' && status !== 'skip' ? `<span class="mark ${status}" title="${esc(hover)}">${MARK[status]}</span>` : '';
  // Changes applied on their own (Census addresses, NPPES legal names): folded under "N changes from …", each with its old value.
  const auto = items.filter((i) => i.acc?.auto);
  const key = entity.rows.join(',');
  const changes = auto.length ? `<li class="auto"><button class="textlink small" data-changes="${key}" title="${esc(auto.map((i) => `${LABEL(i.f)}: ${changeText(i)}`).join('\n'))}">${state.showChanges.has(key) ? '▾' : '▸'} ${plural(auto.length, 'change')} from ${[...new Set(auto.map((i) => i.acc.source))].join(' and ')}</button>` +
    (state.showChanges.has(key) ? `<ul>${auto.map((i) => `<li><span class="muted">${LABEL(i.f)}:</span> ${esc(changeText(i))} <button class="textlink small" data-undo="${i.f}" data-rows="${key}">undo</button></li>`).join('')}</ul>` : '') + '</li>' : '';
  const fixes = changes + items.filter((i) => !i.acc?.auto && (i.acc || problem(i.check?.status))).map((i) => {
    if (i.acc) return `<li><span class="muted">${LABEL(i.f)}:</span> ${esc(i.value)} <span class="muted">accepted</span> <button class="textlink small" data-undo="${i.f}" data-rows="${key}">undo</button></li>`;
    return problemItem(i.f, i.value, i.check, entity.rows);
  }).join('') + formats.map(({ f, issue }) => `<li class="fail"><span class="muted">${LABEL(f)}:</span> ${esc(issue.message)} ${editControl(f, entity.rows, values[f], 'edit')}</li>`).join('') +
    [...blanks.keys()].filter((f) => !ADDRESS.some((a) => f === `${kind}.${a}`)).map((f) => `<li class="warn"><span class="muted">${LABEL(f)}:</span> missing ${editControl(f, entity.rows, '', 'add')}</li>`).join('') +
    addressFix(kind, entity, values, marks, blanks);
  const lines = card.lines(values).map((l) => renderLine(l, values, marks)).filter(Boolean);
  const head = renderLine(card.title(values), values, marks) || lines.shift() || '';
  const missing = card.missing(values).filter(Boolean);
  if (missing.length) lines.push(none(missing.join(' · ')));
  return { mark, head, lines, fixes, status };
}

// A practice or billing address with a problem in any part (missing, not cleaned, flagged by Census):
// "edit address" opens every part of it on the card, to fix together (see Review's saveAddress).
const ADDRESS = ['address_1', 'address_2', 'city', 'state', 'zip'];
const ADDRESS_LABEL = { address_1: 'Line 1', address_2: 'Line 2', city: 'City', state: 'State', zip: 'ZIP' };
function addressFix(kind, entity, values, marks, blanks) {
  if (kind !== 'practice' && kind !== 'billing') return '';
  const fields = ADDRESS.map((a) => `${kind}.${a}`);
  const wrong = fields.filter((f) => blanks.has(f) && f !== `${kind}.address_2` || ['fail', 'warn', 'suggest'].includes(marks.get(f)?.status));
  const key = `${kind}|${entity.rows.join(',')}`;
  if (!wrong.length && state.editingAddress !== key) return '';
  if (state.editingAddress !== key) {
    // Missing parts are named here; a flagged one is already explained above, by its check.
    const missing = wrong.filter((f) => blanks.has(f)).map((f) => ADDRESS_LABEL[f.split('.')[1]]);
    return `<li class="warn">${missing.length ? `<span class="muted">Address:</span> ${esc(missing.join(', '))} missing ` : ''}<button class="textlink small" data-edit-address="${key}">edit address</button></li>`;
  }
  return `<li class="addr-form" data-address-form="${key}"><div class="addr-grid">` +
    fields.map((f) => `<label class="${f.split('.')[1]}"><span>${ADDRESS_LABEL[f.split('.')[1]]}</span><input data-addr="${f}" value="${esc(values[f])}" data-was="${esc(values[f])}" spellcheck="false"${wrong.includes(f) ? ' class="wrong"' : ''}></label>`).join('') +
    `</div><button class="use" data-save-address>Save</button> <button class="textlink small" data-cancel-address>Cancel</button></li>`;
}

/** "edit" (or "add") for a value of some rows, or its input while it's being typed (see Review's saveEdit). */
export function editControl(f, rows, value, label = 'edit') {
  const key = `${f}|${rows.join(',')}`;
  return state.editing === key
    ? `<input class="fix" data-editing="${esc(key)}" value="${esc(value)}" spellcheck="false" aria-label="${esc(LABEL(f))}">`
    : `<button class="textlink small" data-edit="${esc(key)}" title="${esc(`Type the ${LABEL(f).toLowerCase()} for ${plural(rows.length, 'row')}`)}">${label}</button>`;
}

// One problem a source found, with "Use" when it suggests a value. Also used by Review's issues.
export function problemItem(f, value, c, rows) {
  if (c.suggestion !== undefined && (c.status === 'suggest' || c.status === 'fail')) {
    const also = Object.entries(c.also ?? {});
    const theirs = also.length ? [c.suggestion, ...also.map(([, v]) => v)].join(' / ') : c.suggestion;
    // A failure (the NPI belongs to someone else) says why before offering the fix.
    const why = c.status === 'fail' ? `${esc(c.detail)}<br>` : '';
    return `<li class="${c.status}" title="${esc(`${c.source}: ${c.detail}`)}">${why}<span class="muted">${LABEL(f)}:</span> ${esc(value) || '<span class="muted">blank</span>'} → <b>${esc(theirs)}</b> ` +
      `<button class="use" data-use="${f}" data-rows="${rows.join(',')}" data-value="${esc(c.suggestion)}" data-also="${esc(JSON.stringify(c.also ?? {}))}" data-source="${esc(c.source)}">Use</button></li>`;
  }
  return `<li class="${c.status}" title="${esc(`${c.source}: ${c.detail}`)}"><span class="muted">${LABEL(f)}:</span> ${esc(c.detail)}</li>`;
}

/** Clicks on a card's buttons (Use, undo, changes), wherever the card is drawn. True when handled. */
export function onCardClick(e, rerender) {
  const b = e.target.closest('[data-use], [data-undo], [data-changes]');
  if (!b) return false;
  e.stopPropagation();
  if (b.dataset.changes) {
    const k = b.dataset.changes;
    if (!state.showChanges.delete(k)) state.showChanges.add(k);
    rerender();
    return true;
  }
  if (b.dataset.use) {
    accept(b.dataset.rows.split(',').map(Number), b.dataset.use, b.dataset.value, JSON.parse(b.dataset.also || '{}'), b.dataset.source);
    run();
    return true;
  }
  for (const row of b.dataset.rows.split(',').map(Number)) {
    const acc = state.accepted.get(row);
    if (acc?.get(b.dataset.undo)?.auto) state.declined.add(`${row}|${b.dataset.undo}`);
    acc?.delete(b.dataset.undo);
    for (const [f, a] of acc ?? []) if (a.with === b.dataset.undo) acc.delete(f);
  }
  run();
  return true;
}

// The checks bar on Review: Run checks, sources turned off, and "Use all N from NPPES" for the
// suggestions not yet accepted (one-at-a-time ones, like taxonomies, excepted).
export function renderChecksBar() {
  const pending = new Map(); // source → suggestions not yet accepted
  for (const [kind, , list] of CARD_KINDS) {
    for (const entity of list()) {
      for (const { f, acc, check } of entityChecks(kind, entity).items) {
        if (!acc && check.status === 'suggest' && !check.keep) pending.set(check.source, [...(pending.get(check.source) ?? []), { f, rows: entity.rows, value: check.suggestion, also: check.also ?? {} }]);
      }
    }
  }
  const accepted = [...state.accepted.values()].reduce((n, m) => n + [...m.values()].filter((a) => !a.with).length, 0);
  $('bulk').innerHTML = [...pending].map(([source, list]) => `<button class="use" data-all="${esc(source)}">Use all ${list.length} from ${esc(source)}</button>`).join(' ') +
    (accepted ? ` <button class="textlink small" id="undo-all">undo all ${accepted}</button>` : '');
  $('bulk').querySelectorAll('[data-all]').forEach((b) => (b.onclick = () => {
    for (const s of pending.get(b.dataset.all)) accept(s.rows, s.f, s.value, s.also, b.dataset.all);
    run();
  }));
  const undoAll = $('undo-all');
  if (undoAll) undoAll.onclick = () => {
    for (const [row, m] of state.accepted) for (const [f, a] of m) if (a.auto && !a.with) state.declined.add(`${row}|${f}`);
    state.accepted = new Map();
    run();
  };
  const anyOn = state.sources.nppes || state.sources.census;
  $('run-checks').textContent = state.checking ? 'Checking…' : 'Run checks';
  $('run-checks').disabled = state.checking || !anyOn;
  // "NPPES: off · Turn on", per source that's off.
  $('sources-off').innerHTML = ['nppes', 'census'].filter((k) => !state.sources[k]).map((k) =>
    `<span class="muted">${SOURCE_NAME[k]}: off</span> <button class="textlink small" data-on="${k}">Turn on</button>`).join(' · ');
}

// Accept a suggestion for an entity's rows. An address split sets line 2 too (`also`); undoing
// line 1 undoes both (see data-undo).
function accept(rows, field, value, also, source, auto = false) {
  for (const row of rows) {
    if (!state.accepted.has(row)) state.accepted.set(row, new Map());
    state.accepted.get(row).set(field, { value, source, auto });
    for (const [f, v] of Object.entries(also)) state.accepted.get(row).set(f, { value: v, source, with: field, auto });
  }
}

// "old → new" for a value changed by an accepted suggestion; an address split shows both lines.
function changeText({ f, row, acc }) {
  const was = state.before.get(row)?.[f] || 'blank';
  const extra = [...(state.accepted.get(row) ?? [])].filter(([, a]) => a.with === f).map(([, a]) => a.value);
  return `${was} → ${[acc.value, ...extra].join(' / ')}`;
}

// Some suggestions are trusted by default and applied as soon as the lookups answer: the Census
// geocoder's city, state, ZIP and suite on line 2, and NPPES's legal name. Changes the user undid stay undone.
function applyAuto() {
  for (const [row, checks] of state.checks) {
    for (const list of checks.values()) {
      for (const c of list) {
        if (!c.auto || c.status !== 'suggest' || state.declined.has(`${row}|${c.field}`)) continue;
        accept([row], c.field, c.suggestion, c.also ?? {}, c.source, true);
      }
    }
  }
}

// Look up every NPI in NPPES and every address with the Census geocoder, 4 at a time; only the
// sources turned on under Upload's Checks, or just `kinds` when given.
export async function runChecks(kinds = ['nppes', 'census'].filter((k) => state.sources[k])) {
  if (!kinds.length) return void ($('check-note').textContent = 'Lookups are off; only checks that need no lookup ran.');
  const values = [...state.before.values()]; // values before accepted suggestions: what the checks use
  const { npis, lines } = lookupTargets(values);
  const on = { nppes: kinds.includes('nppes'), census: kinds.includes('census') };
  if (!(on.nppes && npis.size) && !(on.census && lines.size)) return void ($('check-note').textContent = 'No NPIs or addresses to look up.');
  state.checking = true;
  render();
  // The same lookups as a run's (lookupAll), through the CLI's server: browsers can't call NPPES or the Census geocoder.
  await lookupAll(values, on, LOOKUP, { lookups: state.lookups, progress: (done, total) => status(`Checking ${done} of ${total}…`) });
  state.checking = false;
  status('');
  $('check-note').textContent = 'Checked ' + [
    on.nppes && `${plural(npis.size, 'NPI')} with NPPES`,
    on.census && `${plural(lines.size, 'address', 'addresses')} with the US Census geocoder`,
  ].filter(Boolean).join(' and ') + '.';
  run();
  applyAuto();
  run();
}
$('run-checks').onclick = () => runChecks();
$('sources-off').onclick = (e) => { const kind = e.target.dataset?.on; if (kind) setSource(kind, true); };
