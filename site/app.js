// Roster Mapper UI, opened by the CLI (node dist/cli.js [roster.xlsx]). One screen per step:
// 0 Upload → (1 Transform, not built) → 2 Map → 3 Standardize → 4 Validate → 5 Review → 6 Export.
// Files are read in the browser and Roster Mapper runs here, so every change recalculates live.
import { addressLine, automap, cleanValue, outputFields, outputOrder, outputName, censusChecks, detectHeaderRow, fieldLevel, groupEntities, isBlank, isFreeText, isStandardized, nppesBillingChecks, nppesProviderChecks, standardRule, parseMapping, readWorkbook, schema, toCsv } from './rostermapper.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const show = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v));
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// Column names shown on the Map step, cut so a long header doesn't widen the tables and dropdowns.
// The full name stays in the tooltip.
const MAX_HEADER = 40;
const shortHeader = (s) => { const t = oneLine(s); return t.length > MAX_HEADER ? `${t.slice(0, MAX_HEADER - 1).trimEnd()}…` : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const FIELD_IDS = Object.entries(schema.fields).flatMap(([group, fields]) => Object.keys(fields).map((name) => `${group}.${name}`));
const STEPS = ['upload', 'map', 'standardize', 'validate', 'review', 'export'];
// Hover text for a field name: what it holds (first sentence) and how its values are standardized.
const specOf = (id) => { const [g, n] = id.split('.'); return schema.fields[g][n]; };
// Fields typed on Upload (contract ID, sender email): one value for every row, never a column's, and
// left out of Map, Standardize and Validate. Hidden, so the export has them only when filled.
const MAPPABLE_IDS = FIELD_IDS.filter((f) => !specOf(f).input);
const fieldTip = (id) => { const f = specOf(id); return `${f.description.split('. ')[0].replace(/\.$/, '')}.\n${standardRule(id, f.type, f.values)}.`; };

// Upload's Checks, saved in this browser (see loadSources). Above `state`, which reads them.
const SOURCES_KEY = 'rostermapper.sources';
const SOURCE_NAME = { nppes: 'NPPES', census: 'US Census geocoder' };

const state = {
  step: 'upload',
  name: '', sheets: [], sheet: '', rows: [], headerRow: 0, autoRow: 0, action: '', category: '', viewRaw: false,
  mapping: null, // { name, overrides, errors }: the uploaded mapping file
  edits: {}, // header → field or "ignore": changes made on the Map step, applied on top of the file
  cleared: new Set(), // Map: fields set to "no column" here; matching leaves them empty
  constants: {}, // Map: field → one value for every row, set from the "…" dropdown instead of a column
  editingConst: null, // Map: the field whose value pill is an input right now
  expandedRows: new Set(), // Map: fields whose row shows every candidate pill, wrapped
  result: null, raw: null, entities: null, selected: null, hovered: null,
  expanded: new Set(), // Standardize and Validate: tables showing every row, not just the first 20
  openFamilies: new Set(), // Map: folded groups of numbered columns the user opened
  showHidden: new Set(), // Map: entities whose hidden fields are shown
  lookups: { nppes: new Map(), census: new Map() }, // Validate: answers by NPI and by address line
  checks: new Map(), // Validate: row → field → its checks, worst first
  accepted: new Map(), // Validate: row → field → { value, source, auto } for accepted suggestions
  declined: new Set(), // Validate: "row|field" of Census changes the user undid; not applied again
  showChanges: new Set(), // Validate: cards whose Census changes are listed
  fixes: new Map(), // Standardize: row → field → value typed over the cleaned one (✎)
  fixing: null, // Standardize: "kind|field|rows" of the cell being edited
  checking: false, onlyProblems: false, byRow: new Map(), before: new Map(),
  reviewView: 'table', // Review: 'table' or 'graph'
  checked: false, // Validate: lookups have run for this sheet
  sources: loadSources(), // Upload's Checks: { nppes, census }, true when that lookup may run
  effectiveDate: '', // Upload: YYYY-MM-DD for rows whose effective date is blank
  inputs: {}, // Upload: input field id → the value typed for every row (contract ID, sender email)
};

// ─── Checks: which lookups may send data out ────────────────
// Remembered in this browser; --no-nppes / --no-census override for the session. Storage can be
// missing or throw (private windows): then both are on.
function loadSources() {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? '{}');
    return { nppes: saved.nppes !== false, census: saved.census !== false };
  } catch { return { nppes: true, census: true }; }
}
function setSource(kind, on) {
  state.sources[kind] = on;
  try { localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources)); } catch { /* not remembered */ }
  $(`use-${kind}`).checked = on;
  if (state.result) run(); // hides or shows that source's checks
  // Turned on with Validate already run: look this source up now (the CLI's server keeps earlier answers).
  if (on && state.checked && !state.checking) runChecks([kind]);
}
for (const kind of ['nppes', 'census']) {
  $(`use-${kind}`).checked = state.sources[kind];
  $(`use-${kind}`).onchange = (e) => setSource(kind, e.target.checked);
}

