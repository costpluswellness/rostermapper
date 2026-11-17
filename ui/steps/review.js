import { $, XLSX, download, esc, plural, specOf } from '../lib.js';
import { counts, isDropped, outputName, toReport } from '../rostermapper.js';
import { saveAllowed, state } from '../state.js';
import { checkedWith, openMap, pickSheet, remember, run, sheetMemo } from '../app.js';
import { isIgnored, toggleIgnored } from '../results.js';
import { editControl, entityCard, onCardClick, renderChecksBar, runChecks } from './validate.js';
// ─── Review: a file's one page ──────────────────────────────
// Its sheets along the top; providers, locations and billing as a graph or a table, each card carrying
// its checks (✓, problems highlighted, "Use"); every issue below with its fix; Mapping and Raw data as
// dialogs; Download for the whole file.
export const KIND_LABEL = { missing: 'missing', format: 'invalid', invalid: 'per source', warning: 'check', default: 'note' };
const NONE = { provider: 'No provider', practice: 'No practice location', billing: 'No billing' };

export function renderReview() {
  renderHead();
  renderSheetTabs();
  renderChecksBar();
  const graph = state.reviewView === 'graph';
  $('graph').hidden = !graph;
  $('chains-wrap').hidden = graph;
  document.querySelectorAll('#review-view button').forEach((b) => b.classList.toggle('on', b.dataset.review === state.reviewView));
  if (graph) renderPreview(); else renderChains();
  renderIssues();
  if (state.editing) { const input = $('step-review').querySelector('[data-editing]'); input?.focus(); input?.select(); }
}

// A sheet's result: the open one live, another as it was left, or as the run made it.
const sheetResult = (name) => (name === state.sheet ? state.result : sheetMemo.get(`${state.name}|${name}`)?.result ?? state.files[state.current]?.results?.find((r) => r.sheet === name));

