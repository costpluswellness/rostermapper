// Builds the public demo site into demo/_site/ (Netlify publishes it; see netlify.toml):
//   /                 home: what Roster Mapper does, the sample rosters, install
//   /docs/*.html      docs/*.md rendered
//   /app/             the UI (dist/ui/, so run `pnpm build` first), offering the samples
//   /rosters/         the sample rosters (demo/rosters/)
// The UI asks its host for `session` and `file`, with the page's query string: _redirects answers
// app/session?sample=<file> and app/file?sample=<file> with that sample. Lookups go to the function
// in demo/netlify/functions/. `pnpm demo:serve` serves the result locally the same way.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Marked, type Tokens } from 'marked';
import { buildPreviews } from './demo-previews.ts';

const root = new URL('../', import.meta.url);
const out = new URL('demo/_site/', root);
const REPO = 'https://github.com/costpluswellness/rostermapper';
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };

type Sample = { file: string; title: string; format: string; rows: number; blurb: string; shows: string[] };
const samples = JSON.parse(readFileSync(new URL('demo/rosters/manifest.json', root), 'utf8')) as Sample[];
const { drawn } = JSON.parse(readFileSync(new URL('demo/rosters/npis.json', root), 'utf8')) as { drawn: string };

rmSync(out, { recursive: true, force: true });
mkdirSync(new URL('docs/', out), { recursive: true });
cpSync(new URL('dist/ui/', root), new URL('app/', out), { recursive: true });
mkdirSync(new URL('rosters/', out));
for (const s of samples) cpSync(new URL(`demo/rosters/${s.file}`, root), new URL(`rosters/${s.file}`, out));
cpSync(new URL('demo/site/style.css', root), new URL('style.css', out));

// ─── The UI's host routes ───────────────────────────────────
const offer = samples.map(({ file, title, shows }) => ({ file, title, note: shows.join('; ') }));
mkdirSync(new URL('app/sessions/', out));
writeFileSync(new URL('app/sessions/index.json', out), JSON.stringify({ home: '../', samples: offer }));
for (const s of samples) writeFileSync(new URL(`app/sessions/${s.file}.json`, out), JSON.stringify({ name: s.file, home: '../', samples: offer }));
writeFileSync(new URL('_redirects', out), [
	'/app/session  sample=:sample  /app/sessions/:sample.json  200!',
	'/app/session                  /app/sessions/index.json    200!',
	'/app/file     sample=:sample  /rosters/:sample            200!',
	'',
].join('\n'));

// ─── Pages ──────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const slug = (text: string) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

type Page = { path: string; title: string; heads: { id: string; text: string }[]; body: string; description: string };

const DOCS = [
	{ md: 'docs/usage.md', path: 'docs/usage.html' },
	{ md: 'docs/steps.md', path: 'docs/steps.html' },
	{ md: 'docs/canonical_fields.md', path: 'docs/fields.html' },
];
const mdToPage = new Map(DOCS.map((d) => [d.md.replace('docs/', ''), d.path.replace('docs/', '')]));

function renderDoc(md: string, path: string): Page {
	const heads: Page['heads'] = [];
	let title = '';
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth }: Tokens.Heading) {
				const text = this.parser.parseInline(tokens);
				if (depth === 1) { title = text.replace(/<[^>]+>/g, ''); return `<h1>${text}</h1>\n`; }
				const id = slug(text);
				if (depth === 2) heads.push({ id, text: text.replace(/<[^>]+>/g, '') });
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${depth}>\n`;
			},
			link({ href, tokens }: Tokens.Link) {
				const text = this.parser.parseInline(tokens);
				let to = href;
				const [file = '', hash] = href.split('#');
				if (/^[\w-]+\.md$/.test(file) && mdToPage.has(file)) to = mdToPage.get(file)! + (hash ? `#${hash}` : '');
				else if (/^(\.\.\/|[\w-]+\/)/.test(href) && !/^https?:/.test(href)) to = `${REPO}/blob/main/${href.replace(/^(\.\.\/)+/, '')}`;
				else if (/\.md$/.test(file) && !/^https?:/.test(href)) to = `${REPO}/blob/main/${file}`;
				const external = /^https?:/.test(to);
				return `<a href="${esc(to)}"${external ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
			},
		},
	});
	const body = marked.parse(md) as string;
	const first = md.split('\n').find((l) => l && !l.startsWith('#')) ?? '';
	return { path, title, heads, body, description: first.replace(/[`*[\]]|\(.*?\)/g, '').slice(0, 160) };
}

