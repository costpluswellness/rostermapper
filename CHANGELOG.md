# Changelog

## Unreleased

- Rows that can't move forward are dropped from the export and listed as issues: no NPI (blank or N/A), an NPI that fails standardization, or one NPPES doesn't have, has deactivated, lists as an organization, or lists under a different first and last name
- NPPES warnings become issues: one name or the credential far from NPPES's, first and last name swapped, a source that didn't answer
- `--no-ui` runs every step in the terminal, NPPES and Census lookups included; dropped rows go to a `*_dropped` file (`--keep-dropped` keeps them in the output)
- NPPES and Census lookups retry when rate-limited
- A provider whose NPI is under another last name is searched by name in NPPES; when NPPES has them under another NPI, the row is dropped with the right NPI suggested ("Use" in the UI keeps the row)
- NPPES's legal name for a billing NPI is applied by default (entity types shortened: "Professional Limited Liability Company" → PLLC), with undo
- Census lookups retry with the street alone and with the 2020 address ranges; an address it can't find is no longer an issue. A building name before the house number moves to line 2
- Action values found anywhere in the cell: "Site/LocationAdd", "Site/LocationTerm"
- A password-protected file says so in the UI
- Back and Next sit under the step bar
- Degrees and taxonomies keep the roster's values by default; NPPES's are suggestions to accept one by one (not in "Use all"), never issues

## 1.0.0-beta

First public release.

- Reads xlsx, xls and csv rosters; SSNs are removed as the file is read
- Finds the header row, profiles columns and maps them to the canonical schema, with a mapping file for overrides
- Standardizes dates, NPIs, tax IDs, ZIPs, phones, states, flags, names and codes
- Validates against NPPES, NUCC and the US Census geocoder, plus local checks
- Reviews unique providers, locations and billing entities; exports CSV or JSON
- CLI with a local browser UI
