// Roster Mapper's UI, served by the CLI (rostermapper --ui [roster.xlsx]). A workbench: the rail on the
// left lists the files; the main pane shows New run (files and options), Results (what the run did to
// every file) or one file's Review; the status bar at the bottom shows progress.
//
// Every file runs through every step, as `rostermapper <files>` does (runSheets). A file opens at Review,
// its one page: its sheets along the top, its providers, locations and billing as a graph or table with
// the checks on each card, its issues with their fixes, and Mapping and Raw data as dialogs. Every change
// is recalculated live (automap on the open sheet). Download saves one workbook for the file.
// Files are read in this browser; only NPIs and addresses go out, to NPPES and the Census geocoder.
import { automap, detectHeaderRow, groupEntities, isDropped, parseMapping, readWorkbook, runSheets, counts } from './rostermapper.js';
import { $, LOOKUP, esc, oneLine, plural } from './lib.js';
import { SOURCES_KEY, allowedOption, state } from './state.js';
import { renderFiles, renderResults } from './results.js';
import { renderUpload } from './steps/upload.js';
import { renderMap } from './steps/map.js';
import { applyFixes } from './steps/standardize.js';
import { applyValidation, runChecks } from './steps/validate.js';
import { renderReview } from './steps/review.js';

// ─── Sources: which lookups may send data out ───────────────
export function setSource(kind, on) {
  state.sources[kind] = on;
  try { localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources)); } catch { /* not remembered */ }
  $(`use-${kind}`).checked = on;
  if (state.result) run(); // hides or shows that source's checks
  // Turned on with checks already run: look this source up now (the CLI's server keeps earlier answers).
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
// Views: upload (a new run's files and options), results, and review (the file open).
const VIEWS = ['upload', 'results', 'review'];
export function go(step) {
  if (step === 'review' && !state.result) step = 'upload';
  state.step = step;
  for (const s of VIEWS) $(`step-${s}`).hidden = s !== step;
  $('filename').hidden = step !== 'review';
  $('rail-new').toggleAttribute('aria-current', step === 'upload');
  $('rail-results').toggleAttribute('aria-current', step === 'results');
  render();
  // Lookups run the first time a sheet opens (answers the run already got are reused); "Run checks" repeats them.
  if (step === 'review' && !state.checked) { state.checked = true; runChecks(); }
}
$('rail-new').onclick = (e) => { e.preventDefault(); remember(); closeFile(); go('upload'); };

// ─── Mapping and Raw data: dialogs over the file's page ─────
// The page behind recalculates with every change made in them.
export function openMap(field) {
  $('map-dialog').showModal();
  renderMap();
  const tr = field && document.querySelector(`#mapped tr[data-field="${CSS.escape(field)}"]`);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center' });
  tr.classList.add('flash');
  setTimeout(() => tr.classList.remove('flash'), 1600);
}
$('open-map').onclick = () => openMap();
$('open-raw').onclick = () => { $('raw-dialog').showModal(); renderUpload(); $('raw').querySelector('tr.header')?.scrollIntoView({ block: 'center' }); };
for (const d of ['map-dialog', 'raw-dialog']) $(d).onclick = (e) => { if (e.target === $(d)) $(d).close(); }; // click outside closes

/** The status bar's left side: progress while something runs, else what the open view holds. */
export function status(text) {
  state.progress = text;
  renderStatus();
}

function renderStatus() {
  let text = state.progress;
  if (!text && state.step === 'results' && state.files.length) text = `Lookups: ${checkedWith()}`;
  else if (!text && state.step === 'review' && state.result) {
    const c = counts(state.result.records);
    text = `${state.sheet} · ${plural(c.rows, 'row')} · ${c.movedForward} moved forward · ${c.leftOut} left out · ${c.withIssues} with issues`;
  }
  $('status').textContent = text;
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
  // One file from the command line: run it, then open it.
  await runFiles();
  if (state.files[0]?.status === 'done') openFile(0, session.sheet, session.headerRow);
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
  const first = state.sheets.find((s) => s.name === sheet) ?? state.sheets[0];
  if (!first) { state.result = null; state.rows = []; return go('upload'); }
  pickSheet(first.name, headerRow);
}

function loadMapping(name, bytes) {
  const rows = readWorkbook(bytes)[0]?.rows ?? [];
  state.mapping = { name, ...parseMapping(rows) };
  run();
}

