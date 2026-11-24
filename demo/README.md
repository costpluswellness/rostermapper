# Demo site

The public demo: the docs with a sidebar, the UI at `/app/`, and sample rosters. The home page plays a few rows of `hand-edited.csv` from as sent, to cleaned, to the providers, locations and billing entities they describe; every sample can also be previewed cell by cell or opened in the app in one click. Hosted on Netlify (`netlify.toml` at the repo root).

```bash
pnpm demo          # builds the library and UI, then the site into demo/_site/
pnpm demo:serve    # serves demo/_site/ on http://localhost:8787, as Netlify would
```

| Path | What it is |
| --- | --- |
| `rosters/` | The sample rosters, `npis.json` (the NPPES sample they're built from) and `manifest.json` (what each one shows, for the site's cards) |
| `site/style.css` | The site's look; the pages are written by `scripts/build-demo-site.ts` from `docs/*.md` |
| `site/story.js` | The home page's animation: as sent → cleaned → network. Its data comes from `buildStory` in `scripts/demo-previews.ts`: the library's own cleaning and `groupEntities`, at build time |
| `site/preview.js` | The home page's sample preview. Its data, each sample as sent and as cleaned, comes from `scripts/demo-previews.ts`, which runs the built library on each sample at build time (no lookups: the app adds those) |
| `netlify/functions/lookup.mts` | `app/api/nppes`, `app/api/census` and `app/api/nppes-name`, through `answerLookup` (NPPES and the Census geocoder have no CORS) |
| `_site/` | The built site. Not committed |

The UI asks its host for `session` and `file`, with the page's query string. The site's `_redirects` answers `app/session?sample=<file>` with that roster's name and the list of samples, and `app/file?sample=<file>` with the roster itself, so `/app/?sample=hand-edited.csv` opens it straight away. See [Embedding the UI](../docs/usage.md#embedding-the-ui).

## The sample rosters

| File | Shape |
| --- | --- |
| `tidy-workbook.xlsx` | Title rows above the header; Adds, Terms and a Read Me tab; ZIPs stored as numbers; a few blanks NPPES fills |
| `hand-edited.csv` | An action column spelled five ways; dates, phones and states in every format; an NPI typo, an N/A and a duplicate; two providers also listed at their group's office, written differently |
| `DIRECTORY_EXTRACT_TERMS_20261130.csv` | `SCREAMING_SNAKE` headers; TERM from the file name; `YYYYMMDD` dates |
| `multi-location.xlsx` | One row per provider per location, with primary, directory and PCP flags |
| `facilities.xls` | Organizations in an Excel 97-2003 file |
| `wide-locations.xlsx` | Two locations across one row (needs a transform, not built yet); "Last, First" names |

**The data.** Every NPI is real: a random sample from NPPES (`pnpm demo:sample` makes up random 10-digit numbers that pass the NPI check digit and keeps those NPPES lists as active, so the sample isn't biased by any search). Names, credentials, taxonomies, licenses and practice addresses are as NPPES lists them, which is public. Which provider sits under which group NPI is random and says nothing about where anyone works. Tax IDs are placeholders: `99-99` then the group's number, `99-9900001` and up.

To draw a new sample and rebuild the files:

```bash
pnpm demo:sample     # writes rosters/npis.json (about 750 NPPES lookups)
pnpm demo:rosters    # writes the rosters and manifest.json from it (seeded: same input, same files)
```
