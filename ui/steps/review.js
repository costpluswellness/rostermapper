import { $, esc, plural } from '../lib.js';
import { isDropped } from '../rostermapper.js';
import { state } from '../state.js';
import { go } from '../app.js';
import { entityCard, onCardClick, problemItem } from './validate.js';
// ─── 5 Review ───────────────────────────────────────────────
// The file's landing view: providers, locations and billing as a table or a graph, each card carrying
// its Standardize and Validate results (highlights, ✓ verified, problems with "Use"), and every issue
// below with a way to fix it.
export const KIND_LABEL = { missing: 'missing', format: 'invalid', invalid: 'per source', warning: 'check', default: 'note' };
const NONE = { provider: 'No provider', practice: 'No practice location', billing: 'No billing' };

export function renderReview() {
  const graph = state.reviewView === 'graph';
  $('graph').hidden = !graph;
  $('chains-wrap').hidden = graph;
  document.querySelectorAll('#review-view button').forEach((b) => b.classList.toggle('on', b.dataset.review === state.reviewView));
  $('review-checking').textContent = state.checking ? 'Checking…' : '';
  if (graph) renderPreview(); else renderChains();
  renderIssues();
}

// Each issue with what fixes it: a missing value → its field on Map; a value Standardize couldn't
// clean → Standardize; a source's suggestion → "Use". Dropped rows first: they won't be exported.
function renderIssues() {
  const flagged = state.result.records.filter((r) => r.issues.length).sort((a, b) => isDropped(b) - isDropped(a));
  const fix = (r, i) => {
    if (i.kind === 'missing') return ` <button class="textlink small" data-map="${esc(i.field)}" title="See ${esc(i.field)} on Map">mapping</button>`;
    if (i.kind === 'format') return ' <button class="textlink small" data-goto="standardize" title="Fix it by hand on Standardize">edit</button>';
    const c = state.checks.get(r.row)?.get(i.field)?.[0];
    return c?.suggestion !== undefined ? `<ul class="inline">${problemItem(i.field, r.values[i.field], c, [r.row])}</ul>` : '';
  };
  $('issues').innerHTML = '<tr><th>Row</th><th>Provider</th><th>Issues</th></tr>' + (flagged.slice(0, 500).map((r) => {
    const who = [r.values['provider.last_name'], r.values['provider.first_name']].filter(Boolean).join(', ') || (r.values['provider.npi'] ? `NPI ${r.values['provider.npi']}` : '');
    const row = isDropped(r) ? `${r.row} <span class="drop" title="Not exported">dropped</span>` : r.row;
    return `<tr><td class="muted nowrap">${row}</td><td class="nowrap">${esc(who)}</td><td>${r.issues.map((i) => `<div><span class="muted">${KIND_LABEL[i.kind]}</span> ${esc(i.field)}${i.kind === 'missing' && !i.drop ? '' : `: ${esc(i.message)}`}${fix(r, i)}</div>`).join('')}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">No issues.</td></tr>');
}

document.querySelectorAll('#review-view button').forEach((b) => (b.onclick = () => {
  state.reviewView = b.dataset.review;
  renderReview();
}));
$('step-review').addEventListener('click', (e) => {
  const m = e.target.closest('[data-map]');
  if (m) return showField(m.dataset.map);
  onCardClick(e, renderReview);
});

// Map, scrolled to one field's row and flashed.
function showField(field) {
  go('map');
  const tr = document.querySelector(`#mapped tr[data-field="${CSS.escape(field)}"]`);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center' });
  tr.classList.add('flash');
  setTimeout(() => tr.classList.remove('flash'), 1600);
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
    li.onclick = (ev) => { if (!ev.target.closest('a, button')) select(kind, i); };
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
  if (!state.kept || getComputedStyle(svg).display === 'none') return;
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