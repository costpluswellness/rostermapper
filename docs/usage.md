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

Options: `-s` sheet, `-a` action (`add`, `update`, `term`), `-c` category (`individual`, `facility`), `--header-row`, `--effective-date`, `--contract-id`, `--sender-email`, `-m` mapping file, `-o` output, `--no-nppes`, `--no-census`, `--no-cache`, `--keep-dropped`, `--steps`, `--why`, `--json`, `--ui`. `rostermapper --help` explains each.

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

- **New run**: drop files or a folder, set the options (action, default effective date, contract ID, sender email, mapping file) and which outside sources may be used.
- **Run** (the default) runs every step on every file, as the command line does, then shows **Results**: the workbook's tables (Sheets, Mapping, Issues, Left out) across every file, with a filter, and the workbooks to download ("Download all": a zip with `summary.xlsx`).
- **Step by step** opens a file at Upload and goes through Map, Standardize, Validate, Review and Export one view at a time. Every change (a column remapped, a value fixed by hand, a suggestion accepted) recalculates live. "Run all steps" finishes the file from wherever you are. From Results, click a file to open it in the steps.

The rail on the left lists the files and, for the file open, its steps with a count each (columns mapped, values not cleaned, checks failed, rows moving forward). The status bar shows progress and the open sheet's counts.

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

The UI needs a server for three things browsers can't do alone: `/api/nppes`, `/api/census` and `/api/nppes-name` (NPPES and the Census geocoder have no CORS), and optionally `/session` and `/file` for a roster given on the command line. See `src/cli/server.ts`.
