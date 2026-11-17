import { $ } from '../lib.js';
import { overrides, render, run } from '../app.js';
import { fieldLevel, schema } from '../rostermapper.js';
import { MAPPABLE_IDS, download, esc, fieldTip, oneLine, plural, shortHeader, specOf } from '../lib.js';
import { state } from '../state.js';
// ─── Mapping (a dialog over Review) ──────────────────────────────────────────────────
const ENTITY_TITLES = { provider: 'Provider', practice: 'Practice', billing: 'Billing', network: 'Network' };
const colBadge = (c) => `<span class="col">${c.letter}</span>` +
  (oneLine(c.header) ? `<span title="${esc(oneLine(c.header))}">${esc(shortHeader(c.header))}</span>` : '<span class="muted">(blank)</span>');

// ─── Candidates: the columns that could fill a field ────────
// From the matcher's candidates before any change made here (state.baseline), so the order holds
// still while picking: a header match scoring at least PILL_MIN, or a values-only guess on
// distinctive values. The column mapped now is always included.
const PILL_MIN = 0.35; // shown as pills in a field's row
const LIKELY_MIN = 0.2; // listed under "Likely" in the "any column" dropdown
const DISTINCT = new Set(['npi', 'tin', 'taxonomy', 'dea', 'email', 'url']);
const valuesOnly = (k) => k.why[0]?.startsWith('values only');

// [{ column, score, why, now (field it holds now) }], best first by baseline score.
function columnsFor(field, min = PILL_MIN) {
  const { mapping } = state.result;
  const holder = new Map(Object.entries(mapping).map(([f, a]) => [a.column, f]));
  const list = state.baseline.columns.flatMap((c) => {
    if (!oneLine(c.header)) return [];
    const k = c.candidates.find((x) => x.field === field && !x.override);
    if (!k || (valuesOnly(k) ? !DISTINCT.has(c.type) : k.score < min)) return [];
    return [{ column: c.index, score: k.score, why: k.why, now: holder.get(c.index) }];
  }).sort((a, b) => b.score - a.score || a.column - b.column);
  const cur = mapping[field];
  if (cur && !list.some((a) => a.column === cur.column)) list.unshift({ column: cur.column, score: null, why: ['picked here'], now: field });
  return list;
}

// Keep each collapsed row on one line: hide the lowest candidates that don't fit (never the
// selected one) and count them in "+N", which opens the row in place. Runs after each Map render
// and on resize.
function fitPills() {
  document.querySelectorAll('#mapped .pills').forEach((box) => {
    const more = box.querySelector('.pill.more');
    const cands = [...box.querySelectorAll('.pill.cand')];
    cands.forEach((p) => (p.hidden = false));
    if (box.classList.contains('open')) { more.hidden = false; more.textContent = 'less'; return; }
    let hidden = 0;
    const update = () => { more.hidden = !hidden; more.textContent = `+${hidden}`; };
    update();
    for (let i = cands.length - 1; i >= 0 && box.scrollWidth > box.clientWidth; i--) {
      if (cands[i].classList.contains('on')) continue;
      cands[i].hidden = true;
      hidden++;
      update();
    }
  });
}
let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => $('map-dialog').open && fitPills(), 100); });

// The action set on step 0 ('' = detect), kept in step with its select there.
function setAction(v) {
  state.action = v;
  $('action').value = v;
}

// Map a column to a field, releasing whatever else claimed the field. A column that another field
// holds moves over: that field is left empty, not handed the next best column.
function assign(field, column) {
  if (field === 'network.action_type') setAction(''); // a column's per-row actions replace a set one
  const from = Object.entries(state.result.mapping).find(([f, a]) => f !== field && a.column === column)?.[0];
  if (from) { releaseField(from); delete state.constants[from]; state.cleared.add(from); }
  releaseField(field);
  state.cleared.delete(field);
  delete state.constants[field]; // a column wins over a typed value
  state.edits[oneLine(state.result.columns[column].header)] = field;
  run();
}

// Leave a field without a column: drop changes that gave it one, and keep matching off it.
function clearField(field) {
  releaseField(field);
  state.cleared.add(field);
  run();
}

