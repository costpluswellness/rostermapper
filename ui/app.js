// Roster Mapper's UI, served by the CLI (rostermapper --ui [roster.xlsx]). A workbench: the rail on the
// left lists the files and, for the file open, its steps; the main pane shows one view; the status bar
// at the bottom shows progress and moves between steps.
//
// Two modes, as in the CLI:
// - Run (the default) runs every step on every file, as `rostermapper <files>` does (runSheets), and
//   shows Results: the workbook's tables, and a workbook per sheet to download.
// - Step by step opens a file at Upload and goes through Map, Standardize, Validate, Review and Export
//   one view at a time, every change recalculated live: to see why a roster maps the way it does.
// Files are read in this browser; only NPIs and addresses go out, to NPPES and the Census geocoder.
import { automap, detectHeaderRow, groupEntities, isBlank, isDropped, parseMapping, readWorkbook, runSheets, counts } from './rostermapper.js';
import { $, LOOKUP, STEPS, esc, oneLine, plural } from './lib.js';
import { MODE_KEY, SOURCES_KEY, allowedOption, state } from './state.js';
import { renderFiles, renderResults } from './results.js';
import { renderUpload } from './steps/upload.js';
import { renderMap } from './steps/map.js';
import { applyFixes, renderStandardize } from './steps/standardize.js';
import { applyValidation, renderValidate, runChecks } from './steps/validate.js';
import { renderReview } from './steps/review.js';
import { renderExport } from './steps/export.js';

// ─── Sources: which lookups may send data out ───────────────
export function setSource(kind, on) {
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

// ─── Navigation ─────────────────────────────────────────────
// Views: upload (a new run's files and options), results, and the steps of the file open, as tabs.
const TAB_LABEL = { upload: 'Upload', map: 'Map', standardize: 'Standardize', validate: 'Validate', review: 'Review', export: 'Export' };
// Tabs the user hid with ×, remembered in this browser. Review, where a file opens, can't be hidden.
const HIDDEN_KEY = 'rostermapper.hiddenTabs';
const hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')); } catch { return new Set(); } })();
const saveHidden = () => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* not remembered */ } };
const shownSteps = () => STEPS.filter((s) => !hidden.has(s));

export function go(step) {
  if (step !== 'upload' && step !== 'results' && !state.result) return;
  if (hidden.delete(step)) saveHidden(); // a link to a hidden tab (an issue's "mapping") brings it back
  state.step = step;
  for (const s of [...STEPS, 'results']) $(`step-${s}`).hidden = s !== step;
  const inSteps = step !== 'results' && !!state.result;
  $('filename').hidden = !inSteps;
  $('file-tabs').hidden = !inSteps;
  $('rail-new').toggleAttribute('aria-current', step === 'upload' && !state.result);
  $('rail-results').toggleAttribute('aria-current', step === 'results');
  const steps = shownSteps();
  const i = steps.indexOf(step);
  $('step-nav').hidden = !inSteps;
  $('back').disabled = i <= 0;
  $('next').disabled = i === steps.length - 1 || !state.result;
  $('run-all').disabled = !state.result || step === 'export';
  $('map-links').hidden = step !== 'map' || !state.result;
  render();
  // Lookups start the first time Review or Validate opens for a sheet (answers a run already got are
  // reused); "Run checks again" repeats them.
  if ((step === 'validate' || step === 'review') && state.result && !state.checked) { state.checked = true; runChecks(); }
}
$('tabs').onclick = (e) => {
  const x = e.target.closest('[data-hide]');
  if (x) {
    e.stopPropagation();
    hidden.add(x.dataset.hide);
    saveHidden();
    return go(state.step === x.dataset.hide ? 'review' : state.step);
  }
  const b = e.target.closest('[data-step]');
  if (b) go(b.dataset.step);
};
$('tab-add').onchange = (e) => { const s = e.target.value; e.target.value = ''; if (s) go(s); };
$('rail-new').onclick = (e) => { e.preventDefault(); closeFile(); go('upload'); };
$('back').onclick = () => { const s = shownSteps(); go(s[s.indexOf(state.step) - 1]); };
$('next').onclick = () => { const s = shownSteps(); go(s[s.indexOf(state.step) + 1]); };