// The file's name and totals across its sheets not ignored, then the open sheet's figures.
function renderHead() {
  $('file-title').textContent = state.name;
  const kept = state.sheets.filter(({ name }) => !isIgnored(state.name, name));
  const all = counts(kept.flatMap(({ name }) => sheetResult(name)?.records ?? []));
  $('file-totals').textContent = [state.sheets.length > 1 && `${plural(kept.length, 'sheet')}${kept.length < state.sheets.length ? ` of ${state.sheets.length}` : ''}`,
    plural(all.rows, 'row'), `${all.movedForward} moved forward`, `${all.leftOut} left out`, `${all.withIssues} with issues`].filter(Boolean).join(' · ');
  const c = counts(state.result.records);
  const stat = (label, n, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${label}</dt><dd>${n}</dd></div>`;
  $('sheet-stats').innerHTML = stat('Rows', c.rows) + stat('Moved forward', c.movedForward) + stat('Left out', c.leftOut, c.leftOut ? 'bad' : '') +
    stat('With issues', c.withIssues, c.withIssues ? 'warn' : '') + stat('Providers', state.kept.providers.length, 'provider') +
    stat('Locations', state.kept.locations.length, 'practice') + stat('Billing', state.kept.billing.length, 'billing');
}

// The file's sheets as tabs, each with its row count; × ignores one (left out of Results and the download), ↺ brings it back.
function renderSheetTabs() {
  const tabs = $('sheet-tabs');
  tabs.hidden = state.sheets.length < 2;
  if (tabs.hidden) return;
  tabs.innerHTML = state.sheets.map(({ name }) => {
    const off = isIgnored(state.name, name);
    const result = sheetResult(name);
    const n = result ? counts(result.records).rows : '';
    return `<button type="button" data-sheet="${esc(name)}" class="${name === state.sheet ? 'on' : ''}${off ? ' ignored' : ''}"${off ? ' title="Ignored: left out of Results and the download"' : ''}>${esc(name)}` +
      `${n !== '' ? ` <small class="muted">${n}</small>` : ''}<span class="x" data-ignore="${esc(name)}" title="${off ? 'Bring this sheet back' : 'Ignore this sheet: leave it out of Results and the download'}">${off ? '↺' : '×'}</span></button>`;
  }).join('');
}
$('sheet-tabs').onclick = (e) => {
  const x = e.target.closest('[data-ignore]');
  if (x) return toggleIgnored(state.name, x.dataset.ignore);
  const b = e.target.closest('[data-sheet]');
  if (b && b.dataset.sheet !== state.sheet) { remember(); pickSheet(b.dataset.sheet); }
};

// One workbook for the file: every sheet not ignored, each as it was left here (or as the run made it).
$('download').onclick = () => {
  remember();
  const f = state.files[state.current];
  const results = state.sheets.map(({ name }) => name).filter((n) => !isIgnored(state.name, n))
    .map((n) => sheetMemo.get(`${state.name}|${n}`)?.result ?? f?.results?.find((r) => r.sheet === n)).filter((r) => r?.records.length);
  if (!results.length) return;
  const name = results.length === 1 ? outputName(results[0].file, 'xlsx') : `RM_${state.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '') || 'roster'}.xlsx`;
  download(toReport(state.name, results, { notes: { Checked: checkedWith() } }), XLSX, name);
};


// Issues grouped by entity: the same issue on the same provider, location or billing entity shows
// once, with its rows, and one fix for all of them: a missing value → its field on Map; a value
// Standardize couldn't clean → Standardize; a source's suggestion → "Use", for every row of the entity.
// Network and file fields have no entity: the same issue on them is grouped across rows.
// Issues that drop rows first: those rows won't be exported.
const KIND_OF = { provider: ['providers', 'Provider'], practice: ['locations', 'Location'], billing: ['billing', 'Billing'] };
const ROWS_SHOWN = 8;
function entityName(kind, e) {
  const v = (f) => e?.values[f] ?? '';
  if (kind === 'provider') return [v('provider.last_name'), v('provider.first_name')].filter(Boolean).join(', ') || (v('provider.npi') && `NPI ${v('provider.npi')}`);
  if (kind === 'practice') return v('practice.location_name') || v('practice.dba') || [v('practice.address_1'), v('practice.city')].filter(Boolean).join(', ');
  if (kind === 'billing') return v('billing.legal_name') || (v('billing.tax_id') && `TIN ${v('billing.tax_id')}`);
  return '';
}
function renderIssues() {
  // Row → entity index, per kind (every row, dropped ones too).
  const index = {};
  for (const [kind, [list]] of Object.entries(KIND_OF)) {
    index[kind] = new Map();
    state.entities[list].forEach((e, k) => e.rows.forEach((r) => index[kind].set(r, k)));
  }
  const groups = new Map();
  for (const r of state.result.records) {
    for (const i of r.issues) {
      const kind = i.field.split('.')[0];
      const k = index[kind]?.get(r.row);
      const key = [kind, k ?? '', i.field, i.kind, i.message].join('|');
      if (!groups.has(key)) groups.set(key, { kind, entity: k === undefined ? null : state.entities[KIND_OF[kind][0]][k], issue: i, first: r, rows: [] });
      groups.get(key).rows.push(r.row);
    }
  }
  const order = ['provider', 'practice', 'billing'];
  const list = [...groups.values()].sort((a, b) => !!b.issue.drop - !!a.issue.drop || (order.indexOf(a.kind) + 4) % 4 - (order.indexOf(b.kind) + 4) % 4 || a.rows[0] - b.rows[0]);
  const fix = ({ issue: i, first, rows }) => {
    if (i.kind === 'default') return '';
    // "edit": type the right value for the issue's rows, in place.
    const edit = ` ${editControl(i.field, rows, first.values[i.field])}`;
    if (i.kind === 'missing') return ` <button class="textlink small" data-map="${esc(i.field)}" title="See ${esc(i.field)} in Mapping">mapping</button>${edit}`;
    if (i.kind === 'format') {
      // A value from a fixed list (provider type, gender, …) can be allowed as written.
      const value = first.values[i.field];
      const allow = specOf(i.field).type === 'enum' && value ? ` <button class="use" data-allow="${esc(i.field)}" data-value="${esc(value)}" title="${esc(`Keep "${value}" as written for ${i.field}, in this file and the next (remembered in this browser)`)}">Allow “${esc(value)}”</button>` : '';
      return allow + edit;
    }
    const c = state.checks.get(first.row)?.get(i.field)?.[0];
    if (c?.suggestion === undefined) return edit;
    const theirs = [c.suggestion, ...Object.values(c.also ?? {})].join(' / ');
    return ` <button class="use" data-use="${esc(i.field)}" data-rows="${rows.join(',')}" data-value="${esc(c.suggestion)}" data-also="${esc(JSON.stringify(c.also ?? {}))}" data-source="${esc(c.source)}" title="${esc(`Use ${c.source}'s value for ${plural(rows.length, 'row')}`)}">Use “${esc(theirs)}”</button>`;
  };
  const rowsCell = (rows) => esc(rows.slice(0, ROWS_SHOWN).join(', ')) + (rows.length > ROWS_SHOWN ? ` <span class="muted" title="${esc(rows.join(', '))}">+${rows.length - ROWS_SHOWN}</span>` : '');
  $('issues').innerHTML = '<tr><th>Entity</th><th>Issue</th><th>Rows</th></tr>' + (list.slice(0, 500).map((g) => {
    const { kind, entity, issue: i, rows } = g;
    // The entity's name shows its card in the graph (rows left out aren't there).
    const name = esc(entityName(kind, entity)) || '<span class="muted">blank</span>';
    const card = KIND_OF[kind] && cardIndex(kind, g.first.row) >= 0 ? `<a href="#" data-show="${kind}|${g.first.row}" title="Show its card">${name}</a>` : name;
    const who = KIND_OF[kind] ? `<span class="ent-${kind}">${KIND_OF[kind][1]}</span> ${card}` : `<span class="muted">${esc(kind[0].toUpperCase() + kind.slice(1))}</span>`;
    const drop = i.drop ? ' <span class="drop" title="These rows are not exported">dropped</span>' : '';
    return `<tr><td>${who}</td><td><span class="muted">${KIND_LABEL[i.kind]}</span> ${esc(i.field)}${i.kind === 'missing' && !i.drop ? '' : `: ${esc(i.message)}`}${fix(g)}</td><td class="muted nowrap">${rowsCell(rows)}${drop}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">No issues.</td></tr>');
  // Values allowed so far, each with × to flag it again.
  const allowed = [...state.allowed].flatMap(([f, set]) => [...set].map((v) => [f, v]));
  $('allowed').hidden = !allowed.length;
  $('allowed').innerHTML = '<span class="muted">Allowed:</span> ' + allowed.map(([f, v]) => `<span class="chip" title="${esc(f)}">${esc(v)} <button class="textlink small" data-disallow="${esc(f)}" data-value="${esc(v)}" title="Flag it again">×</button></span>`).join(' ');
}