export function renderMap() {
  const { columns, mapping, action } = state.result;
  const byColumn = new Map(Object.values(mapping).map((a) => [a.column, a]));

  // A value set for all rows also marks its field cleared; count it once.
  const edits = Object.keys(state.edits).length + new Set([...state.cleared, ...Object.keys(state.constants)]).size;
  $('edits-note').textContent = edits ? `${plural(edits, 'change')} made here.` : '';
  $('clear-edits').hidden = !edits;
  const fromHere = (c) => oneLine(c.header) in state.edits;
  const suggestions = new Map(state.result.suggestions.map((s) => [s.field, s]));
  const suggestedColumns = new Map(state.result.suggestions.map((s) => [s.column, s]));
  const sugTip = (s) => `Suggested: column ${columns[s.column].letter} "${oneLine(columns[s.column].header)}" (${s.score.toFixed(2)}): ${s.why.join('; ')}. Click to use it.`;

  // One compact table per entity, one row per field in schema order. Each row is a line of grey
  // pills, one per column that could fill the field (column title, its letter, its score), in a
  // fixed order. The mapped one is highlighted; click another to map it instead, in place. On hover,
  // the mapped pill shows × (leave the field empty) and "…" opens a dropdown of every column.
  // "+N" opens the row to show every candidate. A few values of the mapped column sit underneath.
  // Fields marked hidden in the schema get a row only when mapped or suggested.
  const actions = new Set(action.rows);
  const PILL_CHARS = 22;
  const pillName = (c) => { const t = oneLine(c.header); return t.length > PILL_CHARS ? `${t.slice(0, PILL_CHARS - 1).trimEnd()}…` : t; };
  const candTip = (field, a, on) => {
    const c = columns[a.column];
    return `${c.letter} · ${oneLine(c.header)}` + (a.score == null ? '' : `\nScore ${a.score.toFixed(2)} for ${field}: ${a.why.join('; ')}`) +
      (on && field === 'network.action_type' ? `\nRows: ${state.result.action.why}` : '') +
      (on ? '\nMapped. × leaves the field empty.' : (a.now ? `\nMapped to ${a.now} now; picking it here moves it and leaves ${a.now} empty.` : '') + '\nClick to map it.');
  };
  // Values instead of columns. "…" opens an editor in place: a date box with the calendar open
  // (dates), a text box, or ADD/UPDATE/TERM (the action), plus "column ▾" to pick any column. A set
  // value shows as the highlighted pill, marked "=": click to change, × to remove. The action
  // shows that way too when no column holds it or it was set on step 0.
  const actionValue = (id) => id === 'network.action_type' && (!mapping[id] || action.source === 'option');
  const constant = (id) => !mapping[id] && state.constants[id];
  const columnOptions = (id) => {
    const cur = mapping[id]?.column;
    const label = (c) => `${c.letter} · ${shortHeader(c.header)}`;
    const likely = columnsFor(id, LIKELY_MIN).filter((a) => a.column !== cur);
    const opt = (c, extra = '') => `<option value="${c.index}" title="${esc(oneLine(c.header))}">${esc(label(c) + extra)}</option>`;
    return '<option value="">column ▾</option>' +
      (likely.length ? `<optgroup label="Likely">${likely.map((a) => opt(columns[a.column], ` · ${a.score.toFixed(2)}`)).join('')}</optgroup>` : '') +
      `<optgroup label="All columns">${columns.filter((c) => oneLine(c.header) && c.index !== cur && !likely.some((a) => a.column === c.index)).map((c) => opt(c)).join('')}</optgroup>`;
  };
  const editor = (id) => {
    const date = specOf(id).type === 'date';
    const entry = id === 'network.action_type'
      ? `<select class="const" data-const="${id}">${['', 'ADD', 'UPDATE', 'TERM'].map((v) => `<option value="${v}"${v === state.action ? ' selected' : ''}>${v || 'detect'}</option>`).join('')}</select>`
      : `<input class="const${date ? ' date' : ''}" data-const="${id}" type="${date ? 'date' : 'text'}" value="${esc(state.constants[id] ?? '')}"${date ? '' : ' placeholder="value for all rows"'}>`;
    return `<span class="editor" data-editor="${id}">${entry}<select class="colpick" data-colpick="${id}">${columnOptions(id)}</select></span>`;
  };
  const valuePill = (id) => {
    if (state.editingConst === id) return editor(id);
    const text = actionValue(id) ? action.action : constant(id);
    if (!text) return '';
    const removable = actionValue(id) ? !!state.action : true;
    const tip = actionValue(id) ? `${action.why}.` : 'Same value for every row.';
    return `<button class="pill on value" data-edit-const="${id}" title="${esc(`${tip} Click to change.`)}"><span class="lt">=</span>${esc(text)}` +
      `${removable ? `<span class="x" data-clear-const="${id}" title="Remove">×</span>` : ''}</button>`;
  };
  // The row's last control: "…" to enter a value or pick any column, on hover (always shown on a
  // field with nothing in it); on a required field with no column, value or candidate, a ✎ instead.
  const control = (id, required, list) => {
    if (state.editingConst === id) return '';
    const empty = !mapping[id] && !list.length && !constant(id) && !actionValue(id);
    if (empty && required) return `<button class="pill pen" data-edit="${id}" title="Enter a value, or pick any column">✎</button>`;
    return `<button class="pill any" data-edit="${id}" title="Enter a value, or pick any column">…</button>`;
  };
  const pills = (id, required = false) => {
    const cur = actionValue(id) ? undefined : mapping[id]?.column;
    const list = columnsFor(id);
    const open = state.expandedRows.has(id);
    const cands = list.map((a) => {
      const c = columns[a.column];
      const on = a.column === cur;
      // A column with no values in any row: italic and amber, so a mapping that brings nothing shows.
      const empty = !c.filled;
      return `<button class="pill cand${on ? ' on' : ''}${empty ? ' nodata' : ''}" data-pick="${id}" data-col="${a.column}" title="${esc(candTip(id, a, on) + (empty ? '\nThis column is empty: no row has a value.' : ''))}">` +
        `<span class="lt">${c.letter}</span>${esc(pillName(c))}${a.score == null ? '' : `<span class="sc">${a.score.toFixed(2)}</span>`}` +
        `${on ? `<span class="x" data-clear="${id}" title="Leave ${id} empty">×</span>` : ''}</button>`;
    }).join('');
    return `<div class="pills${open ? ' open' : ''}">${valuePill(id)}${cands}<button class="pill more" data-expand="${id}" hidden></button>` +
      control(id, required, list) + '</div>';
  };
  const fieldName = (entity, name) => `<span class="tip" title="${esc(`${entity}.${name}\n${fieldTip(`${entity}.${name}`)}`)}"><b>${name.replace(/expiration/g, 'exp')}</b></span>`;
  $('mapped').innerHTML = Object.entries(schema.fields).map(([entity, fields]) => {
    const names = Object.keys(fields).filter((name) => !fields[name].input);
    const required = (name) => (fields[name].required ?? []).filter((x) => actions.has(x));
    const level = (name) => fieldLevel(fields[name], actions);
    // Fields marked hidden that would show only because of the toggle: no column, no suggestion, optional.
    const hideable = names.filter((name) => { const id = `${entity}.${name}`; return fields[name].hidden && !mapping[id] && !suggestions.has(id) && level(name) === 'optional'; });
    const open = state.showHidden.has(entity);
    const shown = (name) => open || !hideable.includes(name);
    const rows = names.filter(shown).map((name) => {
      const id = `${entity}.${name}`;
      const a = mapping[id];
      // The action comes from its column when mapped; otherwise from the sheet or file name.
      // Under the pills: the mapped column's values, the value typed for every row, or why the
      // field is empty. A required field with no column gets a faint input to type that value.
      const note = (text, cls = '') => `<div class="values ${cls}">${text}</div>`;
      let under;
      if (a && !actionValue(id)) {
        const c = columns[a.column];
        under = c.samples.length ? note(c.samples.slice(0, 3).map(esc).join(' · ')) : '';
      } else if (constant(id)) {
        // Only a value that can't be cleaned gets a word.
        const issue = state.result.records[0]?.issues.find((i) => i.field === id && i.kind === 'format');
        under = issue ? note(esc(issue.message), 'bad') : '';
      } else if (actionValue(id)) under = '';
      else if (level(name) === 'required') under = note(`missing: required for ${required(name).join(', ')}`, 'bad');
      else under = state.cleared.has(id) ? note('left empty here') : '';
      const cls = a || constant(id) || actionValue(id) ? '' : level(name) === 'required' && id !== 'network.action_type' ? 'missing-required' : 'empty';
      return `<tr class="${cls}" data-field="${id}"><td>${fieldName(entity, name)}</td><td class="cands">${pills(id, level(name) === 'required')}${under}</td></tr>`;
    });
    const n = names.filter((name) => mapping[`${entity}.${name}`]).length;
    return `<section class="fieldset ${entity}"><h3>${ENTITY_TITLES[entity] ?? entity} <span class="muted">${n} of ${names.length} mapped</span></h3>` +
      `<div class="scroll"><table>${rows.join('') || '<tr><td class="muted">No fields mapped.</td></tr>'}</table></div>` +
      (hideable.length ? `<p class="others"><button class="textlink" data-hidden="${entity}" title="${esc(hideable.join(', '))}">${open ? 'hide' : 'show'} ${plural(hideable.length, 'hidden field')}</button></p>` : '') +
      `</section>`;
  }).join('');

  // Columns no field took, as chips in three groups: suggested, no match, ignored. Numbered or
  // repeated headers ("Alt City 1" … "Alt City 4") fold into one chip that opens on click. Hover a
  // chip for why and a few values; click a column to pick its field.
  const rest = columns.filter((c) => !byColumn.has(c.index));
  // Columns of the extra address blocks a transform would split out, whatever their status.
  const extra = new Set(state.result.transforms.flatMap((t) => t.related));
  const reason = (c) => {
    if (suggestedColumns.has(c.index)) return sugTip(suggestedColumns.get(c.index));
    if (c.status === 'ignored') return `Ignored: ${c.candidates[0].override ? (fromHere(c) ? 'changed here' : 'mapping file') : c.candidates[0].why.join('; ')}`;
    const top = c.candidates.find((k) => k.field !== 'ignore');
    if (top) return `No match: closest is ${top.field} (${top.score.toFixed(2)}), which went to another column or scored too low`;
    return `No match: ${c.rejected.length ? c.rejected.map((r) => `${r.field}: ${r.why}`).join('; ') : 'no alias matches this header'}`;
  };
  const tip = (c) => `${c.letter} · ${oneLine(c.header) || '(blank)'}\n${reason(c)}${c.samples.length ? `\nValues: ${c.samples.slice(0, 3).join(' · ')}` : '\nNo values'}`;
  // A column's likely field, for the attached "→ field" pill: its best candidate (header match at
  // least 0.5, or distinctive values), even when another column holds that field now.
  const likely = (c) => {
    if (extra.has(c.index) || suggestedColumns.has(c.index)) return suggestedColumns.get(c.index);
    const k = c.candidates.find((x) => x.field !== 'ignore');
    return k && (valuesOnly(k) ? DISTINCT.has(c.type) : k.score >= 0.5) ? { field: k.field, column: c.index, score: k.score, why: k.why } : undefined;
  };
  const hintPill = (c) => {
    const k = likely(c);
    if (!k) return '';
    const holder = mapping[k.field] ? ` ${columns[mapping[k.field].column].letter} holds it now.` : '';
    return `<button class="pill hint" data-assign="${k.field}" data-col="${c.index}" title="${esc(`Map to ${k.field} (${k.score.toFixed(2)}): ${k.why.join('; ')}.${holder}`)}">→ ${esc(k.field)}<span class="sc">${k.score.toFixed(2)}</span></button>`;
  };
  const chip = (c) => oneLine(c.header)
    ? `<span class="chipwrap"><button class="chip${suggestedColumns.has(c.index) ? ' suggest' : ''}" data-column="${c.index}" title="${esc(tip(c))}"><span class="col">${c.letter}</span>${esc(shortHeader(c.header))}</button>${hintPill(c)}</span>`
    : `<span class="chip" title="${esc(tip(c))}"><span class="col">${c.letter}</span><span class="muted">(blank)</span></span>`;
  // Same header once numbers and punctuation are dropped: "Alt City 2", "Alt City 3" and
  // "Board Name1", "Board Name 2" are families.
  const familyKey = (c) => oneLine(c.header).toLowerCase().replace(/\d+/g, ' ').replace(/[^a-z]+/g, ' ').trim();
  const familyLabel = (members) => {
    const headers = members.map((c) => oneLine(c.header));
    if (new Set(headers).size === 1) return shortHeader(headers[0]);
    // The first number that differs between members becomes a range: "Alt City 1–4". When some
    // members have no number ("Alt Office Address", "Alt Office Address 2"), show the first header.
    const nums = headers.map((h) => h.match(/\d+/g) ?? []);
    if (new Set(nums.map((n) => n.length)).size > 1) return `${shortHeader(headers[0])} …`;
    const at = nums[0].findIndex((_, i) => new Set(nums.map((n) => n[i])).size > 1);
    const vals = nums.map((n) => +n[at]).filter((n) => !Number.isNaN(n));
    let k = -1;
    const label = at < 0 ? headers[0] : headers[0].replace(/\d+/g, (m) => (++k === at ? `${Math.min(...vals)}–${Math.max(...vals)}` : m));
    return shortHeader(label);
  };
  const chips = (cols) => {
    const families = new Map();
    for (const c of cols) { const key = oneLine(c.header) ? familyKey(c) : `#blank${c.index}`; families.set(key, [...(families.get(key) ?? []), c]); }
    return [...families].map(([key, members]) => {
      if (members.length < 2) return chip(members[0]);
      const open = state.openFamilies.has(key);
      const list = members.map((c) => `${c.letter} ${oneLine(c.header)}`).join('\n');
      return `<button class="chip fam" data-family="${esc(key)}" title="${esc(`${open ? 'Fold' : 'List'} these ${members.length} columns:\n${list}`)}">${open ? '▾' : '▸'} ` +
        `<span class="col">${members[0].letter}…${members.at(-1).letter}</span>${esc(familyLabel(members))} <span class="muted">×${members.length}</span></button>` +
        (open ? members.map(chip).join('') : '');
    }).join('');
  };
  const plain = rest.filter((c) => !suggestedColumns.has(c.index) && !extra.has(c.index));
  const groups = [
    ['Suggested', rest.filter((c) => suggestedColumns.has(c.index))],
    ['No match', plain.filter((c) => c.status !== 'ignored')],
    ['Other addresses (need a transform)', rest.filter((c) => !suggestedColumns.has(c.index) && extra.has(c.index))],
    ['Ignored', plain.filter((c) => c.status === 'ignored')],
  ].filter(([, cols]) => cols.length);
  $('unmapped-title').textContent = `Columns not mapped (${rest.length})` + (groups.length ? `: ${groups.map(([name, cols]) => `${cols.length} ${name.replace(/ \(.*/, '').toLowerCase()}`).join(' · ')}` : '');
  $('unmapped').innerHTML = groups.map(([name, cols]) =>
    `<div class="colgroup"><h4>${name} <span class="muted">${cols.length}</span></h4><div class="chips">${chips(cols)}</div></div>`).join('') ||
    '<p class="muted">Every column is mapped.</p>';

  document.querySelectorAll('#map-dialog [data-column]').forEach((b) => (b.onclick = () => pickField(b, columns[+b.dataset.column])));
  document.querySelectorAll('#map-dialog [data-pick]').forEach((b) => (b.onclick = (e) => {
    if (e.target.closest('[data-clear]')) return clearField(b.dataset.pick);
    if (!b.classList.contains('on')) assign(b.dataset.pick, +b.dataset.col);
  }));
  document.querySelectorAll('#map-dialog [data-edit]').forEach((b) => (b.onclick = () => { state.editingConst = b.dataset.edit; renderMap(); }));
  document.querySelectorAll('#map-dialog [data-edit-const]').forEach((b) => (b.onclick = (e) => {
    const id = b.dataset.editConst;
    if (e.target.closest('[data-clear-const]')) {
      if (id === 'network.action_type') setAction('');
      else { delete state.constants[id]; state.cleared.delete(id); }
      return run();
    }
    state.editingConst = id;
    renderMap();
  }));
  document.querySelectorAll('#map-dialog [data-editor]').forEach((box) => {
    const id = box.dataset.editor;
    const entry = box.querySelector('[data-const]');
    const colpick = box.querySelector('[data-colpick]');
    const cancel = () => { if (state.editingConst === id) { state.editingConst = null; renderMap(); } };
    // Leaving the editor (not just moving between its two controls) cancels it.
    box.addEventListener('focusout', () => setTimeout(() => { if (!box.contains(document.activeElement)) cancel(); }, 0));
    box.onkeydown = (e) => {
      if (e.key === 'Escape') cancel();
      if (e.key === 'Enter' && e.target === entry) entry.dispatchEvent(new Event('change'));
    };
    entry.onchange = () => {
      const v = entry.value.trim();
      state.editingConst = null;
      if (id === 'network.action_type') { setAction(v); return run(); }
      if (!v) return renderMap();
      releaseField(id); // the value stands in for a column
      state.cleared.add(id);
      state.constants[id] = v;
      run();
    };
    colpick.onchange = () => { state.editingConst = null; if (colpick.value) assign(id, +colpick.value); else renderMap(); };
    entry.focus();
    try { entry.showPicker(); } catch {} // the calendar (or the action list) opens right away when the browser allows it
  });
  document.querySelectorAll('#map-dialog [data-expand]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.expand;
    if (!state.expandedRows.delete(id)) state.expandedRows.add(id);
    renderMap();
  }));
  document.querySelectorAll('#map-dialog [data-assign]').forEach((b) => (b.onclick = () => assign(b.dataset.assign, +b.dataset.col)));
  fitPills();
  document.querySelectorAll('#map-dialog [data-hidden]').forEach((b) => (b.onclick = () => {
    const entity = b.dataset.hidden;
    if (!state.showHidden.delete(entity)) state.showHidden.add(entity);
    renderMap();
  }));
  document.querySelectorAll('#map-dialog [data-family]').forEach((b) => (b.onclick = () => {
    const key = b.dataset.family;
    if (!state.openFamilies.delete(key)) state.openFamilies.add(key);
    renderMap();
  }));
}

