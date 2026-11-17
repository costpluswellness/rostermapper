// 4 Validate (step by step): look up NPIs and addresses, show each entity's checks as a card, accept
// or undo suggestions. A run does the same in one go (validateRecords), applying only trusted fixes.
import { RANK, applyDropRules, checkIssues, lookupAll, lookupTargets, recordChecks } from '../rostermapper.js';
import { $, LOOKUP, esc, plural } from '../lib.js';
import { SOURCE_NAME, state } from '../state.js';
import { run, setSource, status } from '../app.js';
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
const MARK = { ok: '✓', suggest: '⚠', warn: '⚠', fail: '✕', skip: '·' };
// A line alternates fields and separators: [F(a), ' · ', F(b)]. A field may carry a label (F(f, 'NPI ')).
// Empty fields drop out with their separator; a line with no values is dropped.
const F = (f, pre = '') => ({ f, pre });
const CARD_KINDS = [
  ['provider', 'Providers', () => state.entities.providers, {
    fields: ['provider.npi', 'provider.first_name', 'provider.middle_name', 'provider.last_name', 'provider.degree', 'provider.gender', 'provider.taxonomy_1', 'provider.taxonomy_2', 'provider.license_number'],
    title: () => [F('provider.first_name'), ' ', F('provider.middle_name'), ' ', F('provider.last_name'), ', ', F('provider.degree')],
    lines: () => [[F('provider.npi', 'NPI ')], [F('provider.gender'), ' · ', F('provider.taxonomy_1'), ' · ', F('provider.taxonomy_2')], [F('provider.license_number', 'License ')]],
  }],
  ['practice', 'Practice locations', () => state.entities.locations, {
    fields: ['practice.address_1', 'practice.city', 'practice.state', 'practice.zip'],
    title: (v) => [v['practice.location_name'] || v['practice.dba'] || 'Practice location'],
    lines: () => addressLines('practice'),
  }],
  ['billing', 'Billing', () => state.entities.billing, {
    fields: ['billing.legal_name', 'billing.tax_id', 'billing.npi', 'billing.address_1', 'billing.city', 'billing.state', 'billing.zip'],
    title: (v) => [v['billing.legal_name'] ? F('billing.legal_name') : 'Billing entity'],
    lines: () => [[F('billing.tax_id', 'TIN '), ' · ', F('billing.npi', 'NPI ')], ...addressLines('billing')],
  }],
];
const addressLines = (p) => [[F(`${p}.address_1`)], [F(`${p}.address_2`)], [F(`${p}.city`), ', ', F(`${p}.state`), ' ', F(`${p}.zip`)]];
const CARDS_SHOWN = 20;

function renderLine(parts, values, marks) {
  if (parts.length === 1 && typeof parts[0] === 'string') return esc(parts[0]);
  // Segments of [text, mark]; neighbouring values with the same result share one highlight.
  const segs = [];
  let sep = '';
  for (const p of parts) {
    if (typeof p === 'string') { sep = p; continue; }
    const value = values[p.f];
    if (!value) continue;
    const m = marks.get(p.f)?.status === 'skip' ? undefined : marks.get(p.f);
    const last = segs.at(-1);
    if (last && !p.pre && last[1]?.status === m?.status) { last[0] += sep + value; if (m) last[1].tip += `\n${m.tip}`; }
    else { if (last) segs.push([sep, undefined]); if (p.pre) segs.push([p.pre, undefined]); segs.push([value, m && { ...m }]); }
  }
  return segs.map(([t, m]) => (m ? `<span class="v ${m.status}" title="${esc(m.tip)}">${esc(t)}</span>` : esc(t))).join('');
}

