// Results: what a run did to every file, as the CLI's workbook tells it. The tabs are the workbook's
// tables (see export/tables.ts), across every file: Sheets (one line per sheet, with its workbook),
// Mapping, Issues and Left out. Each file opens in the steps from here, to see or change what happened.
import { counts, issueRows, leftOutRows, mappingRows, sheetEntry, sheetWorkbooks, toBatchSummary, toReport, toZip, outputName } from './rostermapper.js';
import { $, XLSX, download, esc, plural } from './lib.js';
import { state } from './state.js';
import { checkedWith, go, openFile, runFiles, timestamp } from './app.js';

const MAX = 500; // rows drawn per tab; the workbooks hold every one
let tab = 'sheets';
let filter = '';

/** The rail's file list: each file's name and how its run went. */
export function renderFiles() {
  const status = (f) => {
    if (f.status === 'error') return f.error;
    if (f.status !== 'done') return f.status === 'running' ? 'running…' : '';
    const c = counts(f.results.flatMap((r) => r.records));
    return `${c.movedForward} in · ${c.leftOut} out`;
  };
  $('rail-files').hidden = !state.files.length;
  $('file-list').innerHTML = state.files.map((f, i) =>
    `<li><a href="#" data-file="${i}"${i === state.current && state.step !== 'results' ? ' aria-current="true"' : ''} title="${esc(f.name)}">${esc(f.name)}</a>` +
    `<small class="${f.status === 'error' ? 'bad' : ''}">${esc(status(f))}</small></li>`).join('');
}
$('file-list').onclick = (e) => {
  const a = e.target.closest('[data-file]');
  if (a) { e.preventDefault(); openFile(+a.dataset.file); }
};

// Every sheet of every file that ran: { f (the file), i (its index), r (the sheet's result) }.
const sheetsDone = () => state.files.flatMap((f, i) => (f.results ?? []).map((r) => ({ f, i, r })));

// A table's rows with a "File" column first, for tables built per file.
const withFile = (name, rows, head) => (head ? [['File', ...rows[0]]] : []).concat(rows.slice(1).map((row) => [name, ...row]));

function tables() {
  const done = sheetsDone();
  const byFile = state.files.filter((f) => f.results?.length);
  const leftOut = byFile.flatMap((f, k) => {
    const rows = leftOutRows(f.results.flatMap((r) => r.records));
    const keep = ['file.sheet', 'row', 'reason', 'other_issues', 'provider.last_name', 'provider.first_name', 'provider.npi', 'billing.legal_name'].map((h) => rows[0].indexOf(h)).filter((x) => x >= 0);
    return withFile(f.name, rows.map((row) => keep.map((x) => row[x])), k === 0);
  });
  return {
    mapping: byFile.flatMap((f, k) => withFile(f.name, mappingRows(f.results), k === 0)),
    issues: byFile.flatMap((f, k) => withFile(f.name, issueRows(f.results.flatMap((r) => r.records)), k === 0)),
    leftOut,
    done,
  };
}

export function renderResults() {
  const { mapping, issues, leftOut, done } = tables();
  const all = counts(done.flatMap(({ r }) => r.records));
  const pending = state.files.filter((f) => f.status === 'waiting' || f.status === 'running').length;
  $('results-summary').textContent = [plural(state.files.length, 'file'), plural(all.rows, 'row'), `${all.movedForward} moved forward`, `${all.leftOut} left out`, `${all.withIssues} with issues`].join(' · ') +
    (pending ? ` · ${pending} to go…` : '');
  $('download-all').disabled = !done.length || pending > 0;
  $('download-all').textContent = done.length === 1 && !state.files.some((f) => f.error) ? 'Download workbook' : 'Download all';
  $('rerun').hidden = pending > 0 || !state.files.length;
  const count = (rows) => Math.max(0, rows.length - 1);
  const tabs = { sheets: ['Sheets', done.length], mapping: ['Mapping', count(mapping)], issues: ['Issues', count(issues)], leftOut: ['Left out', count(leftOut)] };
  $('results-tabs').innerHTML = Object.entries(tabs).map(([k, [label, n]]) => `<button type="button" data-tab="${k}"${k === tab ? ' class="on"' : ''}>${label} <span class="muted">${n}</span></button>`).join('');

  if (tab === 'sheets') return void ($('results').innerHTML = sheetsTable());
  const rows = { mapping, issues, leftOut }[tab];
  $('results').innerHTML = rows.length ? grid(rows) : '<tr><td class="muted">None.</td></tr>';
}

