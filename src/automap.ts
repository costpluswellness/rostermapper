import { detectAction, type Action, type DetectedAction } from './action';
import { detectCategory, fileAction, type DetectedCategory, type FileCategory, type FileInfo } from './file';
import { match } from './match';
import { profile, type ProfileOptions } from './profile';
import { normalizeHeader } from './profile/normalize';
import { buildRecords, EFFECTIVE_DATE, type RosterRecord } from './records';
import { fieldLevel, missingFields, type MissingField } from './required';
import { fieldList } from './fields';
import { redactSsn } from './redact';
import { schema as defaultSchema } from './schema.generated';
import { suggest, type Suggestion } from './suggest';
import { detectTransforms, type TransformHint } from './transform';
import type { Assignment, ColumnMatch, ColumnProfile, Row, Schema } from './types';

export interface AutomapOptions extends ProfileOptions {
	/** Defaults to the built-in roster schema. */
	schema?: Schema | undefined;
	/** The file's action, when known. Detected when omitted. */
	action?: Action | undefined;
	/** Used to detect the action: "Q3 Terminations.xlsx" → TERM. */
	fileName?: string | undefined;
	/** Used to detect the action: "LOC TERM" → TERM. */
	sheetName?: string | undefined;
	/** Whether the sheet lists individual providers or facilities. Detected when omitted. */
	category?: FileCategory | undefined;
	/** Put values in the data dictionary's formats. Default true; false keeps them as written. */
	clean?: boolean | undefined;
	/** Header → field id (or "ignore") from a mapping file. Replaces matching for those columns. */
	overrides?: Readonly<Record<string, string>> | undefined;
	/** Fields to leave without a column unless an override names one: "this sheet has no such column". */
	unmapped?: readonly string[] | undefined;
	/** Field id → one value for every row, for a field no column maps to ("2026-11-01" for
	 *  network.effective_date). Cleaned like any value. A mapped column wins over it. */
	constants?: Readonly<Record<string, string>> | undefined;
	/** A default for network.effective_date (YYYY-MM-DD), for rows where it's blank. Never replaces a
	 *  sender's value or a constant; each filled row gets a `default` note. */
	effectiveDate?: string | undefined;
}

export type Column = ColumnProfile & Omit<ColumnMatch, 'index'>;

export interface AutomapResult {
	headerRow: number;
	rowCount: number;
	/** What the sheet asks for (add, update or terminate), per row and overall, and why. */
	action: DetectedAction;
	/** Individual providers or facilities, and why. */
	category: DetectedCategory;
	/** The file-level values written into every record: name, sheet, action and category. */
	file: FileInfo;
	columns: Column[];
	/** Field id → the column mapped to it. */
	mapping: Record<string, Assignment>;
	/** Required fields (for the actions in this sheet) that no column maps to. */
	missing: MissingField[];
	/** The roster: one record per data row, every schema field present. */
	records: RosterRecord[];
	/** Override headers that match no column in this sheet. */
	unusedOverrides: string[];
	/** Columns no field took that probably belong to a field nothing mapped. */
	suggestions: Suggestion[];
	/** Signs the sheet needs a transform (several addresses per row, …). Empty when none. */
	transforms: TransformHint[];
}

/** Profile a sheet, map its columns to schema fields, detect its action, and build its records. */
export function automap(rows: readonly Row[], options: AutomapOptions = {}): AutomapResult {
	const { schema = defaultSchema, action, fileName, sheetName, category, clean = true, overrides = {}, unmapped = [], constants = {}, effectiveDate, ...profileOptions } = options;
	const sheet = profile(redactSsn(rows).rows, profileOptions); // a no-op for rows from readWorkbook
	const { columns, mapping } = match(sheet, schema, overrides, new Set(unmapped));
	const norms = new Set(sheet.columns.map((c) => c.norm));
	const detected = detectAction({
		action,
		fileName,
		sheetName,
		body: sheet.body.map((r) => r.cells),
		column: mapping['network.action_type'],
	});
	const detectedCategory = detectCategory({ category, fileName, sheetName, mapping });
	const file: FileInfo = { name: fileName ?? '', sheet: sheetName ?? '', action: fileAction(detected.action), category: detectedCategory.category };
	const merged = sheet.columns.map((column, i) => ({ ...column, ...columns[i]! }));
	const wanted = new Set(fieldList(schema).filter(({ spec }) => fieldLevel(spec, new Set(detected.rows)) !== 'optional').map(({ id }) => id));
	return {
		headerRow: sheet.headerRow,
		rowCount: sheet.rowCount,
		action: detected,
		category: detectedCategory,
		file,
		columns: merged,
		mapping,
		missing: missingFields(schema, mapping, detected.rows).filter((m) => !constants[m.field]?.trim() && !(m.field === EFFECTIVE_DATE && effectiveDate?.trim())),
		records: buildRecords(schema, sheet.body, mapping, detected.rows, { clean, file, constants, effectiveDate }),
		unusedOverrides: Object.keys(overrides).filter((h) => !norms.has(normalizeHeader(h).norm)),
		suggestions: suggest(merged, mapping, wanted),
		transforms: detectTransforms(sheet.columns, sheet.body),
	};
}
