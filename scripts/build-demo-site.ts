// Builds the public demo site into demo/_site/ (Netlify publishes it; see netlify.toml):
//   /                 one page: what Roster Mapper does, the sample rosters, then docs/*.md inlined
//   /app/             the UI (dist/ui/, so run `pnpm build` first), offering the samples
//   /rosters/         the sample rosters (demo/rosters/)
// The UI asks its host for `session` and `file`, with the page's query string: _redirects answers
// app/session?sample=<file> and app/file?sample=<file> with that sample. Lookups go to the function
// in demo/netlify/functions/. `pnpm demo:serve` serves the result locally the same way.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Marked, type Tokens } from 'marked';
import { buildStory } from './demo-previews.ts';

const root = new URL('../', import.meta.url);
const out = new URL('demo/_site/', root);
const REPO = 'https://github.com/costpluswellness/rostermapper';
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };

type Sample = { file: string; title: string; format: string; rows: number; shows: string[] };
const samples = JSON.parse(readFileSync(new URL('demo/rosters/manifest.json', root), 'utf8')) as Sample[];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
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
	// The docs were pages of their own before the site became one page.
	'/docs/usage.html   /#usage             301',
	'/docs/steps.html   /#processing-steps  301',
	'/docs/fields.html  /#schema            301',
	'/docs/*            /                   301',
	'',
].join('\n'));

// ─── Pages ──────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const slug = (text: string) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

// The docs, inlined after the home sections: each doc's # heading becomes a ## section, and links
// between docs become links within the page.
type Section = { id: string; title: string; heads: { id: string; text: string }[]; body: string };

const DOCS = [
	{ md: 'usage.md', title: 'Usage' },
	{ md: 'steps.md', title: 'Processing steps' },
	{ md: 'data_sources.md', title: 'Data sources' },
	{ md: 'canonical_fields.md', title: 'Schema' },
];
const sectionId = new Map(DOCS.map((d) => [d.md, slug(d.title)]));
const ids = new Set(['story', 'how-it-works']);
const claim = (id: string) => { if (ids.has(id)) throw new Error(`Two headings on the page share the id "${id}"`); ids.add(id); return id; };

// The schema on the site: no per-action levels (the last three columns) and no generated-file note.
function siteSchema(md: string): string {
	return md.split('\n')
		.filter((l) => !l.startsWith('GENERATED from') && !l.startsWith('Levels per action'))
		.map((l) => {
			if (!l.startsWith('|')) return l;
			const cells = l.split(/(?<!\\)\|/).slice(1, -1);
			return cells.length === 7 ? `|${cells.slice(0, 4).join('|')}|` : l;
		})
		.join('\n');
}

// Links the first mention of each data source in every section (between headings) to its entry in
// Data sources. Skips text inside links, code, headings and scripts, and the Data sources section.
const SOURCES: [RegExp, string][] = [
	[/\bNPPES\b/, 'nppes'],
	[/\b(?:US )?Census(?: geocoder)?\b/, 'us-census-geocoder'],
	[/\bNUCC\b/, 'nucc'],
];
function linkSources(html: string): string {
	let skip = 0, inSources = false, linked = new Set<string>();
	return html.replace(/(<\/?([a-z][\w-]*)\b[^>]*>)|([^<]+)/gi, (m, tag: string, name: string, text: string) => {
		if (tag) {
			const n = name.toLowerCase();
			const heading = /^h[1-6]$/.test(n);
			if (heading && !tag.startsWith('</')) {
				linked = new Set();
				const id = /id="([^"]+)"/.exec(tag)?.[1];
				if (n === 'h2') inSources = id === 'data-sources';
			}
			if (heading || ['a', 'code', 'pre', 'script', 'button', 'summary'].includes(n)) skip += tag.startsWith('</') ? -1 : 1;
			return m;
		}
		if (skip || inSources) return m;
		for (const [re, id] of SOURCES) {
			if (linked.has(id)) continue;
			text = text.replace(re, (t) => { linked.add(id); return `<a href="#${id}">${t}</a>`; });
		}
		return text;
	});
}

