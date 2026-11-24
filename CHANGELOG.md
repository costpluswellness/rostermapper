# Changelog

## Unreleased

- Demo site (`demo/`, `netlify.toml`): the docs with a sidebar, the UI at `/app/`, and six sample rosters in different shapes (tidy xlsx, hand-edited csv, database extract, several locations each, facilities in .xls, wide) built from a random sample of real NPIs from NPPES, with placeholder tax IDs. `pnpm demo` builds it, `pnpm demo:serve` serves it locally; see demo/README.md
- `session.samples` (`[{ file, title?, note? }]`): a host lists sample rosters, shown under the drop as "Try a sample"; each opens with `?sample=<file>`
- `answerLookup` in `src/validate/lookup.ts` answers the UI's lookup routes for any host (the CLI's server and the demo's function)

## 1.0.0-beta.1

- Host hooks for embedding: the page passes its query string to `session`, `file` and `mapping`, so a host can say which roster to open (`index.html?attachment=…`); `file` may answer with the roster's bytes, read like an upload; `session.send = { label }` adds a button next to Download that POSTs the result (each sheet's records, left-out rows included, mapping and counts) to the host's `send` route, which answers `{ message?, open? }`. `--send <url>` does it from the command line. See docs/usage.md, Embedding the UI
- UI: values changed on their own from NPPES or Census (a legal name, a city) are green on the cards like values filled in, so every automatic change can be reviewed; suggestions waiting for "Use" stay orange
- A blank billing legal name is filled from NPPES when the billing NPI is an active organization NPI, applied like NPPES legal names (undo it in the UI; shown in green as filled from NPPES)
- UI: New run is the drop, with the action, a mapping file and the lookups under it; contract ID and sender email are asked for at Download (Review's dialog, Results' Download all); dark by default, with a switch to light
- A blank taxonomy is filled with the provider's primary taxonomy from NPPES, applied like NPPES legal names and Census addresses (undo it in the UI)
- `--allow field=values` (and the `allowed` option of `automap` and `runSheets`): keep a sender's own codes as written instead of flagging them, for fields with a fixed list, like `--allow provider_type=AHP,PHYS`
- UI: one page per file, Review: its sheets as tabs (× ignores one), a graph or table whose cards carry the checks (problems highlighted, each NPI a link to the NPPES NPI Registry, "No taxonomy" and the like), its issues grouped by entity with their fixes (mapping, edit in place, "Use" for every row of the entity, "Allow" for a value outside a fixed list), Mapping and Raw data as dialogs, Run checks, and Download for one workbook of every sheet kept. The Map, Standardize, Validate and Export views and the Step by step mode are gone (`--steps` remains in the CLI)
- One pipeline for the CLI, the UI and the library: `runSheets` runs map, standardize, validate and review the same way everywhere
- `--steps` runs one step at a time and prints each step's result (read, map, standardize, validate, review, export), waiting for Enter between steps in a terminal
- `rostermapper/node`: `mapFile`, `mapFiles` and `writeOutput`, what the CLI runs, for use without the CLI or the UI
- UI: a workbench, with the files and the open file's steps (each with a count) in a rail, and a status bar with progress and Back/Next. **Run** (was Quick) runs every file as the CLI does; Results shows the workbook's own tables (Sheets, Mapping, Issues, Left out) with a filter
- `--ui` opens the UI even when output is piped; `BROWSER=none` serves it without opening a browser
- Source grouped by step (`src/read`, `map`, `standardize`, `validate`, `review`, `export`); `site/` is now `ui/`, `dev/rmap` is `scripts/rmap`
- Tests (`pnpm test`) on a synthetic roster; README trimmed to a flowchart and links, details in `docs/`
- Rows that can't move forward are dropped from the export and listed as issues: no NPI (blank or N/A), an NPI that fails standardization, or one NPPES doesn't have, has deactivated, lists as an organization, or lists under a different first and last name
- NPPES warnings become issues: one name or the credential far from NPPES's, first and last name swapped, a source that didn't answer
- `--no-ui` runs every step in the terminal, NPPES and Census lookups included (`--keep-dropped` keeps dropped rows in the output)
- The CLI runs in the terminal by default (`--ui` opens the browser UI; `--no-ui` is still accepted) and saves one workbook per sheet to `./output/`, named like the UI's downloads (`RM_<file>_<sheet>.xlsx`, with a timestamp when the name is taken)
- UI: drop several files or a folder ("Open a folder"); they're listed on the left. **Quick** (now **Run**), the default, runs every step on every file and shows Results: each sheet's counts, every row left out and why, every issue, a workbook per sheet and "Download all" (zip with `summary.xlsx`). **Step by step** opens each file at Upload; "Run all steps" finishes a file and goes to Export, which now downloads a workbook too
- Bulk: `rostermapper inbox/` (or several files) maps every roster into `output/<date-time>/`, one workbook per sheet, plus `summary.xlsx` listing each sheet and each file that failed
- `-o result.xlsx` writes the whole result as one workbook: Summary, Mapping (each column and its field, or why not), Data, Issues (one line per problem) and Left out; the terminal then shows a short summary instead of the full report
- `scripts/rmap` (and `pnpm cli`) run the CLI from source with no build; `scripts/rmap` skips pnpm too
- NPPES and Census answers are kept between runs (`~/.cache/rostermapper/lookups.json`; `--no-cache` to skip)
- An issues file lists every row left out of the output and why (`*_issues.csv`, "Download issues" on Export)
- NPPES and Census lookups retry when rate-limited
- A provider whose NPI is under another last name is searched by name in NPPES; when NPPES has them under another NPI, the row is dropped with the right NPI suggested ("Use" in the UI keeps the row)
- NPPES's legal name for a billing NPI is applied by default (entity types shortened: "Professional Limited Liability Company" → PLLC), with undo
- Census lookups retry with the street alone and with the 2020 address ranges; an address it can't find is no longer an issue. A building name before the house number moves to line 2
- Action values found anywhere in the cell: "Site/LocationAdd", "Site/LocationTerm"
- A password-protected file says so in the UI
- Back and Next sit under the step bar
- ADD rows with no billing TIN are dropped; a row with no practice address is kept but makes no location (a location name alone no longer does)
- Dropped rows are left out of Review's table and graph; a wrong-NPI card says why before offering the right NPI
- Degrees and taxonomies keep the roster's values by default; NPPES's are suggestions to accept one by one (not in "Use all"), never issues

## 1.0.0-beta

First public release.

- Reads xlsx, xls and csv rosters; SSNs are removed as the file is read
- Finds the header row, profiles columns and maps them to the canonical schema, with a mapping file for overrides
- Standardizes dates, NPIs, tax IDs, ZIPs, phones, states, flags, names and codes
- Validates against NPPES, NUCC and the US Census geocoder, plus local checks
- Reviews unique providers, locations and billing entities; exports CSV or JSON
- CLI with a local browser UI
