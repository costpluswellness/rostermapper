# Usage

Needs Node 22 or later. Roster Mapper has three ways in, all running the same [steps](steps.md):

- [Command line](#command-line): map files or folders, write the result. No browser needed.
- [UI](#ui): the same run in a browser, served locally by the command line, with a step-by-step view.
- [Library](#library): call the pipeline from your own code, in Node or the browser.

## Command line

```bash
npm install -g rostermapper
```

```bash
rostermapper roster.xlsx                 # every step; saves output/RM_roster_<sheet>.xlsx
rostermapper roster.xlsx --steps         # one step at a time, printing each step's result
rostermapper inbox/                      # every roster in the folder: output/<date-time>/ with summary.xlsx
rostermapper a.xlsx b.xlsx -o results/   # several files: results/<date-time>/
rostermapper roster.xlsx -o result.xlsx  # every sheet in one workbook
rostermapper roster.xlsx -o clean.csv    # the records; rows left out, and why, in clean_issues.csv
rostermapper roster.xlsx --ui            # open the UI with the file loaded
rostermapper                             # open the UI and upload files there
rostermapper fields                      # the data dictionary
rostermapper --help                      # every option
```

What the terminal shows: each sheet's action, category and columns mapped, and how many rows moved forward, were left out and have issues. The details are in the workbook (see [Export](steps.md#6-export)). `--why` prints the mapping and the reasons behind it; `--json` prints the whole result.

Options: `-s` sheet, `-a` action (`add`, `update`, `term`), `-c` category (`individual`, `facility`), `--header-row`, `--effective-date`, `--contract-id`, `--sender-email`, `--allow` (keep a sender's own codes as written, like `--allow provider_type=AHP,PHYS`), `-m` mapping file, `-o` output, `--no-nppes`, `--no-census`, `--no-cache`, `--keep-dropped`, `--steps`, `--why`, `--json`, `--ui`. `rostermapper --help` explains each.

The exit code is 1 when the arguments are wrong, a file can't be read, or (in a batch) any file failed.

### Step by step (debugging a roster)

`--steps` runs the same pipeline but stops after each step to print what it did:

- **read**: each sheet's rows, and SSN columns and cells removed
- **map**: header row, action and category with the reason, and every column with its field, score and why
- **standardize**: issue counts by field, and every row left out and why
- **validate**: what was looked up, every value a trusted source changed (row, field, old → new), and the issues lookups raised
- **review**: providers, practice locations, billing entities and combinations
- **export**: the files written

In a terminal it waits for Enter before the next step; `q` stops. Piped, it prints every step without waiting.

## UI

`rostermapper --ui` (or `rostermapper` with no file, in a terminal) serves the UI on `127.0.0.1` and opens it. Only this machine can connect; files are read in the browser, and only NPIs and addresses go out, through the local server, to NPPES and the Census geocoder. Set `PORT` to choose the port and `BROWSER=none` to not open a browser.

- **New run**: drop files or a folder. Under the drop: the action (to override detection), a mapping file, and which lookups may run (NPPES, Census). A default effective date is set on a file's Mapping ("…" on the field); a contract ID and sender email are asked for at Download. Dark by default; ☀︎/☾ in the header switches.
- Every file runs through every step, as the command line does, then **Results** shows the workbook's tables (Sheets, Mapping, Issues, Left out) across every file, with a filter, and the workbooks to download ("Download all": a zip with `summary.xlsx`).
- Click a file to open its **Review**, the file's one page:
  - its name and totals, then its sheets as tabs: click one to open it, × to ignore it (left out of Results and the download), ↺ to bring it back;
  - its providers, locations and billing as a graph (the default) or a table, each card carrying its checks: problem values highlighted (anything unmarked is taken as confirmed), each NPI a link to the NPPES NPI Registry, "Use" for a suggestion;
  - a card, clicked, shows its problems: "add" for a missing value, "edit address" for every part of an address at once;
  - its issues, once per provider, location or billing entity (its name shows its card), each with its fix: "mapping", "edit" (type the right value), "Use" (a source's value, for every row of the entity) or "Allow" (a sender's own code kept as written);
  - **Mapping** (which column fills each field, as a dialog), **Raw data** (the sheet as it is in the file; click a row to make it the header), **Run checks** (look everything up again) and **Download** (shows each sheet's counts and the first rows to confirm, then saves one workbook with every sheet kept, as left here).

Every change recalculates live, and each sheet keeps its changes when you switch between them. The status bar shows progress and the open sheet's counts.

## Library

```bash
npm install rostermapper
```

Three entry points:

| Import | What it has | Runs in |
| --- | --- | --- |
| `rostermapper` | The pipeline (`runSheets`, `STEPS`) and every step's functions: `automap`, `cleanValue`, `validateRecords`, `groupEntities`, `reportTables`, `toCsv`, … No I/O. | Node and the browser |
| `rostermapper/workbook` | `readWorkbook` (xlsx, xls, csv bytes → sheets, SSNs removed) and Excel output: `toReport`, `sheetWorkbooks`, `toBatchSummary`, `toZip`. Bundles SheetJS. | Node and the browser |
| `rostermapper/node` | What the command line runs: `mapFile`, `mapFiles`, `writeOutput`, live NPPES and Census lookups with the disk cache. | Node |

The command line's default run, from code:

```ts
import { mapFile, writeOutput } from 'rostermapper/node';

const { file, results } = await mapFile('roster.xlsx');   // read, map, standardize, validate, review
writeOutput(file, results, 'output');                     // output/RM_roster_<sheet>.xlsx
```

A folder, as `rostermapper inbox/` does:

```ts
import { mapFiles } from 'rostermapper/node';

const { dir, entries } = await mapFiles(['inbox/'], { output: 'output' });   // entries: one per sheet, as in summary.xlsx
```

Without lookups, in the browser or anywhere else:

```ts
import { runSheets, toCsv } from 'rostermapper';
import { readWorkbook } from 'rostermapper/workbook';

const sheets = readWorkbook(bytes);                      // ArrayBuffer or Uint8Array
const results = await runSheets('roster.xlsx', sheets);  // pass { lookup } to validate
const csv = toCsv(results.flatMap((r) => r.records));
```

Options for `runSheets`, `mapFile` and `mapFiles` match the command line's flags: `action`, `category`, `headerRow`, `overrides` (from `parseMapping`), `constants` (`{ 'network.contract_id': '…' }`), `effectiveDate`, `sources` (`{ nppes, census }`), `lookup` (your own `LookupFns`, or `false` in Node for none). `onStep` is called after each step with that step's result; return `false` to stop. Each result is a sheet's mapping (each column, its field and why), its records (one per row, every field and its issues), the detected action and category, missing required fields and suggestions. See `src/index.ts` for the full API.

## Embedding the UI

The UI in `dist/ui/` is plain HTML, CSS and ES modules, styled for embedding in another page (an admin portal): its CSS is layout only, scoped to `.rm`, and takes fonts, text colour, buttons and inputs from the page around it. The `<style>` block in `index.html` plays the host page when the command line serves it; drop it when embedding. The host can set:

| Variable | Default | What it sets |
| --- | --- | --- |
| `--rm-accent` | `LinkText` | Current step, header row, highlights |
| `--rm-bg` | `Canvas` | Background behind sticky headers and the status bar |
| `--rm-max-width` | none | The bench's width |
| `--rm-min-height` | `100vh` | Its height, so the status bar sits at the bottom |

The UI needs a server for three things browsers can't do alone: `/api/nppes`, `/api/census` and `/api/nppes-name` (NPPES and the Census geocoder have no CORS). `answerLookup` in `src/validate/lookup.ts` answers all three; see `src/cli/server.ts`, or the demo site's function in `demo/netlify/functions/`.

A host can also open a roster in the page and take the result back. The page fetches these relative to itself, each with the page's own query string added, so `index.html?attachment=8f2c…` tells the host which roster:

| Route | Answer | What the page does |
| --- | --- | --- |
| `GET session` | JSON: `Session` in `src/cli/server.ts` (`name`, `sheet`, `action`, `inputs`, `send`, `samples`, `home`, …), or `{}` | With `name`, opens that roster; without, starts at Upload. `samples` (`[{ file, title?, note? }]`) lists rosters under the drop, each opening `?sample=<file>`; `home` (a URL) makes the title a link back to the host's site |
| `GET file` | The roster's bytes (xlsx, xls or csv), or the sheets already read (JSON, as the CLI sends) | Reads bytes like an upload, removing SSNs as it reads |
| `GET mapping` | A mapping file's bytes, when `session.mappingName` is set | Applies the overrides |
| `POST send` | JSON: `{ message?, open? }`, or an error status with `{ error }` | Shown when `session.send` is `{ label }`: a button with that label next to Download |

`send` gets the open file's sheets that aren't ignored, with Contract ID and sender email written in:

```json
{ "name": "roster.xlsx", "checked": "NPPES, Census",
  "sheets": [{ "sheet": "Adds", "headerRow": 1, "action": "ADD", "category": "individual",
               "mapping": { "provider.npi": "NPI #", "…": "…" },
               "counts": { "rows": 40, "movedForward": 38, "leftOut": 2, "withIssues": 5 },
               "records": [{ "row": 2, "values": { "provider.npi": "…" }, "issues": [] }] }] }
```

`records` are every row, left-out ones included, each with the issues that dropped it (`drop: true`), so the host can account for every line the sender sent. The page shows `message`, then goes to `open` (the top window's location when it is framed).

From the command line, `--send <url>` with `--ui` adds the button and passes the POST on to that URL, with the page's query string: `rostermapper --ui roster.xlsx --send "http://localhost:8768/api/mapper"`.