document.querySelectorAll('#review-view button').forEach((b) => (b.onclick = () => {
  state.reviewView = b.dataset.review;
  renderReview();
}));
$('step-review').addEventListener('click', (e) => {
  const m = e.target.closest('[data-map]');
  if (m) return openMap(m.dataset.map);
  const ed = e.target.closest('[data-edit]');
  if (ed) { e.stopPropagation(); state.editing = ed.dataset.edit; return renderReview(); }
  const ea = e.target.closest('[data-edit-address]');
  if (ea) { e.stopPropagation(); state.editingAddress = ea.dataset.editAddress; renderReview(); return void $('step-review').querySelector('[data-address-form] input')?.focus(); }
  if (e.target.closest('[data-cancel-address]')) { state.editingAddress = null; return renderReview(); }
  const sa = e.target.closest('[data-save-address]');
  if (sa) return saveAddress(sa.closest('[data-address-form]'));
  const show = e.target.closest('[data-show]');
  if (show) { e.preventDefault(); const [kind, row] = show.dataset.show.split('|'); return showCard(kind, +row); }
  const a = e.target.closest('[data-allow], [data-disallow]');
  if (a) {
    const f = a.dataset.allow ?? a.dataset.disallow;
    if (!state.allowed.has(f)) state.allowed.set(f, new Set());
    if (a.dataset.allow) state.allowed.get(f).add(a.dataset.value); else state.allowed.get(f).delete(a.dataset.value);
    saveAllowed();
    return run();
  }
  onCardClick(e, renderReview);
});

