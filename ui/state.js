// The UI's state: the files, the open file's sheet and every choice made on it.
// Saved in this browser: which lookups may run (see loadSources) and the values allowed as written.
export const SOURCES_KEY = 'rostermapper.sources';
export const ALLOWED_KEY = 'rostermapper.allowed';
export const SOURCE_NAME = { nppes: 'NPPES', census: 'US Census geocoder' };

export const state = {
  step: 'upload',
  name: '', sheets: [], sheet: '', rows: [], headerRow: 0, autoRow: 0, action: '', category: '',
  mapping: null, // { name, overrides, errors }: the uploaded mapping file
  edits: {}, // header → field or "ignore": changes made in Mapping, applied on top of the file
  cleared: new Set(), // Map: fields set to "no column" here; matching leaves them empty
  constants: {}, // Map: field → one value for every row, set from the "…" dropdown instead of a column
  editingConst: null, // Map: the field whose value pill is an input right now
  expandedRows: new Set(), // Map: fields whose row shows every candidate pill, wrapped
  result: null, raw: null, entities: null, selected: null, hovered: null,
  openFamilies: new Set(), // Map: folded groups of numbered columns the user opened
  showHidden: new Set(), // Map: entities whose hidden fields are shown
  lookups: { nppes: new Map(), census: new Map(), names: new Map() }, // Validate: answers by NPI, by address line and by provider name
  checks: new Map(), // Validate: row → field → its checks, worst first
  accepted: new Map(), // Validate: row → field → { value, source, auto } for accepted suggestions
  declined: new Set(), // Validate: "row|field" of Census changes the user undid; not applied again
  showChanges: new Set(), // Validate: cards whose Census changes are listed
  fixes: new Map(), // Review: row → field → value typed over the cleaned one (an issue's "edit")
  checking: false, byRow: new Map(), before: new Map(),
  reviewView: 'graph', // Review: 'graph' or 'table'
  checked: false, // lookups have run for this sheet
  sources: loadSources(), // New run's external sources: { nppes, census }, true when that lookup may run
  effectiveDate: '', // Upload: YYYY-MM-DD for rows whose effective date is blank
  inputs: {}, // Download: input field id → the value written into every row (contract ID, sender email)
  files: [], // the files dropped together: { name, read() → sheets, status: waiting|running|done|error, results?, error? }
  current: -1, // the file open at Review, by index in `files`
  ignored: new Set(), // "file|sheet" of sheets left out of Results and the downloads (× on a sheet tab)
  editing: null, // Review: "field|rows" of the value being typed (an issue's or a card's)
  editingAddress: null, // Review: "kind|rows" of the card whose address is open to edit
  progress: '', // the status bar: "Checking 12 of 40…" while lookups run
  allowed: loadAllowed(), // field → values the user allowed as written (provider types like AHP): not flagged
};

/** Results with the Download inputs (contract ID, sender email) written into every row; a blank one is left out. */
export function withInputs(results) {
  const set = Object.entries(state.inputs).filter(([, v]) => v);
  if (!set.length) return results;
  return results.map((r) => ({ ...r, records: r.records.map((x) => ({ ...x, values: { ...x.values, ...Object.fromEntries(set) } })) }));
}

// Values allowed as written, remembered in this browser so the next roster from the sender keeps them.
function loadAllowed() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(ALLOWED_KEY) ?? '{}')).map(([f, list]) => [f, new Set(list)])); } catch { return new Map(); }
}
/** The allowed values as the pipeline takes them: field id → values. */
export const allowedOption = () => Object.fromEntries([...state.allowed].filter(([, s]) => s.size).map(([f, s]) => [f, [...s]]));
export function saveAllowed() {
  try { localStorage.setItem(ALLOWED_KEY, JSON.stringify(Object.fromEntries([...state.allowed].filter(([, s]) => s.size).map(([f, s]) => [f, [...s]])))); } catch { /* not remembered */ }
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