export function renderValidate() {
  const problem = (s) => s === 'fail' || s === 'suggest' || s === 'warn';
  const pending = new Map(); // source → suggestions not yet accepted, for "Use all"
  $('validated').innerHTML = CARD_KINDS.map(([kind, title, list, card]) => {
    const all = list().map((entity) => {
      // The entity's values (first non-empty per field, as elsewhere) and each field's check.
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
      for (const { f, acc, check: c } of items) if (!acc && c.status === 'suggest' && !c.keep) pending.set(c.source, [...(pending.get(c.source) ?? []), { f, rows: entity.rows, value: c.suggestion, also: c.also ?? {} }]);
      return { entity, values, items, status };
    });
    const cards = all.filter((c) => !state.onlyProblems || problem(c.status));
    if (!cards.length) return '';
    const open = state.expanded.has(`v-${kind}`);
    const shown = open ? cards : cards.slice(0, CARDS_SHOWN);
    const rows = (e) => e.rows.join(',');
    const html = shown.map(({ entity, values, items, status }) => {
      const hover = items.map((i) => i.acc ? `✓ ${LABEL(i.f)}: accepted from ${i.acc.source}` : `${MARK[i.check.status]} ${LABEL(i.f)}: ${i.check.detail}`).join('\n');
      const mark = status ? `<span class="mark ${status}" title="${esc(hover)}">${MARK[status]}</span>` : '';
      // Highlights: every checked value, coloured by its result; hover names the source.
      const marks = new Map(items.map((i) => [i.f, i.acc
        ? { status: 'ok', tip: i.acc.auto ? `${i.acc.source}: ${changeText(i)}` : `Accepted from ${i.acc.source}` }
        : { status: i.check.status, tip: `${i.check.source}: ${i.check.detail}` }]));
      for (const [f, a] of state.accepted.get(entity.rows[0]) ?? []) if (a.with) marks.set(f, { status: 'ok', tip: `Accepted from ${a.source}` });
      // Changes applied on their own (Census addresses, NPPES legal names): folded under "N changes from …", each with its old value.
      const auto = items.filter((i) => i.acc?.auto);
      const key = rows(entity);
      const changes = auto.length ? `<li class="auto"><button class="textlink small" data-changes="${key}" title="${esc(auto.map((i) => `${LABEL(i.f)}: ${changeText(i)}`).join('\n'))}">${state.showChanges.has(key) ? '▾' : '▸'} ${plural(auto.length, 'change')} from ${[...new Set(auto.map((i) => i.acc.source))].join(' and ')}</button>` +
        (state.showChanges.has(key) ? `<ul>${auto.map((i) => `<li><span class="muted">${LABEL(i.f)}:</span> ${esc(changeText(i))} <button class="textlink small" data-undo="${i.f}" data-rows="${key}">undo</button></li>`).join('')}</ul>` : '') + '</li>' : '';
      const fixes = changes + items.filter((i) => !i.acc?.auto && (i.acc || problem(i.check?.status))).map((i) => {
        if (i.acc) return `<li><span class="muted">${LABEL(i.f)}:</span> ${esc(i.value)} <span class="muted">accepted</span> <button class="textlink small" data-undo="${i.f}" data-rows="${rows(entity)}">undo</button></li>`;
        const c = i.check;
        if (c.suggestion !== undefined && (c.status === 'suggest' || c.status === 'fail')) {
          const also = Object.entries(c.also ?? {});
          const theirs = also.length ? [c.suggestion, ...also.map(([, v]) => v)].join(' / ') : c.suggestion;
          // A failure (the NPI belongs to someone else) says why before offering the fix.
          const why = c.status === 'fail' ? `${esc(c.detail)}<br>` : '';
          return `<li class="${c.status}" title="${esc(`${c.source}: ${c.detail}`)}">${why}<span class="muted">${LABEL(i.f)}:</span> ${esc(i.value) || '<span class="muted">blank</span>'} → <b>${esc(theirs)}</b> ` +
            `<button class="use" data-use="${i.f}" data-rows="${rows(entity)}" data-value="${esc(c.suggestion)}" data-also="${esc(JSON.stringify(c.also ?? {}))}" data-source="${esc(c.source)}">Use</button></li>`;
        }
        return `<li class="${c.status}" title="${esc(`${c.source}: ${c.detail}`)}"><span class="muted">${LABEL(i.f)}:</span> ${esc(c.detail)}</li>`;
      }).join('');
      const head = renderLine(card.title(values), values, marks);
      const lines = card.lines(values).map((l) => renderLine(l, values, marks)).filter(Boolean);
      return `<div class="vcard">${mark}<b>${head || lines.shift() || ''}</b>${lines.map((l) => `<span class="line">${l}</span>`).join('')}${fixes ? `<ul>${fixes}</ul>` : ''}</div>`;
    }).join('');
    const counts = ['fail', 'suggest', 'warn'].map((s) => [s, all.filter((c) => c.status === s).length]).filter(([, n]) => n);
    const more = cards.length > CARDS_SHOWN ? `<button class="more" data-kind="v-${kind}">${open ? 'Show fewer' : `Show all ${cards.length}`}</button>` : '';
    return `<section class="cards ${kind}"><h3>${title} <span class="muted">${all.length}${counts.length ? ` · ${counts.map(([s, n]) => `${MARK[s]} ${n}`).join(' · ')}` : ''}</span></h3>` +
      `<div class="card-grid">${html}</div>${more}</section>`;
  }).join('') || '<p class="muted">Nothing to show.</p>';

  $('validated').querySelectorAll('.more').forEach((b) => (b.onclick = () => {
    const k = b.dataset.kind;
    if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
    renderValidate();
  }));
  $('validated').querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => {
    accept(b.dataset.rows.split(',').map(Number), b.dataset.use, b.dataset.value, JSON.parse(b.dataset.also || '{}'), b.dataset.source);
    run();
  }));
  $('validated').querySelectorAll('[data-changes]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.changes;
    if (!state.showChanges.delete(k)) state.showChanges.add(k);
    renderValidate();
  }));
  $('validated').querySelectorAll('[data-undo]').forEach((b) => (b.onclick = () => {
    for (const row of b.dataset.rows.split(',').map(Number)) {
      const acc = state.accepted.get(row);
      if (acc?.get(b.dataset.undo)?.auto) state.declined.add(`${row}|${b.dataset.undo}`);
      acc?.delete(b.dataset.undo);
      for (const [f, a] of acc ?? []) if (a.with === b.dataset.undo) acc.delete(f);
    }
    run();
  }));
  // "Use all N from Census": accept every pending suggestion from one source; "undo all" clears them.
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
  const done = state.lookups.nppes.size + state.lookups.census.size;
  const anyOn = state.sources.nppes || state.sources.census;
  $('run-checks').textContent = state.checking ? 'Checking…' : done ? 'Run checks again' : 'Run checks';
  $('run-checks').disabled = state.checking || !anyOn;
  // "NPPES: off (turned off on Upload) · Turn on", per source that's off.
  $('sources-off').innerHTML = ['nppes', 'census'].filter((k) => !state.sources[k]).map((k) =>
    `<span class="muted">${SOURCE_NAME[k]}: off (turned off on Upload)</span> <button class="textlink small" data-on="${k}">Turn on</button>`).join(' · ');
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
  renderValidate();
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
$('only-problems').onchange = (e) => { state.onlyProblems = e.target.checked; renderValidate(); };