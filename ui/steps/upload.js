import { $ } from '../lib.js';
import { setHeaderRow } from '../app.js';
import { esc, plural, show } from '../lib.js';
import { state } from '../state.js';
// ─── 0 Upload ───────────────────────────────────────────────
export function renderUpload() {
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