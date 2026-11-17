import { $ } from '../lib.js';
import { checkedWith } from '../app.js';
import { isDropped, outputFields, outputName, outputOrder, toCsv, toIssuesCsv, toReport } from '../rostermapper.js';
import { FIELD_IDS, XLSX, download, esc, fieldTip, plural } from '../lib.js';
import { state } from '../state.js';
// ─── 6 Export ───────────────────────────────────────────────
// Rows with a drop issue (no NPI, a wrong NPI) never move forward: left out of the CSV and JSON.
const exported = () => state.result.records.filter((r) => !isDropped(r));
export function renderExport() {
  const { mapping } = state.result;
  const records = exported();
  const dropped = state.result.records.length - records.length;
  $('export-summary').textContent = `${plural(records.length, 'record')} from ${state.name} · ${state.sheet}, ${records.filter((r) => r.issues.some((i) => i.kind !== 'default')).length} with issues` +
    `${dropped ? `; ${plural(dropped, 'row')} left out (Download issues lists them and why)` : ''}. ` +
    `The CSV has ${outputFields(records).length} fields; the preview shows the ones with values.`;
  // Mapped fields, plus any filled in later (an accepted suggestion such as address line 2). The file fields aren't shown: see the download.
  const fields = outputOrder(FIELD_IDS).filter((f) => mapping[f] || f === 'network.action_type' || records.some((r) => r.values[f]));
  const shown = records.slice(0, 200);
  $('export-preview').innerHTML = `<tr>${fields.map((f) => `<th><span class="tip" title="${esc(fieldTip(f))}">${f}</span></th>`).join('')}<th>issues</th></tr>` +
    shown.map((r) => `<tr>${fields.map((f) => `<td>${esc(r.values[f])}</td>`).join('')}` +
      `<td class="issues">${r.issues.map((i) => `${esc(i.field)}: ${esc(i.message)}`).join('; ')}</td></tr>`).join('');
  $('export-more').textContent = records.length > shown.length ? `Showing the first ${shown.length} of ${records.length} records.` : '';
}

// Downloads are named RM_<file>_<sheet>.<ext>: "Q3 Roster.xlsx" / "LOC TERM" → RM_Q3Roster_LOCTERM.csv
$('export-xlsx').onclick = () => download(toReport(state.name, [{ ...state.result, sheet: state.sheet }], { notes: { Checked: checkedWith() } }), XLSX, outputName(state.result.file, 'xlsx'));
$('export-csv').onclick = () => download(toCsv(exported()), 'text/csv', outputName(state.result.file, 'csv'));
$('export-issues').onclick = () => download(toIssuesCsv(state.result.records), 'text/csv', outputName(state.result.file, 'csv', '_issues'));
$('export-json').onclick = () => download(JSON.stringify({ ...state.result, records: exported(), dropped: state.result.records.filter(isDropped) }, null, 2), 'application/json', outputName(state.result.file, 'json'));