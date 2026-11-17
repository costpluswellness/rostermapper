import { state } from '../state.js';
// The record a value in an entity comes from: the first of its rows with a value for the field.
export const srcOf = (entity, f) => {
  const rows = entity.rows.map((n) => state.byRow.get(n));
  return rows.find((x) => x?.clean.values[f]) ?? rows[0];
};
