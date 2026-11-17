# Changelog

## Unreleased

- Rows that can't move forward are dropped from the export and listed as issues: no NPI (blank or N/A), an NPI that fails standardization, or one NPPES doesn't have, has deactivated, lists as an organization, or lists under a different first and last name
- NPPES warnings become issues: one name or the credential far from NPPES's, first and last name swapped, a source that didn't answer
- `--no-ui` runs every step in the terminal, NPPES and Census lookups included (`--keep-dropped` keeps dropped rows in the output)
- The CLI runs in the terminal by default (`--ui` opens the browser UI; `--no-ui` is still accepted) and saves one workbook per sheet to `./output/`, named like the UI's downloads (`RM_<file>_<sheet>.xlsx`, with a timestamp when the name is taken)
- Bulk: `rostermapper inbox/` (or several files) maps every roster into `output/<date-time>/`, one workbook per sheet, plus `summary.xlsx` listing each sheet and each file that failed
- `-o result.xlsx` writes the whole result as one workbook: Summary, Mapping (each column and its field, or why not), Data, Issues (one line per problem) and Left out; the terminal then shows a short summary instead of the full report
- `dev/rmap` (and `pnpm cli`) run the CLI from source with no build; `dev/rmap` skips pnpm too
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