function renderDoc(md: string, title: string): Section {
	const id = claim(slug(title));
	const heads: Section['heads'] = [];
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth }: Tokens.Heading) {
				if (depth === 1) return `<h2 id="${id}"><a class="anchor" href="#${id}">${esc(title)}</a></h2>\n`;
				const text = this.parser.parseInline(tokens);
				const hid = claim(slug(text));
				if (depth === 2) heads.push({ id: hid, text: text.replace(/<[^>]+>/g, '') });
				return `<h${depth + 1} id="${hid}"><a class="anchor" href="#${hid}">${text}</a></h${depth + 1}>\n`;
			},
			link({ href, tokens }: Tokens.Link) {
				const text = this.parser.parseInline(tokens);
				let to = href;
				const [file = '', hash] = href.split('#');
				if (/^[\w-]+\.md$/.test(file) && sectionId.has(file)) to = `#${hash || sectionId.get(file)}`;
				else if (/^(\.\.\/|[\w-]+\/)/.test(href) && !/^https?:/.test(href)) to = `${REPO}/blob/main/${href.replace(/^(\.\.\/)+/, '')}`;
				else if (/\.md$/.test(file) && !/^https?:/.test(href)) to = `${REPO}/blob/main/${file}`;
				const external = /^https?:/.test(to);
				return `<a href="${esc(to)}"${external ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
			},
		},
	});
	return { id, title, heads, body: marked.parse(md) as string };
}

const icon = {
	play: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3.5v9l7-4.5z" stroke-linejoin="round"/></svg>',
	shuffle: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5h2.5c3 0 4 7 7 7H14M12 9.5l2 2-2 2M2 11.5h2.5c1.2 0 2-1 2.7-2.3M9.3 6.8c.7-1.3 1.5-2.3 2.7-2.3H14M12 2.5l2 2-2 2"/></svg>',
	repo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 12.5c-3 1-3-1.5-4.5-2M10 14.5v-2.3c0-.7.1-1.2-.4-1.7 2.2-.3 4.4-1 4.4-4.6 0-1-.4-1.8-1-2.5.1-.4.4-1.4-.1-2.6 0 0-.8-.3-2.7 1a9 9 0 0 0-4.6 0C3.7.5 2.9.8 2.9.8c-.5 1.2-.2 2.2-.1 2.6-.6.7-1 1.5-1 2.5 0 3.6 2.2 4.3 4.4 4.6-.5.4-.5 1-.4 1.7v2.3"/></svg>',
};

function shell(sections: Section[], body: string): string {
	const nav = sections.map((p) => {
		const sub = p.heads.length ? `<div class="sub">${p.heads.map((h) => `<a href="#${h.id}">${h.text}</a>`).join('')}</div>` : '';
		return `<a class="page" href="#${p.id}">${esc(p.title)}</a>${sub}`;
	}).join('\n      ');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roster Mapper</title>
<meta name="description" content="Map any healthcare provider roster file (xlsx, xls, csv) to a canonical schema, in your browser. Try it on sample rosters.">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231c1c1c'/%3E%3Cpath d='M8 10h16M8 16h16M8 22h10' stroke='%23f0782c' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="style.css">
</head>
<body>
<aside class="side">
  <a class="brand" href="#top">Roster Mapper</a>
  <div class="quick">
    <a href="app/">${icon.play} Open the app</a>
    <a href="${REPO}" target="_blank" rel="noopener">${icon.repo} GitHub</a>
  </div>
  <details class="menu"><summary>Menu</summary></details>
  <nav aria-label="Sections">
      ${nav}
  </nav>
</aside>
<main id="top">
<article class="doc">
${body}
<footer class="foot">Roster Mapper ${esc(version)} · MIT · <a href="${REPO}" target="_blank" rel="noopener">Source on GitHub</a> · Made by the team at <a href="https://costpluswellness.com" target="_blank" rel="noopener">Cost Plus Wellness</a></footer>
</article>
</main>
<script>
  // Mark the section in view in the sidebar.
  const links = [...document.querySelectorAll('.side nav a')];
  const targets = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
  const mark = () => { let on = targets[0]; for (const t of targets) if (t.getBoundingClientRect().top < 120) on = t; links.forEach((a) => a.classList.toggle('active', on && a.hash === '#' + on.id)); };
  addEventListener('scroll', mark, { passive: true }); mark();
  links.forEach((a) => a.addEventListener('click', () => document.querySelector('.menu')?.removeAttribute('open')));
</script>
</body>
</html>
`;
}

