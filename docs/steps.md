# Processing steps

Every roster goes through the same six steps, from the command line and from the UI: both run [`runSheets`](../src/pipeline.ts) on the same code. Each step's code lives in its own folder under `src/`.

| Step | Code | What it does |
| --- | --- | --- |
| [1. Read](#1-read) | `src/read/` | Reads any `xlsx`, `xls` or `csv` into sheets of rows; removes SSNs |
| [Transform](#transform-not-built-yet) | not built | Reshape when needed: wide files with several locations per row become one row per location |
| [2. Map](#2-map) | `src/map/` | Finds the header row, matches columns to schema fields, detects the action and category |
| [3. Standardize](#3-standardize) | `src/standardize/` | Cleans each value into its standard format; marks rows that can't move forward |
| [4. Validate](#4-validate) | `src/validate/` | Checks NPIs with NPPES and addresses with the US Census geocoder |
| [5. Review](#5-review) | `src/review/` | Groups rows into providers, practice locations and billing entities |
| [6. Export](#6-export) | `src/export/` | Writes a workbook per sheet: Summary, Mapping, Data, Issues and Left out |

To see what each step did to a roster, run it one step at a time: `rostermapper roster.xlsx --steps` prints each step's result and waits for Enter between steps. In the UI, choose **Step by step**. See [Usage](usage.md).

## 1. Read

- Reads xlsx, xls or csv, every sheet. In the UI, files are read in the browser.
- SSN columns (headed SSN, SS#, Social Security Number, TIN/SSN, …) are removed whole, and any SSN-shaped value (`123-45-6789`) is replaced, as the file is read. They're never shown, kept or exported.
- A password-protected file says so: remove the password in Excel and load it again.
- In the UI, pick a sheet if the file has several; from the command line, `--sheet`, or it asks (every sheet when no one is at the terminal).

Options that apply to the whole run (UI: **New run**; CLI: flags):

- **Action** (`ADD`, `UPDATE` or `TERM`). Otherwise detected, per row: an action column, then the sheet name, then the file name, else `ADD`.
- **Default effective date**: for rows whose effective date is blank. Each filled row gets a note.
- **Contract ID** and **sender email**: written into every record.
- **Mapping file**: a CSV of `column,field` lines that override matching for specific headers, so a sender's quirks are fixed once and reused. `ignore` skips a column. The UI's Map step can save one ("Download mapping file").
  ```
  column,field
  USE DATE,network.effective_date
  Supervising NPI,ignore
  ```

## Transform (not built yet)

Planned: a decision model runs through a series of questions to determine what transformations, if any, a sheet needs.

- Are providers listed with several locations on the same row (wide)? Then the file needs to become one row per location. *Detected today, not fixed:* when rows fill more than one practice address block (counted by ZIP and city columns; billing, mailing and home addresses don't count), the UI shows a banner and the CLI prints a `transform likely` line.
- Are any columns merged, and need splitting ("Full Name")?
- Is the action a column, different per row, or the same for the sheet? Is it in the file name, the sheet name, or set by the user?
- Is the sheet divided into separate tables that can be combined?
- Does the file have several header rows? Then make a sheet for each.

## 2. Map

- **Find the header row**: scan the first 30 rows and pick the one that looks most like labels, with data below it. `--header-row` (or a click on the UI's Upload preview) overrides it.
- **Normalize headers**: lower case, no underscores: `PROV_FIRST_NM` becomes `prov first nm`. Apply the vocabulary in `schema/vocab.yaml` (abbreviations, stopwords).
- **Detect value types**: profile each column's values as NPI, TIN, date, phone, ZIP, state and so on, from digit checks and patterns.
- **Match to fields**: compare each header with every field's aliases in `schema/fields.yaml` and give each field its best-scoring column. See [Canonical fields](canonical_fields.md) and the rules at the top of `src/map/match/index.ts`.
- **Apply overrides**: a mapping file, or a change made on the UI's Map step, wins over the score.
- **Suggest**: columns no field took that probably fit a field nothing mapped, from a weaker header match or distinctive values (NPIs, DEAs, tax IDs). The UI offers them as one-click pills; the CLI shows `maybe <field>`.
- **Action and category**: the action per row (see Read) and whether the sheet lists `individual` providers or `facility` rows (`--category`, else the sheet or file name, else the columns).

Columns not mapped are grouped as suggested, no match, other addresses (need a transform) and ignored. Numbered or repeated headers ("Alt City 1–4") fold into one chip in the UI.

## 3. Standardize

Each value is put in its field's format:

- Dates become `YYYY-MM-DD`
- NPIs become 10 digits, tax IDs `XX-XXXXXXX`, ZIPs 5 digits (leading zeros Excel drops are restored), phones `XXX-XXX-XXXX`
- States become two-letter codes
- Yes/No becomes `1`/`0`
- Provider types become `SPEC`, `PCP`, `BH`, `APP` or `HOSP`; location types `Primary`, `Secondary` or `Alternate`; actions `ADD`, `UPDATE` or `TERM`
- Names and cities in ALL CAPS or lowercase become Title Case; degrees lose their dots (`M.D.` → `MD`); license, taxonomy and DEA codes become uppercase; emails lowercase
- PO boxes become `PO Box 123`. A suite left in address line 1 moves to line 2 in Validate, using the street the geocoder matched
- Values that can be told wrong on their own are flagged: an NPI that fails its check digit, a tax ID prefix the IRS doesn't assign, a taxonomy code not in the [NUCC](https://www.nucc.org/) list (v26.1; `pnpm nucc` refreshes it)
- Anything that can't be cleaned is kept as written and flagged

In the UI, ✎ on a name, address or flagged value fixes it by hand; "As written" shows the values before cleaning.

### Rows left out

A row that can't move forward is left out of the output's Data and listed, with the reason, on Left out (or in `<name>_issues.csv` with `-o file.csv`). The output plus the rows left out always add up to every row. A row is left out when:

- the primary NPI is blank or `N/A` (the provider's NPI; the billing NPI in a facility roster)
- any NPI fails standardization: not 10 digits, or a bad check digit
- it's an `ADD` with no billing TIN
- Validate finds that NPPES doesn't have the NPI, has deactivated it, lists it under another type (an organization's NPI as a provider's), or lists it under a different first and last name, or under another last name while it has the provider under another NPI

A row with no practice address is kept and flagged as missing it; it just has no practice location (a location name alone isn't a place). `--keep-dropped` writes left-out rows to Data too.

## 4. Validate

Only outside sources, and only the ones turned on (`--no-nppes`, `--no-census`; the UI's External sources). Only an NPI, a provider's name or an address line is sent.

- **NPPES** ([NPI Registry](https://npiregistry.cms.hhs.gov/)): each NPI must exist and be active; Type 1 for providers, Type 2 for billing. Names, gender, degree, taxonomy and license are compared with the record.
- **US Census geocoder**: practice and billing addresses; city, state and ZIP compared. An address it can't find is retried with the street alone (no suite or building name) and with the 2020 address ranges. Still not found is shown but isn't an issue: many newer and commercial addresses aren't in the Census street ranges.

What's applied without asking (trusted): the Census geocoder's city, state, ZIP and suite on line 2, and NPPES's legal name for a billing NPI, with entity types shortened (`Professional Limited Liability Company` → `PLLC`). A legal name sharing no word with the roster's is only suggested, with a warning. In the UI, "undo" puts the roster's value back.

What's only suggested: NPPES's credential and taxonomy (NPPES is often slow to update them; the roster's value is kept and a difference isn't an issue), and small name, gender and license differences (a typo, a nickname). Large differences are issues: one name nothing like NPPES's, or first and last name swapped. When both names are unlike NPPES's, the NPI belongs to someone else and the row is left out. When a provider's NPI is under another last name, NPPES is searched by the roster's name; if it has the provider under another NPI, the row is left out with that NPI suggested ("Use" in the UI puts it in and keeps the row).

Lookups run 4 at a time, retry when rate-limited, and are kept between runs in `~/.cache/rostermapper/lookups.json` (NPPES answers for 7 days, Census for 90; readable only by you). `--no-cache` looks everything up again; delete the file to clear it. Bulk work should use the monthly NPPES file instead.

## 5. Review

Rows grouped into what they describe: unique providers (by NPI), practice locations (by address) and billing entities (by TIN, group NPI and address), and which provider works where and bills through whom. The UI shows them as a table of provider × location × billing combinations or as a graph, with every issue by row. `--steps` prints the counts.

## 6. Export

The default output is one workbook per sheet, `RM_<file>_<sheet>.xlsx`, with five tabs:

| Tab | What it holds |
| --- | --- |
| Summary | The file, the lookups used, and per sheet: header row, action and category (and why), columns mapped, rows moved forward, left out and with issues |
| Mapping | Each column, the field it went to (or why not), its score and why; then required fields no column holds |
| Data | The rows that move forward, one record per row (see below) |
| Issues | One line per problem, on every row, with whether the row was left out |
| Left out | Each row left out, the reason, other issues, and its values, so it can be fixed and sent again |

The name: `RM` marks Roster Mapper output, then the roster's name without its extension and the sheet name, each with spaces dropped: `Q3 Roster.xlsx`, sheet `LOC TERM` → `RM_Q3Roster_LOCTERM.xlsx`. When that name is taken, the time is added (`_20261117-143005`).

Given several files or a folder, each is mapped as on its own into a new folder for the run, `output/<date-time>/`, so a batch never mixes with or overwrites another. `summary.xlsx` there has one line per sheet (action, category, rows moved forward and left out, its workbook) and one per file that couldn't be mapped, and why. A failed file doesn't stop the batch. In a folder, Excel lock files (`~$…`), hidden files and Roster Mapper's own output (`RM_…`, `summary.xlsx`) are skipped; subfolders aren't read. The UI's "Download all" gives the same files in a zip.

Other formats: `-o file.xlsx` puts every sheet in one workbook; `-o file.csv` or `-o file.json` writes the records, with the rows left out in `<name>_issues.csv`.

### Records

One record per row, every field present (empty when the file has no value). Columns in order: the file fields, then the network fields (action, effective date, …), then provider, practice and billing fields, then `issues`. Fields marked hidden in the schema (CAQH ID, email, website, location type, BH, note) are left out unless a record has a value for them. See [Canonical fields](canonical_fields.md).

The file fields are set once per sheet and written into every record:

| Field | What it holds |
| --- | --- |
| `file.name` | File name and extension |
| `file.sheet` | Sheet name |
| `file.action` | `adds`, `terms`, `update` or `mixed` (rows with different actions): set by the user, otherwise detected |
| `file.category` | `individual` or `facility`: set with `--category`, else `facility` when the sheet or file name says so, else `individual` when a column holds the provider's NPI, name, birth date or gender, else `facility` when only a practice or billing organization is named |

## Not built yet

- [ ] The [Transform](#transform-not-built-yet) step
- [ ] Validate addresses with USPS (needs an API key; the Census geocoder is used for now)
- [ ] Decision models: derive a required field from another column (an effective date in a notes column)
- [ ] Keep UI edits and accepted suggestions across a refresh
