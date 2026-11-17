import { FIELD_IDS, esc, fieldTip } from '../lib.js';
import { state } from '../state.js';
// ─── Entity tables (Standardize and Validate) ───────────────
// One table per entity: its unique rows (providers, locations, billing; network rows as they come),
// first 20 unless expanded, columns = its mapped fields. Each step supplies how to draw a cell.
const PREVIEW_ROWS = 20;

// The record a value in an entity's table comes from: the first of its rows with a value for the field.
export const srcOf = (entity, f) => {
  const rows = entity.rows.map((n) => state.byRow.get(n));
  return rows.find((x) => x?.clean.values[f]) ?? rows[0];
};

export function entityTables(container, cell, { rerender, keep = () => true, kinds = ['provider', 'practice', 'billing', 'network'] }) {
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