// An issue's value typed in place: Enter saves it for the issue's rows (cleaned and checked like any
// other value), Escape or leaving the box without a change cancels.
$('step-review').addEventListener('keydown', (e) => {
  const form = e.target.closest('[data-address-form]');
  if (form && e.key === 'Enter') return saveAddress(form);
  if (form && e.key === 'Escape') { state.editingAddress = null; return renderReview(); }
  const input = e.target.closest('[data-editing]');
  if (!input) return;
  if (e.key === 'Escape') { state.editing = null; return renderReview(); }
  if (e.key === 'Enter') saveEdit(input);
});
$('step-review').addEventListener('focusout', (e) => { const input = e.target.closest('[data-editing]'); if (input && state.editing) saveEdit(input); });
function saveEdit(input) {
  const [f, rows] = input.dataset.editing.split('|');
  state.editing = null;
  if (input.value === input.defaultValue) return renderReview(); // unchanged: nothing to save
  applyTyped(rows.split(',').map(Number), { [f]: input.value.trim() });
}

// A card's address, every part at once: the parts changed are typed over the rows' values, and the
// new address is looked up with the Census geocoder.
function saveAddress(form) {
  const typed = {};
  for (const input of form.querySelectorAll('[data-addr]')) if (input.value.trim() !== input.dataset.was) typed[input.dataset.addr] = input.value.trim();
  state.editingAddress = null;
  if (!Object.keys(typed).length) return renderReview();
  applyTyped(form.dataset.addressForm.split('|')[1].split(',').map(Number), typed);
  if (state.sources.census) runChecks(['census']);
}

// Values typed for some rows: they replace the cleaned ones (cleaned and checked like any other).
// A suggestion accepted for the field (a Census city, say) is undone, so what was typed wins.
function applyTyped(rows, typed) {
  for (const row of rows) {
    if (!state.fixes.has(row)) state.fixes.set(row, new Map());
    for (const [f, value] of Object.entries(typed)) {
      const raw = state.byRow.get(row)?.raw.values[f] ?? '';
      // Typing the value back as written drops the fix, so cleaning applies again.
      if (value === raw) state.fixes.get(row).delete(f); else state.fixes.get(row).set(f, value);
      if (state.accepted.get(row)?.delete(f)) state.declined.add(`${row}|${f}`);
    }
  }
  run(); // a pinned card stays pinned (see run)
}

// The card holding a row, in the graph: pinned (its problems open, its links lit) and scrolled into view.
const LIST = { provider: 'providers', practice: 'locations', billing: 'billing' };
// Its card's index, or -1: a row left out, or one with no such entity (no practice address), has none.
const cardIndex = (kind, row) => state.kept[LIST[kind]].findIndex((e) => e.rows.includes(row));
function showCard(kind, row, { scroll = true } = {}) {
  const i = cardIndex(kind, row);
  if (i < 0) return;
  state.reviewView = 'graph';
  state.selected = { kind, i };
  renderReview();
  const li = $('graph').querySelector(`li[data-kind="${kind}"][data-i="${i}"]`);
  if (!scroll || !li) return;
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 1600);
}

// A card's HTML in a table cell or a graph node: title with its mark, detail lines, problems.
const cardHtml = (kind, e, { fixes = true } = {}) => {
  const c = entityCard(kind, e);
  return `<b>${c.head} ${c.mark}</b>${c.lines.map((l) => `<span>${l}</span>`).join('')}${fixes && c.fixes ? `<ul class="fixes">${c.fixes}</ul>` : ''}`;
};