// Step by step: finish this file from wherever you are (lookups, trusted fixes) and go to Export.
$('run-all').onclick = async () => {
  if (!state.result) return;
  $('run-all').disabled = true;
  if (!state.checked) { state.checked = true; await runChecks(); }
  go('export');
};

/** The status bar's left side: progress while something runs, else what the open view holds. */
export function status(text) {
  state.progress = text;
  renderStatus();
}

function renderStatus() {
  let text = state.progress;
  if (!text && state.step === 'results' && state.files.length) text = `Lookups: ${checkedWith()}`;
  else if (!text && state.step !== 'results' && state.result) {
    const c = counts(state.result.records);
    text = `${state.sheet} · ${plural(c.rows, 'row')} · ${c.movedForward} moved forward · ${c.leftOut} left out · ${c.withIssues} with issues`;
  }
  $('status').textContent = text;
}

// The open file's tabs, each with what its step found for the sheet open; × hides one, + shows it again.
function renderTabs() {
  const r = state.result;
  if (!r) return;
  const counts_ = {};
  const badge = (step, text, tip = '', bad = false) => (counts_[step] = { text, tip, bad });
  const format = r.records.reduce((n, x) => n + x.issues.filter((i) => i.kind === 'format').length, 0);
  const checks = [...state.checks.values()].flatMap((m) => [...m.values()].map((list) => list[0]?.status));
  const fails = checks.filter((s) => s === 'fail').length;
  const warns = checks.filter((s) => s === 'warn' || s === 'suggest').length;
  const c = counts(r.records);
  badge('upload', state.sheets.length > 1 ? `${state.sheets.length} sheets` : '');
  badge('map', `${Object.keys(r.mapping).length}/${r.columns.length}`, 'Columns mapped', r.missing.length > 0);
  badge('standardize', format ? `${format} ✕` : '✓', format ? 'Values that could not be cleaned' : 'Every value cleaned', format > 0);
  badge('validate', !state.checked ? '' : state.checking ? '…' : `${fails ? `${fails} ✕ ` : ''}${warns ? `${warns} ⚠` : ''}`.trim() || '✓', 'Failed and flagged checks', fails > 0);
  badge('review', String(state.kept.providers.length || state.kept.billing.length), 'Providers (or billing entities) moving forward');
  badge('export', `${c.movedForward}`, `${c.movedForward} rows move forward, ${c.leftOut} left out`, c.leftOut > 0);
  $('tabs').innerHTML = shownSteps().map((s) => {
    const n = counts_[s];
    return `<button type="button" role="tab" data-step="${s}"${s === state.step ? ' class="on" aria-selected="true"' : ''}${n?.tip ? ` title="${esc(n.tip)}"` : ''}>${TAB_LABEL[s]}` +
      `${n?.text ? ` <small class="${n.bad ? 'bad' : 'muted'}">${esc(n.text)}</small>` : ''}` +
      `${s === 'review' ? '' : `<span class="x" data-hide="${s}" title="Hide this tab">×</span>`}</button>`;
  }).join('');
  const off = STEPS.filter((s) => hidden.has(s));
  $('tab-add').hidden = !off.length;
  $('tab-add').innerHTML = '<option value="">+</option>' + off.map((s) => `<option value="${s}">${TAB_LABEL[s]}</option>`).join('');
}

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
  // --allow: added to the values allowed in this browser, for this session.
  for (const [f, list] of Object.entries(session.allowed ?? {})) for (const v of list) (state.allowed.get(f) ?? state.allowed.set(f, new Set()).get(f)).add(v);
  // --no-nppes / --no-census win for this session; the boxes still change them (and save).
  for (const kind of ['nppes', 'census']) if (session[kind] === false) { state.sources[kind] = false; $(`use-${kind}`).checked = false; }
  if (session.mappingName) loadMapping(session.mappingName, await (await fetch('mapping')).arrayBuffer());
  if (!session.name) return go('upload');
  // The CLI sends the roster already read and SSN-redacted, never the raw file.
  const revive = (_, v) => (v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v);
  const sheets = JSON.parse(await (await fetch('file')).text(), revive);
  state.files = [{ name: session.name, read: async () => sheets, status: 'waiting' }];
  if (state.mode === 'run') return runFiles();
  state.current = 0;
  loadSheets(session.name, sheets, session.sheet, session.headerRow);
}
boot().catch((e) => { document.querySelector('.rm-main').insertAdjacentHTML('afterbegin', `<p class="rm-note">Could not start: ${esc(e.message)}. Is the CLI still running?</p>`); });