const icon = {
	play: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3.5v9l7-4.5z" stroke-linejoin="round"/></svg>',
	shuffle: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5h2.5c3 0 4 7 7 7H14M12 9.5l2 2-2 2M2 11.5h2.5c1.2 0 2-1 2.7-2.3M9.3 6.8c.7-1.3 1.5-2.3 2.7-2.3H14M12 2.5l2 2-2 2"/></svg>',
	repo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 12.5c-3 1-3-1.5-4.5-2M10 14.5v-2.3c0-.7.1-1.2-.4-1.7 2.2-.3 4.4-1 4.4-4.6 0-1-.4-1.8-1-2.5.1-.4.4-1.4-.1-2.6 0 0-.8-.3-2.7 1a9 9 0 0 0-4.6 0C3.7.5 2.9.8 2.9.8c-.5 1.2-.2 2.2-.1 2.6-.6.7-1 1.5-1 2.5 0 3.6 2.2 4.3 4.4 4.6-.5.4-.5 1-.4 1.7v2.3"/></svg>',
};

function shell(page: Page, all: Page[]): string {
	const up = page.path.includes('/') ? '../' : '';
	const nav = all.map((p) => {
		const here = p.path === page.path;
		const sub = here && p.heads.length ? `<div class="sub">${p.heads.map((h) => `<a href="#${h.id}">${h.text}</a>`).join('')}</div>` : '';
		return `<a class="page" href="${up}${p.path === 'index.html' ? './' : p.path}"${here ? ' aria-current="page"' : ''}>${esc(p.title)}</a>${sub}`;
	}).join('\n      ');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.path === 'index.html' ? 'Roster Mapper' : `${esc(page.title)} · Roster Mapper`}</title>
<meta name="description" content="${esc(page.description)}">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231c1c1c'/%3E%3Cpath d='M8 10h16M8 16h16M8 22h10' stroke='%23f0782c' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
<aside class="side">
  <a class="brand" href="${up}./">Roster Mapper</a>
  <div class="quick">
    <a href="${up}app/">${icon.play} Open the app</a>
    <a href="${REPO}" target="_blank" rel="noopener">${icon.repo} GitHub</a>
  </div>
  <details class="menu"><summary>Menu</summary></details>
  <nav aria-label="Pages">
      ${nav}
  </nav>
</aside>
<main>
<article class="doc">
${page.body}
<footer class="foot">Roster Mapper ${esc(version)} · MIT · <a href="${REPO}" target="_blank" rel="noopener">Source on GitHub</a></footer>
</article>
</main>
<script>
  // Mark the section in view in the sidebar.
  const links = [...document.querySelectorAll('.side .sub a')];
  const targets = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
  const mark = () => { let on = targets[0]; for (const t of targets) if (t.getBoundingClientRect().top < 120) on = t; links.forEach((a) => a.classList.toggle('active', on && a.hash === '#' + on.id)); };
  addEventListener('scroll', mark, { passive: true }); mark();
  document.querySelectorAll('.side nav a').forEach((a) => a.addEventListener('click', () => document.querySelector('.menu')?.removeAttribute('open')));
</script>
</body>
</html>
`;
}

// ─── Home ───────────────────────────────────────────────────
// Each sample as sent and as cleaned, for the home page's preview (scripts/demo-previews.ts).
const previews = await buildPreviews(root, samples.map((s) => s.file));
const previewData = JSON.stringify(samples.map((s) => ({ file: s.file, title: s.title, format: s.format, blurb: s.blurb, sheets: previews[s.file] ?? [] }))).replace(/</g, '\\u003c');

const PREVIEW_JS = readFileSync(new URL('demo/site/preview.js', root), 'utf8');

const homeBody = `
<section class="hero">
<h1>Roster Mapper</h1>
<p class="lede">Provider rosters come in every shape. Roster Mapper turns any roster file (xlsx, xls or csv) into a clean change file for your provider directory, with a summary of the mapping, every issue, and every row left out and why.</p>
<div class="actions">
  <a class="btn primary" href="#samples">${icon.play} See it on a sample</a>
  <a class="btn" href="app/">Map your own file</a>
</div>
<p class="small muted" style="margin-top:.9rem">Your files are read in your browser and never uploaded. Only NPIs and addresses go out, to NPPES and the US Census geocoder.</p>
</section>

