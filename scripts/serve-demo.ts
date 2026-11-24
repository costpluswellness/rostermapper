// Serves demo/_site/ locally as Netlify does: the _redirects rules for app/session and app/file, and
// the lookup function. `pnpm demo` builds the site first; PORT picks the port (default 8787).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerLookup } from '../src/validate/lookup';

const dir = fileURLToPath(new URL('../demo/_site/', import.meta.url));
if (!existsSync(join(dir, 'index.html'))) throw new Error('demo/_site/ not built: run "pnpm demo" first.');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	let path = decodeURIComponent(url.pathname);
	const sample = url.searchParams.get('sample');
	if (path.startsWith('/app/api/')) {
		const { status, body } = await answerLookup(path, url.searchParams);
		return void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
	}
	// The same rules as _redirects (scripts/build-demo-site.ts).
	if (path === '/app/session') path = sample ? `/app/sessions/${sample}.json` : '/app/sessions/index.json';
	else if (path === '/app/file' && sample) path = `/rosters/${sample}`;
	let file = resolve(dir, '.' + path);
	if (existsSync(file) && statSync(file).isDirectory()) {
		if (!path.endsWith('/')) return void res.writeHead(301, { location: path + '/' + url.search }).end();
		file = join(file, 'index.html');
	}
	if (!file.startsWith(dir.replace(/[\\/]$/, '') + sep) || !existsSync(file)) return void res.writeHead(404).end('Not found');
	res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
	createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT ?? 8787), '127.0.0.1', function (this: import('node:net').Server) {
	console.log(`Demo site: http://localhost:${(this.address() as import('node:net').AddressInfo).port}/`);
});