$('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
// A folder: its own files, not its subfolders' (as the CLI reads one).
$('folder').onchange = (e) => { addFiles([...e.target.files].filter((f) => f.webkitRelativePath.split('/').length === 2)); e.target.value = ''; };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addFiles(await droppedFiles(e.dataTransfer));
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

// readWorkbook removes SSNs as it reads, so they never reach the page's state or screen.
function loadSheets(name, sheets, sheet, headerRow) {
  state.name = name;
  state.sheets = sheets.filter((s) => s.rows.length);
  document.title = `${name} · Roster Mapper`;
  $('filename').textContent = name;
  $('drop').classList.add('loaded');
  $('private-note').hidden = true;
  $('drop-title').textContent = name;
  $('drop-hint').textContent = 'drop or click to replace';
  // Every sheet with data, as buttons: name and data-row count.
  $('sheets').innerHTML = state.sheets.map((s) => {
    const n = s.rows.slice(detectHeaderRow(s.rows) + 1).filter((r) => r?.some((c) => !isBlank(c))).length;
    return `<button type="button" data-sheet="${esc(s.name)}">${esc(s.name)}<small>${plural(n, 'row')}</small></button>`;
  }).join('');
  $('sheets').hidden = state.sheets.length < 2; // one sheet: nothing to pick; its row count goes in the drop bar
  $('sheets').querySelectorAll('button').forEach((b) => (b.onclick = () => pickSheet(b.dataset.sheet)));
  const first = state.sheets.find((s) => s.name === sheet) ?? state.sheets[0];
  if (!first) { state.result = null; state.rows = []; $('drop-hint').textContent = 'This file has no data. Drop or choose another.'; return go('upload'); }
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
  state.checks = new Map();
  state.checked = false;
  $('sheets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.sheet === name));
  state.rows = state.sheets.find((s) => s.name === name).rows;
  state.autoRow = detectHeaderRow(state.rows);
  setHeaderRow(headerRow ?? state.autoRow);
}

export function setHeaderRow(r) {
  state.headerRow = Math.max(0, Math.min(r, state.rows.length - 1));
  run();
}

// Recalculate the open sheet from the current choices: every step, live.
export function run() {
  if (!state.rows.length) return go(state.step);
  const options = {
    headerRow: state.headerRow, fileName: state.name, sheetName: state.sheet,
    overrides: overrides(), unmapped: [...state.cleared], constants: { ...state.constants, ...state.inputs }, allowed: allowedOption(), ...(state.effectiveDate && { effectiveDate: state.effectiveDate }), ...(state.action && { action: state.action }), ...(state.category && { category: state.category }),
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
  state.entities = groupEntities(state.result.records); // every row, so Validate can fix a dropped one
  state.kept = groupEntities(state.result.records.filter((r) => !isDropped(r))); // Review: only rows that move forward
  state.selected = state.hovered = null;
  go(state.step);
}

// The records as written, uncleaned. Half the work of run(), so done only when the view asks.
function rawRecords() {
  state.raw ??= automap(state.rows, { ...state.options, clean: false });
  return state.raw.records;
}

// The mapping file's overrides with the Map step's changes on top.
export const overrides = () => ({ ...state.mapping?.overrides, ...state.edits });

export function render() {
  renderUpload();
  renderBanner();
  renderFiles();
  renderTabs();
  renderStatus();
  if (state.step === 'results') return renderResults();
  if (!state.result) return;
  ({ map: renderMap, standardize: renderStandardize, validate: renderValidate, review: renderReview, export: renderExport })[state.step]?.();
}

// A one-line notice above the view when the sheet likely needs a transform (several addresses per
// row, …). Detection only: the Transform step isn't built yet.
function renderBanner() {
  const hints = (state.step !== 'results' && state.result?.transforms) || [];
  const banner = $('transform-banner');
  banner.hidden = !hints.length;
  if (!hints.length) return;
  const { columns } = state.result;
  banner.innerHTML = hints.map((t) => `<b>Likely needs a transform.</b> ${esc(t.message)}`).join('<br>');
  banner.title = hints.map((t) => `Address blocks, by column: ${t.columns.map((i) => `${columns[i].letter} ${oneLine(columns[i].header)}`).join(', ')}`).join('\n');
}

// ─── Files and runs ─────────────────────────────────────────
const isRoster = (name) => /\.(xlsx|xls|csv)$/i.test(name) && !/^(~\$|\.|RM_)/.test(name) && name !== 'summary.xlsx';

export const checkedWith = () => ['nppes', 'census'].filter((k) => state.sources[k]).map((k) => (k === 'nppes' ? 'NPPES' : 'Census')).join(', ') || 'no lookups';
const two = (n) => String(n).padStart(2, '0');
export const timestamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;

function setMode(mode) {
  state.mode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* not remembered */ }
  $('mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}
setMode(state.mode);
$('mode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };

// Files and folders dropped: a folder's own files, not its subfolders'. Entries must be taken before any await.
async function droppedFiles(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const file = (entry) => new Promise((done, fail) => entry.file(done, fail));
  const files = [];
  for (const entry of entries) {
    if (entry.isFile) files.push(await file(entry));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch; (batch = await new Promise((done, fail) => reader.readEntries(done, fail))).length; ) {
        for (const e of batch) if (e.isFile) files.push(await file(e));
      }
    }
  }
  return files;
}

// New files replace the old ones. Run runs them all; Step by step opens the first at Upload.
function addFiles(list) {
  const files = list.filter((f) => isRoster(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) {
    if (list.length) { $('drop-title').textContent = 'No roster files there'; $('drop-hint').textContent = 'xlsx, xls or csv'; }
    return;
  }
  state.files = files.map((f) => ({ name: f.name, read: async () => readWorkbook(await f.arrayBuffer()), status: 'waiting' }));
  if (state.mode === 'steps') return openFile(0, undefined, 'upload');
  runFiles();
}

// No file open in the steps (Results shows them all; Upload starts a new run).
function closeFile() {
  Object.assign(state, { result: null, rows: [], name: '', sheet: '', current: -1 });
  $('raw-wrap').hidden = true;
  $('sheets').hidden = true;
  $('drop').classList.remove('loaded');
  $('private-note').hidden = false;
  $('drop-title').textContent = 'Drop roster files or a folder';
  $('drop-hint').textContent = 'or click to browse · xlsx, xls, csv';
  document.title = 'Roster Mapper';
}

// Open one of the files at a sheet: at Review (its tabs hold the other steps), or at Upload for Step by step's first file.
export async function openFile(i, sheet, step = 'review') {
  const f = state.files[i];
  let sheets;
  try { sheets = await f.read(); } catch (e) {
    Object.assign(f, { status: 'error', error: e.message });
    closeFile();
    $('drop-title').textContent = `Can't open ${f.name}`;
    $('drop-hint').textContent = e.message;
    return go('upload');
  }
  state.current = i;
  state.step = step;
  loadSheets(f.name, sheets, sheet);
}

// Every step on every file, one file at a time, as the CLI's run does (runSheets: lookups 4 at a time,
// trusted fixes applied, NPPES's verdicts as issues). A newer run stops an older one.
export async function runFiles() {
  const token = (state.runToken = {});
  for (const f of state.files) Object.assign(f, { status: 'waiting', results: undefined, error: undefined });
  closeFile();
  go('results');
  for (const f of state.files) {
    if (state.runToken !== token) return;
    f.status = 'running';
    render();
    try {
      const results = (await runSheets(f.name, await f.read(), {
        overrides: state.mapping?.overrides ?? {}, constants: { ...state.inputs }, allowed: allowedOption(),
        ...(state.effectiveDate && { effectiveDate: state.effectiveDate }), ...(state.action && { action: state.action }), ...(state.category && { category: state.category }),
        sources: state.sources, lookup: LOOKUP, lookups: state.lookups,
        progress: (done, total) => state.runToken === token && status(`${f.name}: checking ${done} of ${total}…`),
      })).filter((r) => r.records.length);
      if (!results.length) throw new Error('No data in this file.');
      Object.assign(f, { status: 'done', results });
    } catch (e) {
      Object.assign(f, { status: 'error', error: e.message });
    }
    if (state.runToken !== token) return;
    state.progress = '';
    render();
  }
}
