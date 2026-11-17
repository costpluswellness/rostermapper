// rostermapper: the library. Pure (no I/O, no SheetJS), so it runs the same in Node and the browser.
// Reading and writing spreadsheets: rostermapper/workbook. Files on disk and live lookups: rostermapper/node.

// Pipeline: every step in order, as the CLI and the UI run them
export { runSheets, STEPS, STEP_SUMMARY, StoppedEarly, type Change, type OnStep, type RunOptions, type SheetInput, type Step, type StepEvent } from './pipeline';

// Schema
export { schema, type FieldId } from './schema/schema.generated';
export { NUCC, NUCC_VERSION } from './schema/nucc.generated';
export { fieldList, type SchemaField } from './schema/fields';
export { fieldLevel, missingFields, preferredFields, requiredFields, type FieldLevel, type MissingField } from './schema/required';
export type * from './schema/types';

// 1 Read
export { isBlank } from './read/cells';
export { isSsnHeader, isSsnValue, redactSsn, REDACTED, ssnHeaderColumns, type Redaction } from './read/redact';

// 2 Map
export { automap, type AutomapOptions, type AutomapResult, type Column } from './map/automap';
export { detectHeaderRow, profile, type ProfileOptions } from './map/profile';
export { normalizeHeader } from './map/profile/normalize';
export { detectType, isValidNpi, VALUE_TYPES, type ValueType } from './map/profile/value-type';
export { match, THRESHOLDS } from './map/match';
export { ACTIONS, detectAction, namesTermination, parseAction, type Action, type ActionInput, type ActionSource, type DetectedAction } from './map/action';
export { detectCategory, FILE_ACTIONS, FILE_CATEGORIES, FILE_FIELDS, fileAction, fileValues, namesFacility, outputName, type CategoryInput, type CategorySource, type DetectedCategory, type FileAction, type FileCategory, type FileInfo } from './map/file';
export { parseMapping, type ParsedMapping } from './map/mapping';
export { suggest, SUGGEST_MIN, type Suggestion } from './map/suggest';
export { detectTransforms, type TransformHint } from './map/transform';

// 3 Standardize
export { cleanDegree, cleanValue, isFreeText, isStandardized, standardRule, toTitleCase, type Cleaned } from './standardize/clean';
export { applyDropRules, buildRecords, isDropped, primaryNpi, type Issue, type RosterRecord } from './standardize/records';

// 4 Validate
export { autoFixes, checkIssues, lookupAll, lookupTargets, nameKey, nameSearches, noLookups, RANK, recordChecks, validateRecords, type LookupError, type LookupFns, type LookupOptions, type Lookups, type NameQuery, type Sources } from './validate/checks';
export { addressLine, censusChecks, degreesDiffer, nameDifference, orgName, streetOnly, wantsNameSearch, nppesBillingChecks, nppesProviderChecks, type CensusMatch, type Check, type CheckStatus, type NppesRecord } from './validate/rules';

// 5 Review
export { groupEntities, type Entities, type Entity, type EntityKind } from './review/entities';

// 6 Export
export { leftOutRows, outputFields, outputOrder, recordRows, toCsv, toIssuesCsv } from './export/csv';
export { batchRows, counts, hasProblem, ISSUE_KIND, issueRows, mappingRows, reportTables, sheetEntry, who, type BatchEntry, type ReportOptions, type ReportTables, type SheetResult, type Table } from './export/tables';
