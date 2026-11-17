// rostermapper/workbook: read spreadsheets and write the result as Excel, the same way in Node and
// the browser. Separate from the main entry because it bundles SheetJS.
export { readWorkbook, type Sheet } from './read/workbook';
export { sheetWorkbooks, toBatchSummary, toReport, toZip } from './export/report';
