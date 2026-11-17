# Roster Mapper

Provider rosters come in various shapes and formats. Roster Mapper turns any roster file into a ready-to-process change file for your roster directory.

# How it works

## Summary

| Steps                                   | What it does                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0. File Upload](#0-file-upload)                     | Reads any `xlsx`, `xls` or `csv` into sheets of rows                                                               |
| [1. Transform (not implemented yet)](#1-transform-not-implemented-yet) | Reshape when necessary: wide files with several locations per row become one row per location;  combined fields like "Full Name" get split               |
| [2. Map](#2-map)                             | Find the header row, match columns to canonical fields.                                                    |
| [3. Standardize](#3-standardize)                     | Clean each value: ISO dates, `XX-XXXXXXX` TINs, 5-digit ZIPs, phone format, 0/1 flags, state codes, Title Case names and cities |
| [4. Validate](#4-validate)                     | Check values against public sources: NPI in NPPES, taxonomy in NUCC, address with the US Census geocoder|
| [5. Review](#5-review)                         | Visualize provider-practice-billing relationships as a table or a graph                               |
| [6. Export](#6-export)                          | Export clean change file for processing                                                                            |

## 0. File Upload 

- Drop one or more files (xlsx, xls or csv), or a folder of them ("Open a folder" picks one). Files are read on your machine.
- **Quick** (the default) runs every step on every file with the recommended options: the settings below, the best mapping, Census addresses and NPPES legal names applied, and NPPES's verdicts as issues, the same as the CLI. **Results** lists each sheet with its rows moved forward, left out and with issues, then every row left out and why, and every issue. Each sheet downloads as a workbook; "Download all" gives a zip of them with `summary.xlsx`. Several files are listed on the left; click one (or its name in Results) to open it in the steps and see or change what happened.
- **Step by step** opens each file at Upload instead, to pick a sheet and go through the steps. "Run all steps" finishes a file from wherever you are.
- In the steps, pick a sheet if the file has several. SSN columns and any SSN-shaped value are removed as it's read; they're never shown, kept or exported.
- *Optionally*, set the action (`ADD`, `UPDATE` or `TERM`). Otherwise it's detected from an action column, then the sheet name, then the file name.
- *Optionally*, load a mapping file: a CSV of `column,field` lines that override matching for specific headers, so a sender's quirks are fixed once and reused. `ignore` skips a column. The Map step can save one with "Download mapping file".
  ```
  column,field
  USE DATE,network.effective_date
  Supervising NPI,ignore
  ```
## 1. Transform (not implemented yet)
Planned: a decision model runs through a series of questions to determine what transformations, if any, a sheet needs.
- a. are providers listed with multiple locations on the same row (wide)? if yes, file needs to be transformed to "long" format. *Detected today, not fixed:* when rows fill more than one practice address block (counted by ZIP and city columns; billing, mailing and home addresses don't count), a banner says the sheet likely needs a transform and the CLI prints a `transform likely` line.
- b. are any columns merged or combined together, and therefore require splitting?
- c. is the `action_type` listed as column, i.e. different per row, or is it the same action for this tab? is the `action_type` listed in the file name, sheet name, or selected by the user.
- d. is the sheet divided into separate tables? if so, can they be combined?
- e. does the file contain multiple `header_rows`? if so, create a new tab for each, with the top row being the header? If no, which is the `header_row`?

## 2. Map

The mapping step follows a specific sequence of steps:
- **Find header row** → scans the first 30 rows and picks the one that looks most like labels, with data below it. 
- **Normalize headers**: Transform to lower case and remove underscores: `PROV_FIRST_NM` becomes `prov first nm`. Apply any vocabulary transformations.
- **Detect value types**: Part of profiling a specific column, run a digit check to profile a column as NPI, TIN, date, phone, zip, state, and so on. 
- **Match to canonical targets**:  Compare column names to each field's aliases in `schema/fields.yaml` and assign based on column scoring. See [Canonical Fields](docs/canonical_fields.md).
- **Apply overrides**: a mapping file, or a change made on the Map step, wins over the score.
- **Suggest**: columns no field took that probably fit a field nothing mapped, from a weaker header match or distinctive values (NPIs, DEAs, tax IDs). The Map step offers them as one-click "use" buttons in the field's row; the CLI shows `maybe <field>`.

Columns not mapped are grouped as suggested, no match, other addresses (need a transform) and ignored. Numbered or repeated headers ("Alt City 1–4") fold into one chip.

## 3. Standardize

Transform column values to specific formats: 
- Dates become `YYYY-MM-DD`
- NPIs become 10 digits, tax IDs `XX-XXXXXXX`, ZIPs 5 digits (leading zeros Excel drops are restored), phones `XXX-XXX-XXXX`
- States become two-letter codes
- Yes/No becomes `1`/`0`
- Provider types become `SPEC`, `PCP`, `BH`, `APP` or `HOSP`; location types `Primary`, `Secondary` or `Alternate`; actions `ADD`, `UPDATE` or `TERM`
- Names and cities in ALL CAPS or lowercase become Title Case; degrees lose their dots (`M.D.` → `MD`); license, taxonomy and DEA codes become uppercase; emails lowercase
- PO boxes become `PO Box 123`. A suite left in address line 1 is moved to line 2 in Validate, using the street the geocoder matched
- Anything that can't be cleaned is kept as written and flagged
- An NPI that is blank (or `N/A`), not 10 digits or fails the check digit drops the row (see [Dropped rows](#dropped-rows))

## 4. Validate
- NPI check digit; tax ID format and IRS prefix; taxonomy code in the [NUCC](https://www.nucc.org/) list (v26.1; `pnpm nucc` refreshes it).
- Check each NPI against [NPPES](https://npiregistry.cms.hhs.gov/) (must exist and be active; Type 1 for providers, Type 2 for billing) and names, gender, degree, taxonomy and license are compared with the record. 
- Check practice and billing addresses against the US Census geocoder and city, state and ZIP compared. Use the US Census format by default.
- NPPES's legal name for a billing NPI is applied by default, entity types shortened (`Professional Limited Liability Company` → `PLLC`); undo puts the roster's back. A name sharing no word with the roster's is only suggested, with a warning.
- When a provider's NPI is under another last name, NPPES is searched by the roster's name. If it has the provider under another NPI, the row is dropped and that NPI suggested (in the UI, "Use" puts it in and keeps the row).
- An address the Census geocoder can't find is retried with the street alone (no suite or building name) and with the 2020 address ranges. Still not found is shown on the card but isn't an issue: many newer and commercial addresses aren't in the Census street ranges. USPS would cover them (see TODO).
- Degrees and taxonomies keep the roster's values by default: NPPES is often slow to update them. NPPES's credential and taxonomy are offered as suggestions to accept one by one ("Use"), left out of "Use all", and a difference isn't an issue.
- Small differences from NPPES in names, gender and license (a typo, a nickname) are suggestions. Large ones are also issues: one name nothing like NPPES's, or first and last name swapped. When both first and last name are unlike NPPES's, the NPI belongs to someone else and the row is dropped.

### Dropped rows
A row that can't move forward is left out of Review's table and graph and of the export, and listed under Review's issues, dropped rows first. Validate still shows it, so a suggested fix (the right NPI) can bring it back. A row is dropped when:
- the primary NPI is blank or `N/A` (the provider's NPI; the billing NPI in a facility roster)
- it's an ADD with no billing TIN

A row with no practice address is kept, flagged as missing it; it just has no practice location (a location name alone isn't a place).

Every row left out goes to an issues file, `RM_<file>_<sheet>_issues.csv` ("Download issues" on Export; written next to the output by `-o`): the row number, `reason` (what dropped it), `other_issues`, and the row's values, so it can be fixed and sent again. Output plus issues file always add up to every row.
- any NPI fails standardization: not 10 digits, or a bad check digit
- NPPES doesn't have the NPI, has deactivated it, or lists it under another type (an organization's NPI as a provider's)
- NPPES lists the provider's NPI under a different first and last name, or under another last name while it has the provider under another NPI

## 5. Review
A table of every unique provider × practice location × billing entity combination with the rows that describe it (default), or a graph with lines between them. Below it, every issue by row: required fields missing for the row's action, values that couldn't be cleaned, values that failed validation. Required fields per action: see [Canonical fields](docs/canonical_fields.md).

## 6. Export
Download a workbook with the whole result (Summary, Mapping, Data, Issues and Left out tabs), or one record per data row as `csv` or `json`. CSV columns: the file fields, the network fields (action, effective date, …), then provider, practice and billing fields, then `issues`. Fields marked hidden in the schema (CAQH ID, email, website, location type, BH, note) are left out unless a record has a value for them.

The file fields are set once per sheet and written into every record. They're not shown in the UI.

| Field           | What it holds                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `file.name`     | file name and extension                                                                                                        |
| `file.sheet`    | selected sheet name                                                                                                            |
| `file.action`   | `adds`, `terms`, `update` or `mixed` (rows with different actions): the action set by the user, otherwise the detected one     |
| `file.category` | `individual` or `facility`: set with `--category`, else `facility` when the sheet or file name says so, else `individual` when a column holds the provider's NPI, name, birth date or gender, else `facility` when only a practice or billing organization is named |

The output file is named `RM_<file>_<sheet>.<ext>`: the `RM` prefix marks it as Roster Mapper output, then the roster's name without its extension and the sheet name, each with spaces dropped. `Q3 Roster.xlsx`, sheet `LOC TERM` → `RM_Q3Roster_LOCTERM.csv`. The UI's downloads use it, and so does the CLI: it saves one workbook per sheet to `./output/` (or the folder `-o` names), adding the time (`_20261117-143005`) when that name is taken. The workbook has five tabs: Summary, Mapping (each column, its field and why), Data (the rows that move forward), Issues (one line per problem) and Left out (each dropped row, its reason and values). `-o file.xlsx`, `-o file.csv` or `-o file.json` holds every sheet in one file instead.

Given several files or a folder, the CLI maps each one, every sheet, into a new folder for the run: `output/20261117-143005/` (under `-o`'s folder, if given). So a batch never mixes with or overwrites another. `summary.xlsx` there has one line per sheet (action, category, rows moved forward and left out, its workbook), plus one per file that couldn't be mapped and why. A failed file doesn't stop the batch. In a folder, Excel lock files (`~$…`), hidden files and Roster Mapper's own `RM_…` output are skipped; subfolders aren't read.



# Usage & Installation

Needs Node 22+.

## Command line

```
npm install -g rostermapper
```
```
rostermapper roster.xlsx            # runs every step in the terminal; saves output/RM_roster_<sheet>.xlsx
rostermapper roster.xlsx --ui       # opens the UI with the file loaded
rostermapper inbox/                 # every roster in the folder (or list several files): output/<date-time>/, with summary.xlsx
rostermapper                        # opens the UI; upload there
rostermapper roster.xlsx -o result.xlsx   # one workbook, every sheet
rostermapper roster.xlsx -o clean.csv     # records as CSV; rows left out, and why, in clean_issues.csv
rostermapper fields                 # the data dictionary
rostermapper --help                 # every option: -s sheet, -a action, -c category, --header-row, -m mapping, -o output, --no-nppes, --no-census, --keep-dropped, --why, --json
```

## Library

```
npm install rostermapper
```
```ts
import { automap, toCsv } from 'rostermapper';
import { readWorkbook } from 'rostermapper/workbook';

const [sheet] = readWorkbook(readFileSync('roster.xlsx'));   // SSNs are removed on read
const result = automap(sheet.rows, { fileName: 'roster.xlsx', sheetName: sheet.name });
writeFileSync('clean.csv', toCsv(result.records));
```

`automap` returns the mapping (each column, its field and why), the records (one per row with every field and its issues), the detected action and category, missing required fields and suggestions. Everything the CLI and UI do is in the library; see `src/index.ts` for the full API.

## From source

```
git clone https://github.com/costpluswellness/rostermapper.git && cd rostermapper
pnpm install && pnpm build
node dist/cli.js roster.xlsx
```

# Schema 
Fields live in `schema/fields.yaml`: type, description, format, required and preferred actions, aliases. After editing it run `pnpm schema`, which regenerates `src/schema.generated.ts` and [docs/canonical_fields.md](docs/canonical_fields.md); CI fails if either is stale. Taxonomy codes come from NUCC's CSV via `pnpm nucc`.

# Development
`dev/rmap <file> [options]` runs the CLI straight from `src/`, no build and no pnpm: every edit shows on the next run, in about half a second. Link it onto your PATH once to run it from any folder: `ln -s "$PWD/dev/rmap" ~/.local/bin/rmap`, then `rmap roster.xlsx`. `pnpm cli` does the same, a second slower. Both need `pnpm install` once (for tsx). The UI's page is served from `dist/ui/`, so after changing `site/` or `src/`, run `pnpm build`, then `rmap` (no file) or `rmap roster.xlsx --ui`, and reload the page. `pnpm check` runs the schema check, typecheck and build (CI runs the same). Put real rosters in `samples/`, which is git-ignored: they hold provider PII and must never be committed.

# TODO
- [ ] create the [1. Transform (not implemented yet)](#1-transform-not-implemented-yet) step
- [ ] validate addresses with USPS (needs an API key; the Census geocoder is used for now)
- [ ] Decision Models: derive a required field from another column (e.g. an effective date in a notes column)
- [ ] persist UI edits and accepted suggestions across a refresh
- [ ] split `site/app.js` into one module per step
- [ ] make a landing page for outside users using [Knap.md](https://knap.md/) and  [Defuddle](https://defuddle.md) format 

# Data sources & licenses

Roster Mapper is MIT licensed. It uses three public sources; see [NOTICE](NOTICE) for the full text.

- **NPPES NPI Registry**: public-domain US government data, no key. NPPES limits queries per hour; lookups are one per NPI and kept between runs in `~/.cache/rostermapper/lookups.json` (NPPES answers for 7 days, Census for 90; readable only by you, since it holds NPIs, names and addresses from rosters). `--no-cache` looks everything up again; delete the file to clear it. Bulk work should use the monthly NPPES file instead.
- **US Census Bureau Geocoder**: public domain, no key. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.
- **NUCC Health Care Provider Taxonomy**: © American Medical Association, published with NUCC. Embedded unchanged under its own notice, which permits copying as long as the notice stays, the contents are not changed and the copies are not sold or licensed. It is not covered by the MIT license; a product that sells or licenses the taxonomy itself needs NUCC's free license.

# Notes & References
- The library is the code in `src`. The logic all lives in this package. 
- It's written in TypeScript because it can run in the browser. Python, on the other hand, can't run in a web page.
- No dependencies beyond `SheetJS` for reading files
- The CLI and the UI (`site/`) are thin wrappers. They only handle input and output. 
- The UI is served by the CLI on 127.0.0.1. Files never leave the machine, except NPIs and addresses sent for Validate's lookups.