// ─── Home ───────────────────────────────────────────────────
// The story under the hero: a few rows of the messiest sample, cleaned, then as a network.
const STORY_FILE = 'hand-edited.csv';
const storyData = JSON.stringify(await buildStory(root, STORY_FILE)).replace(/</g, '\\u003c');
const STORY_JS = readFileSync(new URL('demo/site/story.js', root), 'utf8');

const homeBody = `
<section class="hero">
<h1>Roster Mapper</h1>
<p class="lede">Provider rosters come in different shapes and formats. Roster Mapper maps any roster file to a <a href="#schema">canonical schema</a>, standardizes values against public sources, and produces a clean change file for your roster directory.</p>
<div class="actions">
  <a class="btn primary" href="app/">${icon.play} Open the app</a>
</div>
</section>

<section class="story" id="story" data-stage="0" aria-label="From a messy roster to a network">
  <div class="story-bar">
    <span class="story-steps" role="group" aria-label="Steps">
      <button type="button" data-stage-btn="0"><b>1</b> Before</button>
      <button type="button" data-stage-btn="1"><b>2</b> After</button>
    </span>
    <button type="button" class="story-play" id="story-play" aria-label="Pause">❚❚</button>
  </div>
  <div class="story-stage">
    <div class="story-table"><table id="story-table"></table></div>
    <div class="story-graph"><svg id="story-graph" role="img" aria-label="Providers, practice locations and billing entities, linked"></svg></div>
  </div>
</section>
<script type="application/json" id="story-data">${storyData}</script>
<script>${STORY_JS}</script>

<h2 id="how-it-works"><a class="anchor" href="#how-it-works">How it works</a></h2>
<ol class="steps">
  <li><b>Read</b><span>Every sheet of an xlsx, xls or csv into rows. SSNs are removed as the file is read.</span></li>
  <li><b>Map</b><span>Find the header row, match columns to the <a href="#schema">schema</a>, detect the action (add, update, term) and category.</span></li>
  <li><b>Standardize</b><span>Dates, NPIs, tax IDs, ZIPs, phones, states and names into one format; rows that can't move forward are left out, with the reason.</span></li>
  <li><b>Validate</b><span>NPIs against NPPES, addresses against the US Census geocoder.</span></li>
  <li><b>Review</b><span>Providers, practice locations and billing entities, and how they connect.</span></li>
  <li><b>Export</b><span>One workbook per sheet: Summary, Mapping, Data, Issues and Left out.</span></li>
</ol>
<p>Each step is described in <a href="#processing-steps">Processing steps</a>.</p>

`;

const docs = DOCS.map((d) => {
	const md = readFileSync(new URL(`docs/${d.md}`, root), 'utf8');
	return renderDoc(d.md === 'canonical_fields.md' ? siteSchema(md) : md, d.title);
});
const sections: Section[] = [
	{ id: 'top', title: 'Introduction', heads: [{ id: 'how-it-works', text: 'How it works' }], body: homeBody },
	...docs,
];
writeFileSync(new URL('index.html', out), shell(sections, linkSources(sections.map((p) => p.body).join('\n'))));
console.log(`Wrote ${out.pathname}: one page, ${samples.length} sample rosters, the app.`);