// The table view: one line per unique provider × location × billing combination, with its rows.
function renderChains() {
  const { providers, locations, billing } = state.kept;
  const indexOf = (list) => { const m = new Map(); list.forEach((e, i) => e.rows.forEach((r) => m.set(r, i))); return m; };
  const [p, l, b] = [indexOf(providers), indexOf(locations), indexOf(billing)];
  const chains = new Map();
  for (const r of state.result.records.filter((x) => !isDropped(x))) {
    const key = [p.get(r.row), l.get(r.row), b.get(r.row)].join(',');
    if (!chains.has(key)) chains.set(key, { p: p.get(r.row), l: l.get(r.row), b: b.get(r.row), rows: [] });
    chains.get(key).rows.push(r.row);
  }
  // A provider, location or billing entity shared by several lines is drawn in full once; its problems only the first time.
  const seen = new Set();
  const cell = (kind, list, i) => {
    if (i === undefined) return `<td class="${kind}"><span class="none">${NONE[kind]}</span></td>`;
    const first = !seen.has(`${kind}${i}`);
    seen.add(`${kind}${i}`);
    return `<td class="${kind}">${cardHtml(kind, list[i], { fixes: first })}</td>`;
  };
  $('chains').innerHTML = '<tr><th class="provider">Provider</th><th class="practice">Practice location</th><th class="billing">Billing</th><th>Rows</th></tr>' +
    ([...chains.values()].map((c) => `<tr>${cell('provider', providers, c.p)}${cell('practice', locations, c.l)}${cell('billing', billing, c.b)}` +
      `<td class="muted">${c.rows.join(', ')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No rows move forward.</td></tr>');
}

// ─── Preview: providers ↔ locations ↔ billing ───────────────
const KINDS = ['provider', 'practice', 'billing'];
const LISTS = { provider: 'providers', practice: 'locations', billing: 'billing' };
const join = (parts, sep = ' ') => parts.filter(Boolean).join(sep);

// Index → connected indexes, per pair of kinds.
function neighbours() {
  const { providerLocations, locationBilling } = state.kept;
  const map = (pairs, from, to) => {
    const m = new Map();
    for (const pair of pairs) m.set(pair[from], [...(m.get(pair[from]) ?? []), pair[to]]);
    return m;
  };
  return {
    providerToPractice: map(providerLocations, 0, 1), practiceToProvider: map(providerLocations, 1, 0),
    practiceToBilling: map(locationBilling, 0, 1), billingToPractice: map(locationBilling, 1, 0),
  };
}

function renderPreview() {
  const n = neighbours();
  const linkText = {
    provider: (i) => plural((n.providerToPractice.get(i) ?? []).length, 'location'),
    practice: (i) => join([plural((n.practiceToProvider.get(i) ?? []).length, 'provider'), plural((n.practiceToBilling.get(i) ?? []).length, 'billing entity', 'billing entities')], ' · '),
    billing: (i) => plural((n.billingToPractice.get(i) ?? []).length, 'location'),
  };
  for (const kind of KINDS) {
    const entities = state.kept[LISTS[kind]];
    $(`count-${kind}`).textContent = entities.length;
    $(`list-${kind}`).innerHTML = entities.map((e, i) => {
      const fields = Object.entries(e.values).map(([f, val]) => `<dt>${esc(f.split('.')[1])}</dt><dd>${esc(val)}</dd>`).join('');
      // The connections line only shows on narrow screens, where there are no lines between cards.
      return `<li data-kind="${kind}" data-i="${i}">${cardHtml(kind, e)}` +
        `<span class="links-line">${linkText[kind](i)} · ${plural(e.rows.length, 'row')}${e.issues ? ` · <em class="issues">${plural(e.issues, 'issue')}</em>` : ''}</span>` +
        `<dl>${fields}<dt>rows</dt><dd>${e.rows.join(', ')}</dd></dl></li>`;
    }).join('') || `<li class="empty"><span class="none">${NONE[kind]}</span></li>`;
  }
  $('graph').querySelectorAll('li[data-kind]').forEach((li) => {
    const kind = li.dataset.kind;
    const i = +li.dataset.i;
    li.onclick = (ev) => { if (!ev.target.closest('a, button, input, label')) select(kind, i); };
    li.onmouseenter = () => { state.hovered = { kind, i }; highlight(); };
    li.onmouseleave = () => { state.hovered = null; highlight(); };
  });
  drawLinks();
}


// Click pins a card (and opens its details); click again to unpin.
function select(kind, i) {
  state.selected = state.selected?.kind === kind && state.selected.i === i ? null : { kind, i };
  highlight();
}

// Everything connected to one card: provider → its locations → their billing, and back.
function connected({ kind, i }) {
  const n = neighbours();
  const lit = { provider: new Set(), practice: new Set(), billing: new Set() };
  lit[kind].add(i);
  if (kind === 'provider') (n.providerToPractice.get(i) ?? []).forEach((l) => lit.practice.add(l));
  if (kind === 'billing') (n.billingToPractice.get(i) ?? []).forEach((l) => lit.practice.add(l));
  if (kind === 'practice') {
    (n.practiceToProvider.get(i) ?? []).forEach((p) => lit.provider.add(p));
    (n.practiceToBilling.get(i) ?? []).forEach((b) => lit.billing.add(b));
  }
  if (kind === 'provider') lit.practice.forEach((l) => (n.practiceToBilling.get(l) ?? []).forEach((b) => lit.billing.add(b)));
  if (kind === 'billing') lit.practice.forEach((l) => (n.practiceToProvider.get(l) ?? []).forEach((p) => lit.provider.add(p)));
  return lit;
}

// Light up the hovered card's chain, or else the pinned card's. Only toggles classes; lines are drawn once.
function highlight() {
  const focus = state.hovered ?? state.selected;
  const lit = focus ? connected(focus) : null;
  $('graph').classList.toggle('focus', !!focus);
  $('graph').querySelectorAll('li[data-kind]').forEach((li) => {
    li.classList.toggle('lit', !!lit?.[li.dataset.kind].has(+li.dataset.i));
    li.classList.toggle('selected', state.selected?.kind === li.dataset.kind && state.selected.i === +li.dataset.i);
  });
  const svg = $('links');
  const { providerLocations, locationBilling } = state.kept;
  const on = [];
  svg.querySelectorAll(':scope > path').forEach((path, k) => {
    const [a, b] = k < providerLocations.length ? providerLocations[k] : locationBilling[k - providerLocations.length];
    const isLit = !!lit && (k < providerLocations.length ? lit.provider.has(a) && lit.practice.has(b) : lit.practice.has(a) && lit.billing.has(b));
    path.classList.toggle('lit', isLit);
    if (isLit) on.push(path);
  });
  // Raise lit lines above the rest (SVG draws in document order).
  const top = svg.querySelector('g.top');
  top?.replaceChildren(...on.map((path) => path.cloneNode()));
}

// Curves from the right edge of each card to the left edge of the card it connects to,
// providerLocations first, then locationBilling, in order, so highlight() can index them.
function drawLinks() {
  const graph = $('graph');
  const svg = $('links');
  if (!state.kept) return;
  if (getComputedStyle(svg).display === 'none') return highlight(); // narrow: no lines, but cards still light up
  const box = graph.getBoundingClientRect();
  const anchor = (li, side) => {
    const r = li.getBoundingClientRect();
    return [(side === 'right' ? r.right : r.left) - box.left + graph.scrollLeft, r.top + r.height / 2 - box.top + graph.scrollTop];
  };
  const curve = (from, to) => {
    if (!from || !to) return '<path/>';
    const [x1, y1] = anchor(from, 'right');
    const [x2, y2] = anchor(to, 'left');
    const mid = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}"/>`;
  };
  const [p, l, b] = KINDS.map((kind) => [...$(`list-${kind}`).children]);
  const { providerLocations, locationBilling } = state.kept;
  svg.setAttribute('width', graph.scrollWidth);
  svg.setAttribute('height', graph.scrollHeight);
  svg.innerHTML = providerLocations.map(([pi, li]) => curve(p[pi], l[li])).join('') +
    locationBilling.map(([li, bi]) => curve(l[li], b[bi])).join('') + '<g class="top"></g>';
  highlight();
}


new ResizeObserver(() => state.result && state.step === 'review' && drawLinks()).observe($('graph'));