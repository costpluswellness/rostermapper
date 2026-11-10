# Canonical fields

GENERATED from `schema/fields.yaml` by `pnpm schema`. Do not edit; edit the YAML and rerun.

One record per roster row, every field present (empty when the file has no value). The file fields come first, then the network, provider, practice and billing fields. The CSV export adds `row` after the file fields and `issues` last.

Levels per action (ADD, UPDATE, TERM): **R** required, rows missing it are flagged · **p** preferred, filled when the file has it · **·** optional.

## File

Set once per sheet, not mapped from columns, and written into every record. The name and sheet also name the output file: `RM_<file>_<sheet>.csv`, both with their spaces dropped (`Q3 Roster.xlsx`, sheet `LOC TERM` → `RM_Q3Roster_LOCTERM.csv`).

| Field | Description | Type | Format / values |
| --- | --- | --- | --- |
| `file.name` | File name and extension | string |  |
| `file.sheet` | Selected sheet name | string |  |
| `file.action` | The file action: set by the user, otherwise detected (see Action) | enum | `adds`, `terms`, `update`, `mixed` |
| `file.category` | Whether the sheet lists individual providers or facilities | enum | `individual` or `facility` |

## Provider

| Field | Description | Type | Format / values | ADD | UPDATE | TERM |
| --- | --- | --- | --- | :-: | :-: | :-: |
| `provider.npi` | Rendering provider's individual (Type 1) National Provider Identifier | digits | 10 digits, valid check digit | R | R | R |
| `provider.first_name` | Legal first name | string |  | p | · | · |
| `provider.middle_name` | Middle name or middle initial | string |  | · | · | · |
| `provider.last_name` | Legal last name | string |  | p | · | · |
| `provider.suffix` | Generational suffix | string | `Jr`, `Sr`, `II`, `IV` | · | · | · |
| `provider.degree` | Credentials, comma-separated if more than one | string | `MD`, `DO`, `NP` | p | · | · |
| `provider.gender` | Gender | enum | `M` or `F` | · | · | · |
| `provider.date_of_birth` | Date of birth | date | `YYYY-MM-DD` | · | · | · |
| `provider.taxonomy_1` | Primary NUCC taxonomy code | string | 10 characters, e.g. `207Q00000X` | p | · | · |
| `provider.taxonomy_2` | Secondary NUCC taxonomy code | string | 10 characters | · | · | · |
| `provider.specialty_1` | Primary specialty | string | derived from `taxonomy_1` when missing | · | · | · |
| `provider.specialty_2` | Secondary specialty | string | derived from `taxonomy_2` when missing | · | · | · |
| `provider.license_state` | State that issued the license | enum | 2-letter state, e.g. `TX` | · | · | · |
| `provider.license_number` | State license number | string |  | · | · | · |
| `provider.license_expiration_date` | State license expiration date | date | `YYYY-MM-DD` | · | · | · |
| `provider.dea_number` | DEA registration number | string | 2 letters + 7 digits | · | · | · |
| `provider.dea_expiration_date` | DEA registration expiration date | date | `YYYY-MM-DD` | · | · | · |
| `provider.caqh_id` | CAQH ProView provider ID | digits |  | · | · | · |
| `provider.email` | Provider's email address | string |  | · | · | · |

## Practice location

| Field | Description | Type | Format / values | ADD | UPDATE | TERM |
| --- | --- | --- | --- | :-: | :-: | :-: |
| `practice.dba` | Public name of the practice (doing business as) | string |  | · | · | · |
| `practice.location_name` | Site, location or clinic name, if different from the DBA | string |  | · | · | · |
| `practice.address_1` | Street address of the service location | string |  | R | · | · |
| `practice.address_2` | Suite, unit or floor | string |  | p | · | · |
| `practice.city` | City of the service location | string |  | R | · | · |
| `practice.state` | State of the service location | enum | 2-letter state, e.g. `TX` | R | · | · |
| `practice.zip` | ZIP code of the service location | digits | `XXXXX` | R | · | · |
| `practice.phone` | Phone number for this location | digits | `XXX-XXX-XXXX` | p | · | · |
| `practice.fax` | Fax number for this location | digits | `XXX-XXX-XXXX` | · | · | · |
| `practice.website` | Public website, if available | string |  | · | · | · |

## Billing entity

| Field | Description | Type | Format / values | ADD | UPDATE | TERM |
| --- | --- | --- | --- | :-: | :-: | :-: |
| `billing.tax_id` | Federal tax ID (TIN) as it appears on the W-9 | digits | `XX-XXXXXXX` | R | p | p |
| `billing.legal_name` | Legal name of the tax ID (W-9) | string | often ends in `PLLC`, `PA`, `Inc` | p | · | · |
| `billing.npi` | Group (Type 2) billing NPI | digits | 10 digits, valid check digit | R | · | · |
| `billing.address_1` | Billing or remit-to street address | string | often a PO Box | · | · | · |
| `billing.address_2` | Billing address suite or unit | string | often empty | · | · | · |
| `billing.city` | Billing city | string |  | · | · | · |
| `billing.state` | Billing state | enum | 2-letter state | · | · | · |
| `billing.zip` | Billing ZIP code | digits | `XXXXX` | · | · | · |
| `billing.phone` | Phone number for this location | digits | `XXX-XXX-XXXX` | · | · | · |

## Network

| Field | Description | Type | Format / values | ADD | UPDATE | TERM |
| --- | --- | --- | --- | :-: | :-: | :-: |
| `network.contract_id` | The contract in your system this roster belongs to, typed on the Upload step | string |  | · | · | · |
| `network.sender_email` | Email address of whoever sent the roster, typed on the Upload step | string |  | · | · | · |
| `network.action_type` | Action the sender is requesting. Detected per row when the file has no action column: TERM if the sheet or file name mentions a termination, otherwise ADD. | enum | `ADD`, `UPDATE`, `TERM` | R | R | R |
| `network.effective_date` | Requested effective date of the add, update or termination | date | `YYYY-MM-DD` | R | R | R |
| `network.is_primary_location` | Whether this is the provider's primary service location | boolean | `0` or `1` | · | · | · |
| `network.location_type` | Role of this location for the provider | enum | `Primary`, `Secondary`, `Alternate` | · | · | · |
| `network.show_in_dir` | Whether to show this entry in member-facing provider search | boolean | `0` or `1` | · | · | · |
| `network.provider_type` | Clinical role; can determine the pay rate | enum | `PCP`, `SPEC`, `APP`, `HOSP`, `BH` | · | · | · |
| `network.is_pcp` | Whether the provider is a primary care provider (some files use this instead of `provider_type`) | boolean | `0` or `1` | · | · | · |
| `network.is_bh` | Whether the provider is a behavioral health provider | boolean | `0` or `1` | · | · | · |
| `network.hospital_based` | Whether the provider practices only in a hospital setting | boolean | `0` or `1` | · | · | · |
| `network.note` | Free-text note, most often the termination reason | string |  | · | · | · |
