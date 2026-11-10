# Changelog

## 1.0.0-beta

First public release.

- Reads xlsx, xls and csv rosters; SSNs are removed as the file is read
- Finds the header row, profiles columns and maps them to the canonical schema, with a mapping file for overrides
- Standardizes dates, NPIs, tax IDs, ZIPs, phones, states, flags, names and codes
- Validates against NPPES, NUCC and the US Census geocoder, plus local checks
- Reviews unique providers, locations and billing entities; exports CSV or JSON
- CLI with a local browser UI