// One line per sheet: counts, the file's link into the steps, and its workbook.
function sheetsTable() {
  const num = (n) => `<td class="num">${n}</td>`;
  const match = (...cells) => !filter || cells.join(' ').toLowerCase().includes(filter);
  return '<tr><th>File</th><th>Sheet</th><th>Action</th><th>Category</th><th class="num">Rows</th><th class="num">Moved forward</th><th class="num">Left out</th><th class="num">With issues</th><th></th></tr>' +
    state.files.map((f, i) => {
      if (f.status !== 'done') return match(f.name, f.error ?? '') ? `<tr><td>${esc(f.name)}</td><td colspan="8" class="${f.status === 'error' ? 'bad' : 'muted'}">${esc(f.error ?? (f.status === 'running' ? state.progress || 'running…' : 'waiting'))}</td></tr>` : '';
      return f.results.filter((r) => match(f.name, r.sheet, r.action.action, r.category.category)).map((r) => {
        const c = counts(r.records);
        return `<tr><td><a href="#" data-open="${i}" data-sheet="${esc(r.sheet)}" title="Open in the steps">${esc(f.name)}</a></td><td>${esc(r.sheet)}</td><td>${esc(r.action.action)}</td><td>${esc(r.category.category)}</td>` +
          `${num(c.rows)}${num(c.movedForward)}${num(c.leftOut)}${num(c.withIssues)}<td><button type="button" class="textlink" data-dl="${i}|${esc(r.sheet)}" title="${esc(outputName(r.file, 'xlsx'))}">xlsx</button></td></tr>`;
      }).join('');
    }).join('');
}

// A report table, header first, filtered by the box above it. The File and Sheet cells open that sheet in the steps.
function grid([head, ...rows]) {
  const shown = filter ? rows.filter((row) => row.join(' ').toLowerCase().includes(filter)) : rows;
  const files = new Map(state.files.map((f, i) => [f.name, i]));
  const cell = (v, j, row) => (j === 0 && files.has(v) ? `<td><a href="#" data-open="${files.get(v)}" data-sheet="${esc(row[1])}">${esc(v)}</a></td>` : `<td${String(v).length > 40 ? ' class="long"' : ''}>${esc(v)}</td>`);
  return `<tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` +
    shown.slice(0, MAX).map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('') +
    (shown.length > MAX ? `<tr><td colspan="${head.length}" class="muted">… ${shown.length - MAX} more in the workbooks</td></tr>` : '') +
    (!shown.length ? `<tr><td colspan="${head.length}" class="muted">${filter ? 'No match.' : 'None.'}</td></tr>` : '');
}

$('results-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderResults(); } };
$('results-filter').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); renderResults(); };
$('step-results').onclick = (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); return openFile(+open.dataset.open, open.dataset.sheet); }
  const dl = e.target.closest('[data-dl]');
  if (dl) {
    const [i, sheet] = dl.dataset.dl.split('|');
    const f = state.files[+i];
    const r = f.results.find((x) => x.sheet === sheet);
    download(toReport(f.name, [r], { notes: { Checked: checkedWith() } }), XLSX, outputName(r.file, 'xlsx'));
  }
};
$('rerun').onclick = () => runFiles();
$('rail-results').onclick = (e) => { e.preventDefault(); if (state.files.some((f) => f.status !== 'waiting')) go('results'); else runFiles(); };

// The CLI's output, in the browser: one workbook per sheet (sheetWorkbooks), or for several, a zip of
// them with summary.xlsx (a browser can't save a folder): RM_20261117-143005.zip.
$('download-all').onclick = () => {
  const notes = { Checked: checkedWith() };
  const used = new Set();
  const unique = (name) => { let n = name; for (let k = 2; used.has(n); k++) n = name.replace(/\.xlsx$/, `_${k}.xlsx`); used.add(n); return n; };
  const files = [];
  const entries = [];
  for (const f of state.files) {
    if (f.error) entries.push({ file: f.name, sheet: '', error: f.error });
    for (const book of sheetWorkbooks(f.name, f.results ?? [], { notes })) {
      const name = unique(book.name);
      files.push({ name, bytes: book.bytes });
      entries.push(sheetEntry(f.name, book.result, name));
    }
  }
  if (files.length === 1 && !state.files.some((f) => f.error)) return download(files[0].bytes, XLSX, files[0].name);
  download(toZip([{ name: 'summary.xlsx', bytes: toBatchSummary(entries) }, ...files]), 'application/zip', `RM_${timestamp()}.zip`);
};
