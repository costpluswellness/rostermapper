import { schema, standardRule } from './rostermapper.js';
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const show = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v));
export const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// Column names shown on the Map step, cut so a long header doesn't widen the tables and dropdowns.
// The full name stays in the tooltip.
const MAX_HEADER = 40;
export const shortHeader = (s) => { const t = oneLine(s); return t.length > MAX_HEADER ? `${t.slice(0, MAX_HEADER - 1).trimEnd()}…` : t; };
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const FIELD_IDS = Object.entries(schema.fields).flatMap(([group, fields]) => Object.keys(fields).map((name) => `${group}.${name}`));
export const STEPS = ['upload', 'map', 'standardize', 'validate', 'review', 'export'];
// Hover text for a field name: what it holds (first sentence) and how its values are standardized.
export const specOf = (id) => { const [g, n] = id.split('.'); return schema.fields[g][n]; };
// Fields typed on Upload (contract ID, sender email): one value for every row, never a column's, and
// left out of Map, Standardize and Validate. Hidden, so the export has them only when filled.
export const MAPPABLE_IDS = FIELD_IDS.filter((f) => !specOf(f).input);
export const fieldTip = (id) => { const f = specOf(id); return `${f.description.split('. ')[0].replace(/\.$/, '')}.\n${standardRule(id, f.type, f.values)}.`; };

// text, or a file's bytes (a workbook, a zip)
export function download(text, type, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const api = async (url) => {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body.result;
};
export const LOOKUP = {
  npi: (n) => api(`api/nppes?npi=${n}`),
  address: (line) => api(`api/census?address=${encodeURIComponent(line)}`),
  byName: (q) => api(`api/nppes-name?${new URLSearchParams(q)}`),
};