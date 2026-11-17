import { $ } from '../lib.js';
import { run } from '../app.js';
import { applyDropRules, cleanValue, isFreeText, isStandardized } from '../rostermapper.js';
import { esc, specOf } from '../lib.js';
import { state } from '../state.js';
import { entityTables, srcOf } from './entities.js';
// Standardize: view the values as written, for comparison. Cleaned values always move forward.
document.querySelectorAll('#step-standardize .view-switch button').forEach((b) => (b.onclick = () => {
  state.viewRaw = b.dataset.view === 'raw';
  document.querySelectorAll('#step-standardize .view-switch button').forEach((x) => x.classList.toggle('on', x === b));
  renderStandardize();
}));

// ─── 3 Standardize ──────────────────────────────────────────
// Values of standardized fields (dates, phones, NPIs, states, …) are in code style; values it
// couldn't clean are red with the reason on hover; free text is plain, used as written.
const standardized = (id) => { const f = specOf(id); return isStandardized(id, f.type, f.values); };
const freeText = (id) => { const f = specOf(id); return isFreeText(id, f.type, f.values); };
// Free-text values (names, addresses, …) and values that couldn't be cleaned get a ✎ on hover in
// the Cleaned view: the typed value replaces the cleaned one for every row of that entity.
export function renderStandardize() {
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
export function applyFixes() {
  for (const r of state.result.records) {
    // Values allowed as written (a sender's own provider types): no longer flagged.
    r.issues = r.issues.filter((i) => !(i.kind === 'format' && state.allowed.get(i.field)?.has(r.values[i.field])));
    const fixes = state.fixes.get(r.row);
    if (!fixes?.size) continue;
    r.issues = r.issues.filter((i) => !(fixes.has(i.field) && (i.kind === 'format' || i.kind === 'missing')));
    for (const [f, typed] of fixes) {
      const spec = specOf(f);
      const { value, issue } = cleanValue(f, spec.type, typed, spec.values);
      r.values[f] = value;
      if (issue) r.issues.push({ field: f, kind: 'format', message: issue });
    }
    applyDropRules(r, state.result.file.category); // a fixed NPI no longer drops the row; a mistyped one still does
  }
}