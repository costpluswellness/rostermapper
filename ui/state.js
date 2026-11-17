// The UI's state: the files, the open file's sheet and every choice made on its steps.
// Saved in this browser: the mode and which lookups may run (see loadSources).
export const SOURCES_KEY = 'rostermapper.sources';
export const MODE_KEY = 'rostermapper.mode';
export const ALLOWED_KEY = 'rostermapper.allowed';
export const SOURCE_NAME = { nppes: 'NPPES', census: 'US Census geocoder' };

export const state = {
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
  lookups: { nppes: new Map(), census: new Map(), names: new Map() }, // Validate: answers by NPI, by address line and by provider name
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
  mode: loadMode(), // 'run': run every step on every file and show Results; 'steps': open each file at Upload
  files: [], // the files dropped together: { name, read() → sheets, status: waiting|running|done|error, results?, error? }
  current: -1, // the file open in the steps, by index in `files`
  progress: '', // the status bar: "Checking 12 of 40…" while lookups run
  allowed: loadAllowed(), // field → values the user allowed as written (provider types like AHP): not flagged
};

// Values allowed as written, remembered in this browser so the next roster from the sender keeps them.
function loadAllowed() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(ALLOWED_KEY) ?? '{}')).map(([f, list]) => [f, new Set(list)])); } catch { return new Map(); }
}
/** The allowed values as the pipeline takes them: field id → values. */
export const allowedOption = () => Object.fromEntries([...state.allowed].filter(([, s]) => s.size).map(([f, s]) => [f, [...s]]));
export function saveAllowed() {
  try { localStorage.setItem(ALLOWED_KEY, JSON.stringify(Object.fromEntries([...state.allowed].filter(([, s]) => s.size).map(([f, s]) => [f, [...s]])))); } catch { /* not remembered */ }
}

function loadMode() {
  try { return localStorage.getItem(MODE_KEY) === 'steps' ? 'steps' : 'run'; } catch { return 'run'; }
}

// ─── Checks: which lookups may send data out ────────────────
// Remembered in this browser; --no-nppes / --no-census override for the session. Storage can be
// missing or throw (private windows): then both are on.
function loadSources() {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? '{}');
    return { nppes: saved.nppes !== false, census: saved.census !== false };
  } catch { return { nppes: true, census: true }; }
}