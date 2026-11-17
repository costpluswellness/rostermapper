import { cleanValue, applyDropRules } from '../rostermapper.js';
import { specOf } from '../lib.js';
import { state } from '../state.js';
// Standardizing happens in automap (values cleaned as they're read). Here: values typed by hand on
// Review (an issue's "edit") replace the cleaned ones, row by row.
// Values typed by hand replace the cleaned ones, before Validate's checks see them.
// They're cleaned and checked like any other value, so a mistyped NPI stays flagged.
export function applyFixes() {
  for (const r of state.result.records) {
    const fixes = state.fixes.get(r.row);
    if (!fixes?.size) continue;
    r.issues = r.issues.filter((i) => !(fixes.has(i.field) && (i.kind === 'format' || i.kind === 'missing')));
    for (const [f, typed] of fixes) {
      const spec = specOf(f);
      const { value, issue } = cleanValue(f, spec.type, typed, spec.values);
      r.values[f] = value;
      const allowed = [...(state.allowed.get(f) ?? [])].some((v) => v.toLowerCase() === value.trim().toLowerCase());
      if (issue && !(allowed && spec.type === 'enum')) r.issues.push({ field: f, kind: 'format', message: issue });
    }
    applyDropRules(r, state.result.file.category); // a fixed NPI no longer drops the row; a mistyped one still does
  }
}