<h2 id="samples"><a class="anchor" href="#samples">Try a sample</a></h2>
<p>Real rosters arrive messy. Pick one and flip between the file as sent and what Roster Mapper makes of it: every highlighted cell was changed (hover to see what it was), and rows that can't move forward say why.</p>
<div class="pv" id="pv">
  <div class="pv-pick" role="tablist" aria-label="Sample rosters">
    ${samples.map((s, i) => `<button type="button" role="tab" data-i="${i}">${esc(s.title)} <span class="fmt">${esc(s.format)}</span></button>`).join('\n    ')}
    <button type="button" class="pv-random" id="pv-random" title="A random sample">${icon.shuffle}<span class="sr">Random sample</span></button>
  </div>
  <div class="pv-card">
    <div class="pv-head">
      <p class="pv-blurb" id="pv-blurb"></p>
      <p class="pv-links"><a id="pv-open" class="pv-open" href="app/">Open in the app →</a> <a id="pv-download" href="rosters/" download>Download</a></p>
    </div>
    <div class="pv-bar">
      <span class="seg" role="group" aria-label="View"><button type="button" data-view="sent">As sent</button><button type="button" data-view="clean">Cleaned</button></span>
      <span class="pv-sheets" id="pv-sheets"></span>
      <span class="pv-stats" id="pv-stats"></span>
    </div>
    <p class="pv-note" id="pv-note"></p>
    <div class="pv-scroll"><table class="pv-table" id="pv-table"></table></div>
    <p class="pv-foot" id="pv-foot"></p>
  </div>
</div>
<p class="note">The NPIs are real: a random sample drawn from <a href="https://npiregistry.cms.hhs.gov/" target="_blank" rel="noopener">NPPES</a> on ${esc(drawn)}, with each provider's name, credential, taxonomy and practice address as NPPES lists them. Which provider sits under which group is random and says nothing about where anyone works. Every tax ID (<code>99-99xxxxx</code>) is a placeholder.</p>

<h2 id="how-it-works"><a class="anchor" href="#how-it-works">How it works</a></h2>
<ol class="steps">
  <li><b>Read</b><span>Every sheet of an xlsx, xls or csv into rows. SSNs are removed as the file is read.</span></li>
  <li><b>Map</b><span>Find the header row, match columns to the <a href="docs/fields.html">schema</a>, detect the action (add, update, term) and category.</span></li>
  <li><b>Standardize</b><span>Dates, NPIs, tax IDs, ZIPs, phones, states and names into one format; rows that can't move forward are left out, with the reason.</span></li>
  <li><b>Validate</b><span>NPIs against NPPES, addresses against the US Census geocoder.</span></li>
  <li><b>Review</b><span>Providers, practice locations and billing entities, and how they connect.</span></li>
  <li><b>Export</b><span>One workbook per sheet: Summary, Mapping, Data, Issues and Left out.</span></li>
</ol>
<p>Each step is described in <a href="docs/steps.html">Processing steps</a>.</p>

<h2 id="install"><a class="anchor" href="#install">Install</a></h2>
<p>The same pipeline runs from the command line, with the app one flag away, and as a library in Node or the browser.</p>
<pre><code>npm install -g rostermapper</code></pre>
<pre><code>rostermapper roster.xlsx          # writes output/RM_roster_&lt;sheet&gt;.xlsx
rostermapper roster.xlsx --steps  # one step at a time
rostermapper roster.xlsx --ui     # open the app on this machine</code></pre>
<p>See <a href="docs/usage.html">Usage</a> for every option, the library and embedding the app in your own portal.</p>

<script type="application/json" id="pv-data">${previewData}</script>
<script>${PREVIEW_JS}</script>
`;

const pages: Page[] = [
	{ path: 'index.html', title: 'Introduction', heads: [{ id: 'samples', text: 'Try a sample' }, { id: 'how-it-works', text: 'How it works' }, { id: 'install', text: 'Install' }], body: homeBody,
		description: 'Map any healthcare provider roster file (xlsx, xls, csv) to a standard schema, in your browser. Try it on sample rosters.' },
	...DOCS.map((d) => renderDoc(readFileSync(new URL(d.md, root), 'utf8'), d.path)),
];
for (const p of pages) writeFileSync(new URL(p.path, out), shell(p, pages));
console.log(`Wrote ${out.pathname}: ${pages.length} pages, ${samples.length} sample rosters, the app.`);