// Swap a "change" link for a dropdown; on pick, record the edit and recalculate. Options are
// [value, label] or [value, label, tooltip]; { group, options } makes an <optgroup>.
function dropdown(button, options, value, apply) {
  const select = document.createElement('select');
  const option = ([v, label, tip]) => `<option value="${esc(v)}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(label)}</option>`;
  select.innerHTML = options.map((o) => (Array.isArray(o) ? option(o) : o.options.length ? `<optgroup label="${esc(o.group)}">${o.options.map(option).join('')}</optgroup>` : '')).join('');
  select.value = value;
  button.replaceWith(select);
  select.focus();
  select.onchange = () => { apply(select.value); run(); };
  select.onblur = () => render();
}

// Clear edits that send some other header to this field, so the new choice wins alone.
const releaseField = (field) => { for (const [h, f] of Object.entries(state.edits)) if (f === field) delete state.edits[h]; };

// An unmapped column's dropdown: every field, ignore, or back to automatic.
function pickField(button, column) {
  const header = oneLine(column.header);
  const { mapping, columns } = state.result;
  const likely = column.candidates.filter((k) => k.field !== 'ignore' && !k.override && k.score >= LIKELY_MIN);
  const options = [['auto', 'automatic'], ['ignore', 'ignore this column'],
    { group: 'Likely', options: likely.map((k) => [k.field, `${k.field} · ${k.score.toFixed(2)}${mapping[k.field] ? ` (now ${columns[mapping[k.field].column].letter})` : ''}`, k.why.join('; ')]) },
    { group: 'All fields', options: MAPPABLE_IDS.filter((f) => !likely.some((k) => k.field === f)).map((f) => [f, f]) }];
  dropdown(button, options, state.edits[header] ?? (column.status === 'ignored' ? 'ignore' : 'auto'), (v) => {
    if (v === 'auto') delete state.edits[header];
    else { if (v !== 'ignore') releaseField(v); state.edits[header] = v; }
  });
}

$('clear-edits').onclick = () => { state.edits = {}; state.cleared.clear(); state.constants = {}; run(); };
$('download-mapping').onclick = () => {
  const cell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['column,field', ...Object.entries(overrides()).map(([h, f]) => `${cell(h)},${f}`)];
  download(lines.join('\n') + '\n', 'text/csv', `${state.name.replace(/\.\w+$/, '')} mapping.csv`);
};