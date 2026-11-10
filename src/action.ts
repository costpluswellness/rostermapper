// What a roster asks for, per row and for the whole sheet: add, update or terminate providers.
//
// Each row's action, in order of precedence:
//   1. the caller says so (`action` option)
//   2. the row's value in an action column ("Action", "Request Type", …)
//   3. TERM if the sheet name mentions a termination ("LOC TERM", "Terminations")
//   4. TERM if the file name does
//   5. otherwise ADD
// The sheet's action is its rows' action, or MIXED when they differ.
import { cellText, isBlank } from './cells';
import type { Assignment, Cell, Row } from './types';

export const ACTIONS = ['ADD', 'UPDATE', 'TERM'] as const;
export type Action = (typeof ACTIONS)[number];

export type ActionSource = 'option' | 'column' | 'sheet name' | 'file name' | 'default';

export interface DetectedAction {
	/** The sheet's action. MIXED when its rows have more than one. */
	action: Action | 'MIXED';
	source: ActionSource;
	/** Plain-language reason. */
	why: string;
	/** One action per data row, in order. Never MIXED. */
	rows: Action[];
	/** Present when the sheet has an action column. */
	column?: {
		index: number;
		/** Rows per value. `unrecognized` and `blank` rows fall back to the name rules. */
		counts: Record<Action | 'unrecognized' | 'blank', number>;
	};
}

export interface ActionInput {
	/** Set by the caller; skips detection. */
	action?: Action | undefined;
	fileName?: string | undefined;
	sheetName?: string | undefined;
	/** Data rows, below the header. */
	body?: readonly Row[] | undefined;
	/** The column mapped to network.action_type, if any. */
	column?: Pick<Assignment, 'column'> | undefined;
}

// "Long-term care" is a facility type, not a termination.
const TERM_WORD = /(?<!\blong )\bterm(s|ed|inat\w*)?\b/i;

// Cell values, first match wins. Checked against the start of the value.
const VALUES: [RegExp, Action][] = [
	[/^(term|delet|remov|inactiv|end|disenroll|close)/i, 'TERM'],
	[/^(add|new|enroll|initial|join)/i, 'ADD'],
	[/^(chang|updat|modif|edit|correct)/i, 'UPDATE'],
];

/** Read one cell as an action: "Add" → ADD, "Termination" → TERM, "Change" → UPDATE. */
export function parseAction(value: Cell): Action | null {
	const text = cellText(value);
	return VALUES.find(([re]) => re.test(text))?.[1] ?? null;
}

/** Whether a sheet or file name marks a termination: "LOC TERM", "Q3_Terminations.xlsx". */
export function namesTermination(name: string): boolean {
	return TERM_WORD.test(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' '));
}

export function detectAction(input: ActionInput): DetectedAction {
	const body = input.body ?? [];
	if (input.action) {
		const action = input.action;
		return { action, source: 'option', why: `set to ${action}`, rows: body.map(() => action) };
	}

	const byName = fromNames(input);
	if (!input.column) {
		const why = byName.source === 'default' ? `no action column; ${byName.why}` : byName.why;
		return { ...byName, why, rows: body.map(() => byName.action) };
	}

	const index = input.column.column;
	const counts = { ADD: 0, UPDATE: 0, TERM: 0, unrecognized: 0, blank: 0 };
	const rows = body.map((row) => {
		const value = row[index];
		const parsed = isBlank(value) ? null : parseAction(value);
		counts[parsed ?? (isBlank(value) ? 'blank' : 'unrecognized')]++;
		return parsed ?? byName.action;
	});
	const column = { index, counts };

	const found = ACTIONS.filter((a) => counts[a] > 0);
	if (!found.length) return { ...byName, why: `the action column has no recognized values; ${byName.why}`, rows, column };

	const fellBack = counts.blank + counts.unrecognized;
	const distinct = [...new Set(rows)];
	const why = [
		found.length === 1 && !fellBack ? `every action in the column is ${found[0]}` : `the action column has ${found.map((a) => `${counts[a]} ${a}`).join(', ')}`,
		...(fellBack ? [`${fellBack} ${fellBack === 1 ? 'row' : 'rows'} without one ${fellBack === 1 ? 'gets' : 'get'} ${byName.action} (${byName.why})`] : []),
	].join('; ');
	return { action: distinct.length === 1 ? distinct[0]! : 'MIXED', source: 'column', why, rows, column };
}

function fromNames({ sheetName, fileName }: ActionInput): { action: Action; source: ActionSource; why: string } {
	if (sheetName && namesTermination(sheetName)) return { action: 'TERM', source: 'sheet name', why: `sheet name "${sheetName}" mentions a termination` };
	if (fileName && namesTermination(fileName)) return { action: 'TERM', source: 'file name', why: `file name "${fileName}" mentions a termination` };
	return { action: 'ADD', source: 'default', why: 'no termination in the sheet or file name' };
}
