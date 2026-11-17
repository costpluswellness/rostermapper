// The browser UI: serves dist/ui/ (and any files named on the command line) on 127.0.0.1,
// then opens the browser. The page reads files and runs Roster Mapper itself, so every change
// recalculates live. Only this machine can connect; files never leave it.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupAddress, lookupNpi, searchNpiByName } from '../validate/lookup';
import type { Sheet } from '../read/workbook';

/** Where the UI starts. CLI flags set these; the UI can change all of them. */
export interface Session {
	/** The roster file's name, when one was given. Without it the UI starts at Upload. */
	name?: string | undefined;
	/** The mapping file's name, when one was given. */
	mappingName?: string | undefined;
	sheet?: string | undefined;
	/** 0-based. */
	headerRow?: number | undefined;
	action?: string | undefined;
	/** individual or facility, when set on the command line. */
	category?: string | undefined;
	/** false when --no-nppes / --no-census turned a lookup off. Unset: the browser's saved choice. */
	nppes?: boolean | undefined;
	census?: boolean | undefined;
	/** --effective-date: YYYY-MM-DD for rows whose effective date is blank. */
	effectiveDate?: string | undefined;
	/** --contract-id, --sender-email: input field id → value for every record. */
	inputs?: Readonly<Record<string, string>> | undefined;
	/** --allow: enum field id → values kept as written. */
	allowed?: Readonly<Record<string, readonly string[]>> | undefined;
}

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
};

// dist/cli.js → dist/ui/. From source (scripts/rmap, pnpm cli), src/cli/server.ts → dist/ui/ too, so "pnpm build" first.
const uiDir = () => {
	const next = fileURLToPath(new URL('./ui/', import.meta.url));
	return existsSync(next) ? next : fileURLToPath(new URL('../../dist/ui/', import.meta.url));
};

export interface UiFiles {
	/** The roster, already read and SSN-redacted: the browser never receives the file's raw bytes. */
	sheets?: Sheet[] | undefined;
	mapping?: Uint8Array | undefined;
}

// JSON has no dates: send them as { $date: "…" } for the page to turn back into Dates.
const withDates = (_: string, v: unknown) => (v instanceof Date ? { $date: v.toISOString() } : v);

/** Serve the UI, with the files given on the command line, and open it. Resolves to the URL once listening. */
export function openUi(session: Session, files: UiFiles = {}): Promise<string> {
	const dir = uiDir();
	if (!existsSync(join(dir, 'index.html'))) {
		return Promise.reject(new Error(`UI files not found in ${dir}. Run "pnpm build" first.`));
	}
	const server = createServer((req, res) => {
		const full = new URL(req.url ?? '/', 'http://localhost');
		let url: string;
		try { url = decodeURIComponent(full.pathname); } catch { return void res.writeHead(400).end('Bad path'); }
		if (url === '/api/nppes' || url === '/api/census' || url === '/api/nppes-name') return void lookup(url, full.searchParams, res);
		if (url === '/session') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(session));
		if (url === '/file') {
			if (!files.sheets) return void res.writeHead(404).end();
			// Dates are already Date objects here; JSON.stringify would call toJSON first, so convert up front.
			const body = JSON.stringify(files.sheets.map((s) => ({ ...s, rows: s.rows.map((r) => r?.map((c) => withDates('', c))) })));
			return void res.writeHead(200, { 'content-type': 'application/json' }).end(body);
		}
		if (url === '/mapping') {
			return void (files.mapping ? res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(files.mapping) : res.writeHead(404).end());
		}
		const path = resolve(dir, '.' + (url === '/' ? '/index.html' : url));
		if (!path.startsWith(dir.replace(/[\\/]$/, '') + sep) || !existsSync(path)) return void res.writeHead(404).end('Not found');
		res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
		createReadStream(path).pipe(res);
	});
	return new Promise((done, fail) => {
		server.once('error', fail);
		server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
			const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
			openBrowser(url);
			done(url);
		});
	});
}

// ─── Lookups for Validate's "Run checks" ──────────────────────
// Browsers can't call NPPES or the Census geocoder directly (no CORS), so the page asks this server.
async function lookup(url: string, params: URLSearchParams, res: ServerResponse): Promise<void> {
	const send = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
	let answer: Promise<unknown>;
	if (url === '/api/nppes') {
		const npi = params.get('npi') ?? '';
		if (!/^\d{10}$/.test(npi)) return send(400, { error: 'npi must be 10 digits' });
		answer = lookupNpi(npi);
	} else if (url === '/api/nppes-name') {
		const [first, last, state] = ['first', 'last', 'state'].map((k) => (params.get(k) ?? '').slice(0, 60).trim());
		if (!first || !last) return send(400, { error: 'first and last are required' });
		answer = searchNpiByName({ first: first!, last: last!, state: state ?? "" });
	} else {
		const address = (params.get('address') ?? '').slice(0, 200);
		if (!address) return send(400, { error: 'address is required' });
		answer = lookupAddress(address);
	}
	try {
		send(200, { result: await answer });
	} catch (e) {
		send(502, { error: (e as Error).message });
	}
}

// BROWSER=none: serve without opening a browser (to open it elsewhere, or in tests).
function openBrowser(url: string): void {
	if (process.env.BROWSER === 'none') return;
	const [cmd, args] =
		process.platform === 'darwin' ? ['open', [url]] :
		process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
		['xdg-open', [url]];
	spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
