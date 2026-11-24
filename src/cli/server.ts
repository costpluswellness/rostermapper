// The browser UI: serves dist/ui/ (and any files named on the command line) on 127.0.0.1,
// then opens the browser. The page reads files and runs Roster Mapper itself, so every change
// recalculates live. Only this machine can connect; files never leave it.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerLookup } from '../validate/lookup';
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
	/** A host that takes the result itself: Download gets a second button with this label, which POSTs the
	 *  result to the host's `send` route (see ui/steps/review.js, sendBody). The CLI never sets it. */
	send?: { label: string } | undefined;
	/** Sample rosters a host offers under the drop: each links to `?sample=<file>`, which the host's `file`
	 *  route answers with that roster (the public demo does). The CLI never sets it. */
	samples?: { file: string; title?: string; note?: string }[] | undefined;
	/** A host's own site: the "Roster Mapper" title links to this URL (the public demo's home page). */
	home?: string | undefined;
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
	/** --send: where the page's Send button's POST goes (with the page's query string). */
	sendTo?: string | undefined;
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
		if (url === '/send') {
			if (!files.sendTo || req.method !== 'POST') return void res.writeHead(404).end();
			return void forward(files.sendTo, full.searchParams, req, res);
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
	const { status, body } = await answerLookup(url, params);
	res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// ─── Send ──────────────────────────────────────────────────────
// The page POSTs its result to /send; this passes it on to --send's URL, with the page's query string
// added, and hands back the answer ({ message?, open? }). Server to server, so the target needs no CORS.
async function forward(target: string, params: URLSearchParams, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const json = (status: number, body: string): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(body);
	try {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const to = new URL(target);
		for (const [k, v] of params) to.searchParams.set(k, v);
		const answer = await fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(120_000) });
		json(answer.status, (await answer.text()) || '{}');
	} catch (e) {
		json(502, JSON.stringify({ error: `${new URL(target).host} didn't answer: ${(e as Error).message}` }));
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
