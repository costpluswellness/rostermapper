# Security

Roster Mapper processes provider rosters, which hold personal information. It runs on your machine. The pure library (`rostermapper`) sends nothing out. Validation (the CLI, the UI and `rostermapper/node`) sends only NPIs, provider names and address lines to NPPES and the US Census geocoder, and can be turned off (`--no-nppes`, `--no-census`). Lookup answers are cached in `~/.cache/rostermapper/`, readable only by you. The UI's server listens on 127.0.0.1 only.

To report a vulnerability, use GitHub's private reporting: the **Security** tab of this repository → **Report a vulnerability**. Please don't open a public issue for it. We aim to respond within five business days.
