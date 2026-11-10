// Signs that a sheet needs reshaping before its rows become records (the Transform step, not built
// yet). Detection only: nothing here changes the records.
//
// multiple-addresses: the sheet has more than one practice address block per row ("Zip Code",
//   "Alt Zip Code 1", "Outreach Zip Code", …) and at least one row fills more than one. Blocks are
//   counted by their ZIP columns and by their city columns, taking the smaller count when a sheet
//   has both: a billing block's bare "Zip Code" under "Billing City" would otherwise add a block.
//   Billing, mailing, remit and home addresses don't count: they aren't extra locations.
import { isBlank } from './cells';
import type { BodyRow, ColumnProfile } from './types';

export interface TransformHint {
	kind: 'multiple-addresses';
	/** Plain-language summary for a banner. */
	message: string;
	/** The columns that anchor each block (ZIP or city), in sheet order. */
	columns: number[];
	/** Every column that is part of a practice address block: street, city, state, ZIP, county, phone, fax, … */
	related: number[];
	/** Data rows that fill more than one block. */
	rows: number;
	/** Most blocks filled in one row. */
	most: number;
}

const OTHER_ADDRESS = /\b(bill(ing)?|biling|mail(ing)?|remit\w*|pay ?to|correspondence|home|residen\w*|w ?9|e-?mail|web)\b/i;
const ADDRESS_PART = /\b(address\w*|addr|street|suite|city|state|zip|postal|county|phone|fax)\b/i;
const ZIP = /\b(zip|postal)\b/i;
const ZIP_PLUS_4 = /\+\s*4|plus\s*4|zip\s*4\b|\bext/i;
const CITY = /\bcity\b/i;

export function detectTransforms(columns: readonly ColumnProfile[], body: readonly BodyRow[]): TransformHint[] {
	const location = columns.filter((c) => c.header.trim() && !OTHER_ADDRESS.test(c.header));
	const zips = location.filter((c) => ZIP.test(c.header) && !ZIP_PLUS_4.test(c.header));
	const cities = location.filter((c) => CITY.test(c.header));
	const anchors = zips.length && cities.length ? (cities.length < zips.length ? cities : zips) : zips.length ? zips : cities;
	const blocks = anchors.map((c) => c.index);
	if (blocks.length < 2) return [];

	const counts = body.map(({ cells }) => blocks.filter((i) => !isBlank(cells[i])).length);
	const rows = counts.filter((n) => n > 1).length;
	if (!rows) return [];
	const most = Math.max(...counts);
	return [{
		kind: 'multiple-addresses',
		message: `${rows} of ${body.length} ${body.length === 1 ? 'row lists' : 'rows list'} more than one practice address (up to ${most}). Only the first is mapped; splitting them into one row per address is a transform.`,
		columns: blocks,
		related: location.filter((c) => ADDRESS_PART.test(c.header)).map((c) => c.index),
		rows,
		most,
	}];
}
