# Contributing

Node 22+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm check      # schema check, typecheck, tests, build; CI runs the same
```

## Layout

```
src/
  pipeline.ts      the steps in order (runSheets); what the CLI and the UI both run
  read/            1 Read: spreadsheets into rows (SheetJS), SSN removal
  map/             2 Map: header row, column profiles, matching, action, category, mapping files
  standardize/     3 Standardize: cleaning values, building records, rows left out
  validate/        4 Validate: NPPES and Census checks (pure), live lookups and their cache (Node)
  review/          5 Review: providers, locations, billing entities
  export/          6 Export: report tables, CSV, workbooks (SheetJS)
  schema/          field list and types, generated from schema/*.yaml and the NUCC CSV
  cli/             the command line, its terminal output, and the local server for the UI
  index.ts         rostermapper: the library, no I/O
  workbook.ts      rostermapper/workbook: read and write spreadsheets
  node.ts          rostermapper/node: files on disk and live lookups; the CLI runs on it
ui/                the browser UI: app.js, results.js and one module per step in ui/steps/
schema/            fields.yaml and vocab.yaml: the source of the schema
docs/              usage, processing steps, canonical fields (generated)
scripts/           schema and NUCC generators; rmap, the CLI from source; the demo's builders
demo/              the public demo site: sample rosters, site styles, the lookup function (demo/README.md)
test/              node:test tests on a synthetic roster (test/fixtures/)
```

Keep the steps' code free of I/O: reading files, network calls and writing output belong to `node.ts`, `cli/` and `ui/`. A change to how rosters are processed goes in `src/` so the CLI and the UI both get it.

## Running from source

`scripts/rmap <file> [options]` runs the CLI straight from `src/`, no build and no pnpm: every edit shows on the next run. Link it onto your PATH once to run it from any folder: `ln -s "$PWD/scripts/rmap" ~/.local/bin/rmap`. `pnpm cli` does the same, a second slower.

The UI is served from `dist/ui/`, so after changing `ui/` or `src/`, run `pnpm build`, then `rmap --ui` (or `rmap roster.xlsx --ui`) and reload the page. `BROWSER=none` serves it without opening a browser; `PORT` picks the port.

## Schema

Fields live in `schema/fields.yaml`: type, description, format, required and preferred actions, aliases. After editing it run `pnpm schema`, which regenerates `src/schema/schema.generated.ts` and `docs/canonical_fields.md`; CI fails if either is stale. Taxonomy codes come from NUCC's CSV via `pnpm nucc <file.csv>`.

## Data

Real rosters hold provider PII: keep them in the git-ignored `samples/` and never commit them. The CLI's `output/` is git-ignored too. Tests use `test/fixtures/roster.csv`, made-up providers only.
