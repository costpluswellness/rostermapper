# Data sources

Roster Mapper checks rosters against three public sources. NPPES and the US Census geocoder are looked up live, in [Validate](steps.md#4-validate), and only an NPI, a provider's name or an address line is sent to them. The NUCC taxonomy ships with Roster Mapper, so checking a taxonomy code sends nothing.

## NPPES

The [NPI Registry](https://npiregistry.cms.hhs.gov/) from CMS (the National Plan and Provider Enumeration System) lists every NPI with its owner's name, type, taxonomy, license and addresses.

- Each NPI must exist and be active, and be Type 1 for a provider or Type 2 for billing. A row whose NPI fails this is left out.
- The provider's name, gender, degree, taxonomy and license are compared with the roster. A name that doesn't match is an issue, and when a provider's NPI is under another last name, NPPES is searched by name for the provider's own NPI.
- A billing NPI's legal name is applied, and a blank taxonomy or legal name is filled from NPPES.
- Turned off with `--no-nppes`. Answers are cached for 7 days.

## US Census geocoder

The [Census Geocoder](https://geocoding.geo.census.gov/geocoder/) from the US Census Bureau matches a street address to the Census street ranges.

- Practice and billing addresses are looked up, and city, state and ZIP are compared with the roster.
- The geocoder's city, state and ZIP are applied, and a suite left in address line 1 moves to line 2.
- An address it can't find is retried with the street alone and with the 2020 address ranges. Still not found is shown but isn't an issue, since many newer and commercial addresses aren't in the Census ranges.
- Turned off with `--no-census`. Answers are cached for 90 days.

## NUCC

The [NUCC Health Care Provider Taxonomy](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40) from the National Uniform Claim Committee is the code set for provider types and specialties (`207Q00000X` is Family Medicine).

- Taxonomy codes are uppercased in Standardize, and a code not in the list (v26.1) is flagged.
- The list is built into Roster Mapper, so no lookup is made. `pnpm nucc` refreshes it when NUCC publishes a new version, each January and July.
- Used under NUCC's notice; see [NOTICE](../NOTICE).