// ─── How it works ───────────────────────────────────────────
// One dialog for every step; it opens with the current step's section marked and in view.
$('how').onclick = () => {
  let on;
  $('how-dialog').querySelectorAll('[data-how]').forEach((s) => s.classList.toggle('on', s.dataset.how === state.step) && (on = s));
  $('how-dialog').showModal();
  on?.scrollIntoView({ block: 'nearest' });
};
$('how-dialog').onclick = (e) => { if (e.target === $('how-dialog')) $('how-dialog').close(); }; // click outside closes

// ─── Steps ──────────────────────────────────────────────────
function go(step) {
  if (step !== 'upload' && !state.result) return;
  state.step = step;
  for (const s of STEPS) $(`step-${s}`).hidden = s !== step;
  // Links, not buttons, so a portal's button styles don't turn the step bar into a row of buttons.
  $('steps').querySelectorAll('a[data-step]').forEach((a) => {
    a.toggleAttribute('aria-current', a.dataset.step === step);
    a.toggleAttribute('aria-disabled', a.dataset.step !== 'upload' && !state.result);
  });
  const i = STEPS.indexOf(step);
  $('back').disabled = i === 0;
  $('next').disabled = i === STEPS.length - 1 || !state.result;
  $('map-links').hidden = step !== 'map' || !state.result;
  render();
  // Lookups start the first time Validate opens for a sheet; "Run checks again" repeats them.
  if (step === 'validate' && state.result && !state.checked) { state.checked = true; runChecks(); }
}
$('steps').querySelectorAll('a[data-step]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.dataset.step); }));
$('back').onclick = () => go(STEPS[STEPS.indexOf(state.step) - 1]);
$('next').onclick = () => go(STEPS[STEPS.indexOf(state.step) + 1]);

// ─── Loading ────────────────────────────────────────────────
// The CLI passes the files and flags it was given; with none, the user starts at Upload.
async function boot() {
  const session = await (await fetch('session')).json();
  state.action = session.action ?? '';
  state.category = session.category ?? ''; // from --category; not shown, written into the export
  state.effectiveDate = session.effectiveDate ?? '';
  $('action').value = state.action;
  $('effective-date').value = state.effectiveDate;
  state.inputs = { ...session.inputs };
  document.querySelectorAll('[data-input]').forEach((el) => (el.value = state.inputs[el.dataset.input] ?? ''));
  // --no-nppes / --no-census win for this session; the boxes still change them (and save).
  for (const kind of ['nppes', 'census']) if (session[kind] === false) { state.sources[kind] = false; $(`use-${kind}`).checked = false; }
  if (session.mappingName) loadMapping(session.mappingName, await (await fetch('mapping')).arrayBuffer());
  // The CLI sends the roster already read and SSN-redacted, never the raw file.
  const revive = (_, v) => (v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v);
  if (session.name) loadSheets(session.name, JSON.parse(await (await fetch('file')).text(), revive), session.sheet, session.headerRow);
  else go('upload');
}
boot().catch((e) => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="rm-note">Could not start: ${esc(e.message)}. Is the CLI still running?</p>`); });

$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) loadFile(f.name, await f.arrayBuffer()); };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f.name, await f.arrayBuffer());
};
$('mapping').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) loadMapping(f.name, await f.arrayBuffer());
};
$('mapping-clear').onclick = () => { state.mapping = null; $('mapping').value = ''; run(); renderUpload(); };
$('action').onchange = (e) => { state.action = e.target.value; run(); };
$('hdr-reset').onclick = () => setHeaderRow(state.autoRow);
$('effective-date').onchange = (e) => { state.effectiveDate = e.target.value; run(); };
document.querySelectorAll('[data-input]').forEach((el) => (el.onchange = () => { state.inputs[el.dataset.input] = el.value.trim(); run(); }));
// Standardize: view the values as written, for comparison. Cleaned values always move forward.
document.querySelectorAll('#step-standardize .view-switch button').forEach((b) => (b.onclick = () => {
  state.viewRaw = b.dataset.view === 'raw';
  document.querySelectorAll('#step-standardize .view-switch button').forEach((x) => x.classList.toggle('on', x === b));
  renderStandardize();
}));

// readWorkbook removes SSNs as it reads, so they never reach the page's state or screen.
const loadFile = (name, bytes) => loadSheets(name, readWorkbook(bytes));

function loadSheets(name, sheets, sheet, headerRow) {
  state.name = name;
  state.sheets = sheets.filter((s) => s.rows.length);
  document.title = `${name} · Roster Mapper`;
  $('filename').textContent = name;
  $('filename').hidden = false;
  $('drop').classList.add('loaded');
  $('private-note').hidden = true;
  $('drop-title').textContent = name;
  $('drop-hint').textContent = 'drop or click to replace';
  // Every sheet with data, as buttons: name and data-row count.
  $('sheets').innerHTML = state.sheets.map((s) => {
    const n = s.rows.slice(detectHeaderRow(s.rows) + 1).filter((r) => r?.some((c) => !isBlank(c))).length;
    return `<button data-sheet="${esc(s.name)}">${esc(s.name)}<small>${plural(n, 'row')}</small></button>`;
  }).join('');
  $('sheets').hidden = state.sheets.length < 2; // one sheet: nothing to pick; its row count goes in the drop bar
  $('sheets').querySelectorAll('button').forEach((b) => (b.onclick = () => pickSheet(b.dataset.sheet)));
  const first = state.sheets.find((s) => s.name === sheet) ?? state.sheets[0];
  if (!first) return void ($('drop-hint').textContent = 'This file has no data. Drop or choose another.');
  if (state.sheets.length === 1) $('drop-hint').textContent = `${$('sheets').querySelector('small').textContent} · drop or click to replace`;
  pickSheet(first.name, headerRow);
}

function loadMapping(name, bytes) {
  const rows = readWorkbook(bytes)[0]?.rows ?? [];
  state.mapping = { name, ...parseMapping(rows) };
  run();
}

function pickSheet(name, headerRow) {
  state.sheet = name;
  state.accepted = new Map(); // accepted suggestions belong to one sheet's rows
  state.declined = new Set();
  state.fixes = new Map(); // and so do values fixed by hand
  state.checked = false;
  $('sheets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.sheet === name));
  const sheet = state.sheets.find((s) => s.name === name);
  state.rows = sheet.rows;
  state.autoRow = detectHeaderRow(state.rows);
  setHeaderRow(headerRow ?? state.autoRow);
}

function setHeaderRow(r) {
  state.headerRow = Math.max(0, Math.min(r, state.rows.length - 1));
  run();
}

// Recalculate everything from the current choices.
function run() {
  if (!state.rows.length) return go(state.step);
  const options = {
    headerRow: state.headerRow, fileName: state.name, sheetName: state.sheet,
    overrides: overrides(), unmapped: [...state.cleared], constants: { ...state.constants, ...state.inputs }, ...(state.effectiveDate && { effectiveDate: state.effectiveDate }), ...(state.action && { action: state.action }), ...(state.category && { category: state.category }),
  };
  state.result = automap(state.rows, options); // always cleaned: these values move forward
  // The mapping before any change made on the Map step: its scores order each row's pills, so
  // picking one doesn't reshuffle them. Recomputed only when the sheet or the file's mapping changes.
  const baseKey = JSON.stringify([state.name, state.sheet, state.headerRow, state.action, state.category, state.mapping?.name ?? '']);
  if (state.baseKey !== baseKey) {
    state.baseline = Object.keys(state.edits).length || state.cleared.size ? automap(state.rows, { ...options, overrides: state.mapping?.overrides ?? {}, unmapped: [] }) : state.result;
    state.baseKey = baseKey;
  }
  state.raw = null; // as written, only for Standardize's "As written" view: computed when asked (see rawRecords)
  state.options = options;
  applyFixes();
  applyValidation(); // accepted suggestions, and failures from Validate's checks, as issues
  state.byRow = new Map(state.result.records.map((r, i) => [r.row, { clean: r, get raw() { return rawRecords()[i]; } }]));
  state.entities = groupEntities(state.result.records);
  state.selected = state.hovered = null;
  go(state.step);
}

// The records as written, uncleaned. Half the work of run(), so done only when the view asks.
function rawRecords() {
  state.raw ??= automap(state.rows, { ...state.options, clean: false });
  return state.raw.records;
}

// The mapping file's overrides with the Map step's changes on top.
const overrides = () => ({ ...state.mapping?.overrides, ...state.edits });

function render() {
  renderUpload();
  renderBanner();
  if (!state.result) return;
  ({ map: renderMap, standardize: renderStandardize, validate: renderValidate, review: renderReview, export: renderExport })[state.step]?.();
}

// A one-line notice under the step bar when the sheet likely needs a transform (several addresses
// per row, …). Detection only: the Transform step isn't built yet.
function renderBanner() {
  const hints = state.result?.transforms ?? [];
  const banner = $('transform-banner');
  banner.hidden = !hints.length;
  if (!hints.length) return;
  const { columns } = state.result;
  banner.innerHTML = hints.map((t) => `<b>Likely needs a transform.</b> ${esc(t.message)}`).join('<br>');
  banner.title = hints.map((t) => `Address blocks, by column: ${t.columns.map((i) => `${columns[i].letter} ${oneLine(columns[i].header)}`).join(', ')}`).join('\n');
}

// ─── 0 Upload ───────────────────────────────────────────────
function renderUpload() {
  // Mapping file: its name on the button; only problems get a line of their own.
  const m = state.mapping;
  $('mapping-pick').firstChild.textContent = m ? m.name : 'Load…';
  $('mapping-pick').title = m ? `${plural(Object.keys(m.overrides).length, 'override')}. Click to load another.` : 'A CSV of column,field lines that override matching for specific headers';
  $('mapping-clear').hidden = !m;
  const problems = m ? [...m.errors, ...(state.result?.unusedOverrides.length ? [`no column named ${state.result.unusedOverrides.map((h) => `"${h}"`).join(', ')}`] : [])] : [];
  $('mapping-note').hidden = !problems.length;
  $('mapping-note').innerHTML = problems.map((e) => `<span class="warn">${esc(m.name)}: ${esc(e)}</span>`).join('<br>');
  if (!state.result) return;
  // "Auto-detect (ADD)": what detection found, with why on hover.
  const { action, why } = state.result.action;
  $('action').options[0].textContent = `Auto-detect (${action})`;
  $('action').title = state.action ? '' : `Detected ${action}: ${why}`;
  // The header row: detected, or the row clicked in the preview below.
  const auto = state.headerRow === state.autoRow;
  $('hdr-caption').textContent = auto
    ? `Header: row ${state.headerRow + 1} (detected) · click a row to change`
    : `Header: row ${state.headerRow + 1} · detected was row ${state.autoRow + 1}`;
  $('hdr-reset').hidden = auto;
  $('raw-wrap').hidden = false;
  // Every row detection looked at (detectHeaderRow scans 30), so any of them can be picked.
  const top = state.rows.slice(0, Math.max(30, state.headerRow + 6));
  const width = Math.min(Math.max(...top.map((r) => (r || []).length), 1), 30);
  $('raw').innerHTML = top.map((row, i) =>
    `<tr data-row="${i}" class="${i === state.headerRow ? 'header' : ''}"><td class="rn">${i + 1}</td>` +
    Array.from({ length: width }, (_, j) => { const v = esc(show((row || [])[j])); return `<td title="${v}">${v}</td>`; }).join('') +
    '</tr>').join('');
  $('raw').querySelectorAll('tr').forEach((tr) => (tr.onclick = () => setHeaderRow(+tr.dataset.row)));
}

// ─── 2 Map ──────────────────────────────────────────────────
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
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => state.step === 'map' && fitPills(), 100); });

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

function renderMap() {
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
  // The row's last control: "…" (on hover) to enter a value or pick any column; on a required
  // field with no column, value or candidate, a ✎ instead, always shown; on an optional field in
  // that state, nothing (map it from Columns not mapped).
  const control = (id, required, list) => {
    if (state.editingConst === id) return '';
    const empty = !mapping[id] && !list.length && !constant(id) && !actionValue(id);
    if (!empty) return `<button class="pill any" data-edit="${id}" title="Enter a value, or pick any column">…</button>`;
    return required ? `<button class="pill pen" data-edit="${id}" title="Enter a value">✎</button>` : '';
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
      return `<tr class="${cls}"><td>${fieldName(entity, name)}</td><td class="cands">${pills(id, level(name) === 'required')}${under}</td></tr>`;
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

  document.querySelectorAll('#step-map [data-column]').forEach((b) => (b.onclick = () => pickField(b, columns[+b.dataset.column])));
  document.querySelectorAll('#step-map [data-pick]').forEach((b) => (b.onclick = (e) => {
    if (e.target.closest('[data-clear]')) return clearField(b.dataset.pick);
    if (!b.classList.contains('on')) assign(b.dataset.pick, +b.dataset.col);
  }));
  document.querySelectorAll('#step-map [data-edit]').forEach((b) => (b.onclick = () => { state.editingConst = b.dataset.edit; renderMap(); }));
  document.querySelectorAll('#step-map [data-edit-const]').forEach((b) => (b.onclick = (e) => {
    const id = b.dataset.editConst;
    if (e.target.closest('[data-clear-const]')) {
      if (id === 'network.action_type') setAction('');
      else { delete state.constants[id]; state.cleared.delete(id); }
      return run();
    }
    state.editingConst = id;
    renderMap();
  }));
  document.querySelectorAll('#step-map [data-editor]').forEach((box) => {
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
  document.querySelectorAll('#step-map [data-expand]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.expand;
    if (!state.expandedRows.delete(id)) state.expandedRows.add(id);
    renderMap();
  }));
  document.querySelectorAll('#step-map [data-assign]').forEach((b) => (b.onclick = () => assign(b.dataset.assign, +b.dataset.col)));
  fitPills();
  document.querySelectorAll('#step-map [data-hidden]').forEach((b) => (b.onclick = () => {
    const entity = b.dataset.hidden;
    if (!state.showHidden.delete(entity)) state.showHidden.add(entity);
    renderMap();
  }));
  document.querySelectorAll('#step-map [data-family]').forEach((b) => (b.onclick = () => {
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

// ─── Entity tables (Standardize and Validate) ───────────────
// One table per entity: its unique rows (providers, locations, billing; network rows as they come),
// first 20 unless expanded, columns = its mapped fields. Each step supplies how to draw a cell.
const PREVIEW_ROWS = 20;

// The record a value in an entity's table comes from: the first of its rows with a value for the field.
const srcOf = (entity, f) => {
  const rows = entity.rows.map((n) => state.byRow.get(n));
  return rows.find((x) => x?.clean.values[f]) ?? rows[0];
};

function entityTables(container, cell, { rerender, keep = () => true, kinds = ['provider', 'practice', 'billing', 'network'] }) {
  const { records, mapping } = state.result;
  const groups = [
    ['provider', 'Providers', state.entities.providers],
    ['practice', 'Practice locations', state.entities.locations],
    ['billing', 'Billing', state.entities.billing],
    ['network', 'Network', uniqueNetworkRows(records)],
  ];
  container.innerHTML = groups.filter(([kind]) => kinds.includes(kind)).map(([kind, title, all]) => {
    const fields = FIELD_IDS.filter((f) => f.startsWith(`${kind}.`) && (mapping[f] || f === 'network.action_type' || (state.constants[f] && state.result.records[0]?.values[f])));
    const entities = all.filter((e) => keep(e, fields));
    if (!fields.length || !entities.length) return '';
    const open = state.expanded.has(kind);
    const shown = open ? entities : entities.slice(0, PREVIEW_ROWS);
    const more = entities.length > PREVIEW_ROWS
      ? `<button class="more" data-kind="${kind}">${open ? 'Show fewer' : `Show all ${entities.length}`}</button>` : '';
    return `<section class="fieldset ${kind}"><h3>${title} <span class="muted">${entities.length}${entities.length === all.length ? ' unique' : ` of ${all.length}`}</span></h3>` +
      `<div class="scroll"><table class="std"><tr>${fields.map((f) => `<th><span class="tip" title="${esc(fieldTip(f))}">${f.split('.')[1]}</span></th>`).join('')}</tr>` +
      shown.map((e) => `<tr>${fields.map((f) => cell(e, f)).join('')}</tr>`).join('') + `</table></div>${more}</section>`;
  }).join('') || '<p class="muted">Nothing to show.</p>';
  container.querySelectorAll('.more').forEach((b) => (b.onclick = () => {
    const k = b.dataset.kind;
    if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
    rerender();
  }));
}

// Network fields aren't grouped by the entity code: one row per distinct set of network values.
function uniqueNetworkRows(records) {
  const seen = new Map();
  for (const r of records) {
    const key = FIELD_IDS.filter((f) => f.startsWith('network.')).map((f) => r.values[f]).join('|');
    if (seen.has(key)) seen.get(key).rows.push(r.row);
    else seen.set(key, { rows: [r.row] });
  }
  return [...seen.values()];
}

// ─── 3 Standardize ──────────────────────────────────────────
// Values of standardized fields (dates, phones, NPIs, states, …) are in code style; values it
// couldn't clean are red with the reason on hover; free text is plain, used as written.
const standardized = (id) => { const f = specOf(id); return isStandardized(id, f.type, f.values); };
const freeText = (id) => { const f = specOf(id); return isFreeText(id, f.type, f.values); };
// Free-text values (names, addresses, …) and values that couldn't be cleaned get a ✎ on hover in
// the Cleaned view: the typed value replaces the cleaned one for every row of that entity.
function renderStandardize() {
  entityTables($('standardized'), (entity, f) => {
    const src = srcOf(entity, f);
    const value = (state.viewRaw ? src?.raw : src?.clean)?.values[f] ?? '';
    const issue = src?.clean.issues.find((i) => i.field === f && i.kind === 'format');
    const key = `${f}|${entity.rows.join(',')}`;
    if (!state.viewRaw && state.fixing === key) return `<td class="fixing"><input data-fixing="${esc(key)}" value="${esc(value)}" spellcheck="false"></td>`;
    const fixed = src && state.fixes.get(src.clean.row)?.has(f);
    const pen = !state.viewRaw && (issue || fixed || freeText(f)) ? `<button class="pen" data-fix="${esc(key)}" title="Edit">✎</button>` : '';
    if (issue) return `<td class="bad" title="${esc(issue.message)}">${esc(value)}${pen}</td>`;
    const shown = value && !state.viewRaw && standardized(f) ? `<code>${esc(value)}</code>` : esc(value);
    return `<td${fixed && !state.viewRaw ? ` class="fixed" title="Edited here. Was: ${esc(src.raw.values[f] ?? '')}"` : ''}>${shown}${pen}</td>`;
  }, { rerender: renderStandardize });
  $('standardized').querySelectorAll('[data-fix]').forEach((b) => (b.onclick = () => { state.fixing = b.dataset.fix; renderStandardize(); }));
  const input = $('standardized').querySelector('[data-fixing]');
  if (!input) return;
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const [f, rows] = input.dataset.fixing.split('|');
    state.fixing = null;
    if (!save) return renderStandardize();
    for (const row of rows.split(',').map(Number)) {
      const raw = state.byRow.get(row)?.raw.values[f] ?? '';
      const typed = input.value.trim();
      if (!state.fixes.has(row)) state.fixes.set(row, new Map());
      // Typing the value back as written drops the fix, so cleaning applies again.
      if (typed === raw) state.fixes.get(row).delete(f); else state.fixes.get(row).set(f, typed);
    }
    run();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

// Values fixed by hand on Standardize replace the cleaned ones, before Validate's checks see them.
// They're cleaned and checked like any other value, so a mistyped NPI stays flagged.
function applyFixes() {
  for (const r of state.result.records) {
    const fixes = state.fixes.get(r.row);
    if (!fixes?.size) continue;
    r.issues = r.issues.filter((i) => !(fixes.has(i.field) && (i.kind === 'format' || i.kind === 'missing')));
    for (const [f, typed] of fixes) {
      const spec = specOf(f);
      const { value, issue } = cleanValue(f, spec.type, typed, spec.values);
      r.values[f] = value;
      if (issue) r.issues.push({ field: f, kind: 'format', message: issue });
    }
  }
}

// ─── 4 Validate ─────────────────────────────────────────────
// Only outside sources: NPPES and Census lookups, through the CLI's server (checks a value can fail
// on its own, like the NPI check digit, are Standardize's). A suggestion can be accepted per cell ("Use"); accepted
// values replace the cleaned ones for that entity's rows and move forward.
const RANK = { fail: 0, suggest: 1, warn: 2, ok: 3, skip: 4 };

// Every check for one record's values: field → its checks, worst first.
function checksFor(values) {
  const all = [];
  const got = (map, key) => (map.has(key) && !map.get(key)?.error ? map.get(key) : undefined);
  const { nppes, census } = state.lookups;
  const on = state.sources;
  if (on.nppes && nppes.has(values['provider.npi'])) all.push(...nppesProviderChecks(values, got(nppes, values['provider.npi']) ?? null));
  if (on.nppes && nppes.has(values['billing.npi'])) all.push(...nppesBillingChecks(values, got(nppes, values['billing.npi']) ?? null));
  for (const prefix of on.census ? ['practice', 'billing'] : []) {
    const line = addressLine(values, prefix);
    if (census.has(line) || /^PO Box/i.test(values[`${prefix}.address_1`] ?? '')) all.push(...censusChecks(values, prefix, got(census, line) ?? null));
  }
  for (const [key, m] of on.nppes ? nppes : []) if (m?.error && (key === values['provider.npi'] || key === values['billing.npi'])) all.push({ field: key === values['provider.npi'] ? 'provider.npi' : 'billing.npi', status: 'warn', source: 'NPPES', detail: `NPPES didn't answer: ${m.error}` });
  const byField = new Map();
  for (const c of all) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  for (const list of byField.values()) list.sort((a, b) => RANK[a.status] - RANK[b.status]);
  return byField;
}

// Apply accepted suggestions and replace "invalid" issues with the current checks' failures.
// Checks run on the values before acceptance, so the lookups they used stay the same.
function applyValidation() {
  state.checks = new Map();
  state.before = new Map();
  for (const r of state.result.records) {
    const before = { ...r.values };
    state.before.set(r.row, before);
    for (const [f, acc] of state.accepted.get(r.row) ?? []) r.values[f] = acc.value;
    const checks = checksFor(before);
    for (const f of (state.accepted.get(r.row) ?? new Map()).keys()) checks.delete(f);
    state.checks.set(r.row, checks);
    r.issues = r.issues.filter((i) => i.kind !== 'invalid' && !(i.kind === 'missing' && r.values[i.field]) && !(i.kind === 'format' && state.accepted.get(r.row)?.has(i.field)));
    for (const [c] of checks.values()) if (c.status === 'fail') r.issues.push({ field: c.field, kind: 'invalid', message: c.detail });
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

function renderValidate() {
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
      for (const { f, acc, check: c } of items) if (!acc && c.status === 'suggest') pending.set(c.source, [...(pending.get(c.source) ?? []), { f, rows: entity.rows, value: c.suggestion, also: c.also ?? {} }]);
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
      // Census changes applied on their own: folded under "N from Census", each with its old value.
      const auto = items.filter((i) => i.acc?.auto);
      const key = rows(entity);
      const changes = auto.length ? `<li class="auto"><button class="textlink small" data-changes="${key}" title="${esc(auto.map((i) => `${LABEL(i.f)}: ${changeText(i)}`).join('\n'))}">${state.showChanges.has(key) ? '▾' : '▸'} ${plural(auto.length, 'change')} from Census</button>` +
        (state.showChanges.has(key) ? `<ul>${auto.map((i) => `<li><span class="muted">${LABEL(i.f)}:</span> ${esc(changeText(i))} <button class="textlink small" data-undo="${i.f}" data-rows="${key}">undo</button></li>`).join('')}</ul>` : '') + '</li>' : '';
      const fixes = changes + items.filter((i) => !i.acc?.auto && (i.acc || problem(i.check?.status))).map((i) => {
        if (i.acc) return `<li><span class="muted">${LABEL(i.f)}:</span> ${esc(i.value)} <span class="muted">accepted</span> <button class="textlink small" data-undo="${i.f}" data-rows="${rows(entity)}">undo</button></li>`;
        const c = i.check;
        if (c.status === 'suggest') {
          const also = Object.entries(c.also ?? {});
          const theirs = also.length ? [c.suggestion, ...also.map(([, v]) => v)].join(' / ') : c.suggestion;
          return `<li class="${c.status}" title="${esc(`${c.source}: ${c.detail}`)}"><span class="muted">${LABEL(i.f)}:</span> ${esc(i.value) || '<span class="muted">blank</span>'} → <b>${esc(theirs)}</b> ` +
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

// The Census geocoder is trusted by default: its city, state and ZIP, and moving a suite from line 1
// to line 2, are applied as soon as the lookups answer. Changes the user undid stay undone.
function applyCensus() {
  for (const [row, checks] of state.checks) {
    for (const list of checks.values()) {
      for (const c of list) {
        if (c.source !== 'Census' || c.status !== 'suggest' || state.declined.has(`${row}|${c.field}`)) continue;
        accept([row], c.field, c.suggestion, c.also ?? {}, 'Census', true);
      }
    }
  }
}

// Look up every NPI in NPPES and every address with the Census geocoder, 4 at a time; only the
// sources turned on under Upload's Checks, or just `kinds` when given.
async function runChecks(kinds = ['nppes', 'census'].filter((k) => state.sources[k])) {
  if (!kinds.length) return void ($('check-note').textContent = 'Lookups are off; only checks that need no lookup ran.');
  const npis = new Set();
  const lines = new Set();
  for (const v of state.before.values()) { // values before accepted suggestions: what the checks use
    for (const f of ['provider.npi', 'billing.npi']) if (/^\d{10}$/.test(v[f] ?? '')) npis.add(v[f]);
    for (const p of ['practice', 'billing']) { const line = addressLine(v, p); if (line) lines.add(line); }
  }
  const jobs = [
    ...(kinds.includes('nppes') ? [...npis].map((n) => ['nppes', `api/nppes?npi=${n}`, n]) : []),
    ...(kinds.includes('census') ? [...lines].map((l) => ['census', `api/census?address=${encodeURIComponent(l)}`, l]) : []),
  ];
  if (!jobs.length) return void ($('check-note').textContent = 'No NPIs or addresses to look up.');
  state.checking = true;
  let done = 0;
  const note = () => ($('check-note').textContent = `Checking ${done} of ${jobs.length}…`);
  note();
  renderValidate();
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let job; (job = queue.shift()); ) {
      const [kind, url, key] = job;
      try {
        const res = await fetch(url);
        const body = await res.json();
        state.lookups[kind].set(key, res.ok ? body.result : { error: body.error ?? res.statusText });
      } catch (e) {
        state.lookups[kind].set(key, { error: e.message });
      }
      done++;
      note();
    }
  }));
  state.checking = false;
  $('check-note').textContent = 'Checked ' + [
    kinds.includes('nppes') && `${plural(npis.size, 'NPI')} with NPPES`,
    kinds.includes('census') && `${plural(lines.size, 'address', 'addresses')} with the US Census geocoder`,
  ].filter(Boolean).join(' and ') + '.';
  if (kinds.includes('census')) { run(); applyCensus(); }
  run();
}
$('run-checks').onclick = () => runChecks();
$('sources-off').onclick = (e) => { const kind = e.target.dataset?.on; if (kind) setSource(kind, true); };
$('only-problems').onchange = (e) => { state.onlyProblems = e.target.checked; renderValidate(); };

// ─── 5 Review ───────────────────────────────────────────────
const KIND_LABEL = { missing: 'missing', format: 'invalid', invalid: 'per source', default: 'note' };
function renderReview() {
  const graph = state.reviewView === 'graph';
  $('graph').hidden = !graph;
  $('chains-wrap').hidden = graph;
  document.querySelectorAll('#review-view button').forEach((b) => b.classList.toggle('on', b.dataset.review === state.reviewView));
  if (graph) renderPreview(); else renderChains();
  const flagged = state.result.records.filter((r) => r.issues.length);
  $('issues').innerHTML = '<tr><th>Row</th><th>Provider</th><th>Issues</th></tr>' + (flagged.slice(0, 500).map((r) => {
    const who = [r.values['provider.last_name'], r.values['provider.first_name']].filter(Boolean).join(', ') || (r.values['provider.npi'] ? `NPI ${r.values['provider.npi']}` : '');
    return `<tr><td class="muted">${r.row}</td><td class="nowrap">${esc(who)}</td><td>${r.issues.map((i) => `<span class="muted">${KIND_LABEL[i.kind]}</span> ${esc(i.field)}${i.kind === 'missing' ? '' : `: ${esc(i.message)}`}`).join('<br>')}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">No issues.</td></tr>');
}

document.querySelectorAll('#review-view button').forEach((b) => (b.onclick = () => {
  state.reviewView = b.dataset.review;
  renderReview();
}));

// The table view: one line per unique provider × location × billing combination, with its rows.
function renderChains() {
  const { providers, locations, billing } = state.entities;
  const indexOf = (list) => { const m = new Map(); list.forEach((e, i) => e.rows.forEach((r) => m.set(r, i))); return m; };
  const [p, l, b] = [indexOf(providers), indexOf(locations), indexOf(billing)];
  const chains = new Map();
  for (const r of state.result.records) {
    const key = [p.get(r.row), l.get(r.row), b.get(r.row)].join(',');
    if (!chains.has(key)) chains.set(key, { p: p.get(r.row), l: l.get(r.row), b: b.get(r.row), rows: [] });
    chains.get(key).rows.push(r.row);
  }
  const cell = (kind, list, i) => {
    if (i === undefined) return `<td class="${kind}"><span class="muted">none</span></td>`;
    const [title, ...lines] = CARD[kind](list[i]);
    return `<td class="${kind}"><b>${esc(title)}</b>${lines.filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</td>`;
  };
  $('chains').innerHTML = '<tr><th class="provider">Provider</th><th class="practice">Practice location</th><th class="billing">Billing</th><th>Rows</th></tr>' +
    [...chains.values()].map((c) => `<tr>${cell('provider', providers, c.p)}${cell('practice', locations, c.l)}${cell('billing', billing, c.b)}` +
      `<td class="muted">${c.rows.join(', ')}</td></tr>`).join('');
}

// ─── 6 Export ───────────────────────────────────────────────
function renderExport() {
  const { records, mapping } = state.result;
  $('export-summary').textContent = `${plural(records.length, 'record')} from ${state.name} · ${state.sheet}, ${records.filter((r) => r.issues.some((i) => i.kind !== 'default')).length} with issues. ` +
    `The CSV has ${outputFields(records).length} fields; the preview shows the ones with values.`;
  // Mapped fields, plus any filled in later (an accepted suggestion such as address line 2). The file fields aren't shown: see the download.
  const fields = outputOrder(FIELD_IDS).filter((f) => mapping[f] || f === 'network.action_type' || records.some((r) => r.values[f]));
  const shown = records.slice(0, 200);
  $('export-preview').innerHTML = `<tr>${fields.map((f) => `<th><span class="tip" title="${esc(fieldTip(f))}">${f}</span></th>`).join('')}<th>issues</th></tr>` +
    shown.map((r) => `<tr>${fields.map((f) => `<td>${esc(r.values[f])}</td>`).join('')}` +
      `<td class="issues">${r.issues.map((i) => `${esc(i.field)}: ${esc(i.message)}`).join('; ')}</td></tr>`).join('');
  $('export-more').textContent = records.length > shown.length ? `Showing the first ${shown.length} of ${records.length} records.` : '';
}
function download(text, type, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
// Downloads are named RM_<file>_<sheet>.<ext>: "Q3 Roster.xlsx" / "LOC TERM" → RM_Q3Roster_LOCTERM.csv
$('export-csv').onclick = () => download(toCsv(state.result.records), 'text/csv', outputName(state.result.file, 'csv'));
$('export-json').onclick = () => download(JSON.stringify(state.result, null, 2), 'application/json', outputName(state.result.file, 'json'));

// ─── Preview: providers ↔ locations ↔ billing ───────────────
const KINDS = ['provider', 'practice', 'billing'];
const LISTS = { provider: 'providers', practice: 'locations', billing: 'billing' };
const v = (e, f) => e.values[f] ?? '';
const join = (parts, sep = ' ') => parts.filter(Boolean).join(sep);

// Title and up to two detail lines for each kind of card.
const CARD = {
  provider: (e) => [
    join([join([v(e, 'provider.last_name'), join([v(e, 'provider.first_name'), v(e, 'provider.middle_name'), v(e, 'provider.suffix')])], ', '), v(e, 'provider.degree')], ', ') || `NPI ${v(e, 'provider.npi')}`,
    v(e, 'provider.npi') && `NPI ${v(e, 'provider.npi')}`,
    join([v(e, 'provider.taxonomy_1'), v(e, 'provider.specialty_1')], ' · '),
  ],
  practice: (e) => {
    const street = join([v(e, 'practice.address_1'), v(e, 'practice.address_2')]);
    const title = v(e, 'practice.location_name') || v(e, 'practice.dba') || street;
    return [title, title === street ? '' : street, join([join([v(e, 'practice.city'), v(e, 'practice.state')], ', '), v(e, 'practice.zip'), v(e, 'practice.phone') && `· ${v(e, 'practice.phone')}`])];
  },
  billing: (e) => [
    v(e, 'billing.legal_name') || `TIN ${v(e, 'billing.tax_id')}`,
    join([v(e, 'billing.legal_name') && v(e, 'billing.tax_id') && `TIN ${v(e, 'billing.tax_id')}`, v(e, 'billing.npi') && `NPI ${v(e, 'billing.npi')}`], ' · '),
    join([join([v(e, 'billing.address_1'), v(e, 'billing.city'), v(e, 'billing.state')], ', '), v(e, 'billing.zip')]),
  ],
};

// Index → connected indexes, per pair of kinds.
function neighbours() {
  const { providerLocations, locationBilling } = state.entities;
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
    const entities = state.entities[LISTS[kind]];
    $(`count-${kind}`).textContent = entities.length;
    $(`list-${kind}`).innerHTML = entities.map((e, i) => {
      const [title, ...lines] = CARD[kind](e);
      const fields = Object.entries(e.values).map(([f, val]) => `<dt>${esc(f.split('.')[1])}</dt><dd>${esc(val)}</dd>`).join('');
      // The connections line only shows on narrow screens, where there are no lines between cards.
      return `<li data-kind="${kind}" data-i="${i}"><b>${esc(title)}</b>${lines.filter(Boolean).map((l) => `<span>${esc(l)}</span>`).join('')}` +
        `<span class="links-line">${linkText[kind](i)} · ${plural(e.rows.length, 'row')}${e.issues ? ` · <em class="issues">${plural(e.issues, 'issue')}</em>` : ''}</span>` +
        `<dl>${fields}<dt>rows</dt><dd>${e.rows.join(', ')}</dd></dl></li>`;
    }).join('') || '<li class="empty"><span>none in this sheet</span></li>';
  }
  $('graph').querySelectorAll('li[data-kind]').forEach((li) => {
    const kind = li.dataset.kind;
    const i = +li.dataset.i;
    li.onclick = () => select(kind, i);
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
  const { providerLocations, locationBilling } = state.entities;
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
  if (!state.entities || getComputedStyle(svg).display === 'none') return;
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
  const { providerLocations, locationBilling } = state.entities;
  svg.setAttribute('width', graph.scrollWidth);
  svg.setAttribute('height', graph.scrollHeight);
  svg.innerHTML = providerLocations.map(([pi, li]) => curve(p[pi], l[li])).join('') +
    locationBilling.map(([li, bi]) => curve(l[li], b[bi])).join('') + '<g class="top"></g>';
  highlight();
}


new ResizeObserver(() => state.result && state.step === 'review' && drawLinks()).observe($('graph'));
