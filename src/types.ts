import type { Action } from './action';
import type { ValueType } from './profile/value-type';

/** One spreadsheet cell, as returned by SheetJS `sheet_to_json(ws, { header: 1 })`. */
export type Cell = string | number | boolean | Date | null | undefined;

export type Row = readonly Cell[];

export type OutputType = 'string' | 'digits' | 'date' | 'enum' | 'boolean';

export interface FieldSpec {
	/** Output data type. */
	type: OutputType;
	/** What the field holds. */
	description: string;
	/** Expected output format or allowed values. `code` spans mark literal values. */
	format?: string;
	/** Actions for which a row must have this field; rows missing it are flagged. */
	required?: readonly Action[];
	/** Actions for which the field should be filled if the file has it; shown on the Map step, never flagged. */
	preferred?: readonly Action[];
	/** Value types the field accepts, most likely first. */
	values?: readonly ValueType[];
	/** Headers that mean this field. */
	aliases: readonly string[];
	/** Look-alike headers that must never map here. */
	not?: readonly string[];
	/** Headers that map here with the meaning flipped ("Exclude from Directory"). */
	inverted?: readonly string[];
	/** Headers that might mean this field though another field claims them: a candidate at most 0.6, never mapped over an alias. */
	related?: readonly string[];
	/** The Map step leaves the field out of its table unless a column maps to it. */
	hidden?: boolean;
	/** Typed on the Upload step, one value for every row; never mapped from a column. */
	input?: boolean;
}

export interface Vocab {
	abbreviations: Readonly<Record<string, string>>;
	stopwords: readonly string[];
	slots: Readonly<Record<string, number>>;
	neutral: readonly string[];
	qualifiers: readonly string[];
	ignore: readonly string[];
}

export interface Schema {
	/** Fields grouped by entity: `fields.provider.npi` is field `provider.npi`. */
	fields: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>;
	vocab: Vocab;
}

export interface ColumnProfile {
	index: number;
	/** Spreadsheet column letter: "A", "B", … */
	letter: string;
	header: string;
	/** Header lowercased, split into words, punctuation removed. */
	norm: string;
	/** Parentheticals pulled out of the header: "Provider Type (PCP/SPEC)" → ["PCP/SPEC"]. */
	hints: string[];
	/** Label from a merged-cell band above the header row, if any. */
	group: string;
	type: ValueType;
	confidence: number;
	filled: number;
	placeholders: number;
	total: number;
	distinct: number;
	samples: string[];
}

/** A data row below the header, with its place in the sheet. */
export interface BodyRow {
	/** 0-based index in the sheet. */
	index: number;
	cells: Row;
}

export interface SheetProfile {
	headerRow: number;
	rowCount: number;
	/** The non-blank rows below the header. */
	body: BodyRow[];
	columns: ColumnProfile[];
}

export interface Candidate {
	field: string;
	score: number;
	/** Human-readable reasons behind the score. */
	why: string[];
	/** Unclamped score, used to break ties between candidates at 1.0. */
	raw?: number;
	/** The header means the opposite of the field ("Exclude from Directory"): flip yes/no values. */
	inverted?: true;
	/** Set by a mapping file, not by matching. */
	override?: true;
}

export interface Rejection {
	field: string;
	why: string;
}

export type MatchStatus = 'mapped' | 'weak' | 'unmapped' | 'ignored';

export interface ColumnMatch {
	index: number;
	/** Header words after abbreviations and stopwords. */
	tokens: string[];
	status: MatchStatus;
	candidates: Candidate[];
	rejected: Rejection[];
}

export interface Assignment extends Candidate {
	column: number;
}

export interface MatchResult {
	columns: ColumnMatch[];
	/** Best column for each field, one column per field. */
	mapping: Record<string, Assignment>;
}