// What was done on each sheet (suggestions used, values typed, the header row) and its result, so
// switching sheets keeps it and Download has every sheet as left: "file|sheet" → choices and result.
export const sheetMemo = new Map();
export function remember() {
  if (!state.result || !state.sheet) return;
  const { accepted, declined, fixes, checked, headerRow } = state;
  sheetMemo.set(`${state.name}|${state.sheet}`, { accepted, declined, fixes, checked, headerRow, result: { ...state.result, sheet: state.sheet } });
}

/** Open a sheet of the file open, as it was left. Call remember() first when leaving another sheet. */
export function pickSheet(name, headerRow) {
  const m = sheetMemo.get(`${state.name}|${name}`);
  state.sheet = name;
  state.accepted = m?.accepted ?? new Map(); // accepted suggestions belong to one sheet's rows
  state.declined = m?.declined ?? new Set();
  state.fixes = m?.fixes ?? new Map(); // and so do values fixed by hand
  state.checks = new Map();
  state.checked = m?.checked ?? false;
  state.rows = state.sheets.find((s) => s.name === name).rows;
  state.autoRow = detectHeaderRow(state.rows);
  state.selected = null;
  setHeaderRow(headerRow ?? m?.headerRow ?? state.autoRow);
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
  state.raw = null; // as written, for an edit's "was": computed when asked (see rawRecords)
  state.options = options;
  applyFixes();
  applyValidation(); // accepted suggestions, and failures from Validate's checks, as issues
  state.byRow = new Map(state.result.records.map((r, i) => [r.row, { clean: r, get raw() { return rawRecords()[i]; } }]));
  state.entities = groupEntities(state.result.records); // every row, so a dropped one can be fixed
  state.kept = groupEntities(state.result.records.filter((r) => !isDropped(r))); // Review: only rows that move forward
  state.selected = state.hovered = null;
  go(state.step);
}

// The records as written, uncleaned. Half the work of run(), so done only when the view asks.
function rawRecords() {
  state.raw ??= automap(state.rows, { ...state.options, clean: false });
  return state.raw.records;
}

// The mapping file's overrides with the changes made in Mapping on top.
export const overrides = () => ({ ...state.mapping?.overrides, ...state.edits });

export function render() {
  renderUpload();
  renderBanner();
  renderFiles();
  renderStatus();
  if (state.step === 'results') return renderResults();
  if (!state.result || state.step !== 'review') return;
  renderReview();
  if ($('map-dialog').open) renderMap();
}

// A one-line notice above the view when the sheet likely needs a transform (several addresses per
// row, …). Detection only: the Transform step isn't built yet.
function renderBanner() {
  const hints = (state.step === 'review' && state.result?.transforms) || [];
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

// New files replace the old ones, and run.
function addFiles(list) {
  const files = list.filter((f) => isRoster(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) {
    if (list.length) { $('drop-title').textContent = 'No roster files there'; $('drop-hint').textContent = 'xlsx, xls or csv'; }
    return;
  }
  state.files = files.map((f) => ({ name: f.name, read: async () => readWorkbook(await f.arrayBuffer()), status: 'waiting' }));
  runFiles();
}

// No file open (Results shows them all; New run starts another).
function closeFile() {
  Object.assign(state, { result: null, rows: [], name: '', sheet: '', current: -1 });
  for (const d of ['map-dialog', 'raw-dialog']) $(d).close();
  $('drop-title').textContent = 'Drop roster files or a folder';
  $('drop-hint').textContent = 'or click to browse · xlsx, xls, csv';
  document.title = 'Roster Mapper';
}

// Open one of the files at Review, at a sheet (default: its first), as it was left.
export async function openFile(i, sheet, headerRow) {
  remember();
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
  state.step = 'review';
  loadSheets(f.name, sheets, sheet, headerRow);
}

// Every step on every file, one file at a time, as the CLI's run does (runSheets: lookups 4 at a time,
// trusted fixes applied, NPPES's verdicts as issues). A newer run stops an older one.
export async function runFiles() {
  const token = (state.runToken = {});
  for (const f of state.files) Object.assign(f, { status: 'waiting', results: undefined, error: undefined });
  sheetMemo.clear(); // a new run starts every sheet afresh
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
