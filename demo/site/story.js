// The home page's story: a few rows of a messy roster as sent (before), then the
// providers, practice locations and billing entities they describe, linked. The data comes from
// scripts/demo-previews.ts (buildStory) at build time: the library's own cleaning and grouping.
(() => {
  const story = JSON.parse(document.getElementById('story-data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = $('story');
  const g = story.graph;

  // ─── Table: the rows as sent, with the values Roster Mapper changes underlined ───
  $('story-table').innerHTML = `<thead><tr><th class="n"></th>${story.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
    story.rows.map((r) => `<tr><th class="n">${r.n}</th>${r.raw.map((v, i) => `<td class="${r.changed.includes(i) ? 'c' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('') + '</tbody>';

  // ─── Graph: three columns, linked left to right ───
  const W = 720, NW = 210, NH = 58, GAP = 14, X = [0, 255, 510];
  const cols = [g.providers, g.locations, g.billing];
  const H = Math.max(...cols.map((c) => c.length)) * (NH + GAP) - GAP + 2;
  const pos = new Map();
  cols.forEach((list, c) => {
    const top = (H - (list.length * (NH + GAP) - GAP)) / 2;
    list.forEach((n, i) => pos.set(n.id, { x: X[c], y: top + i * (NH + GAP), c }));
  });
  const kinds = ['provider', 'location', 'billing'];
  const nodeSvg = (n) => {
    const p = pos.get(n.id);
    return `<g class="node ${kinds[p.c]}" data-id="${n.id}" style="--d:${p.c}" transform="translate(${p.x + 1} ${p.y + 1})">
      <rect width="${NW}" height="${NH}" rx="8"/>
      <text x="12" y="20" class="t">${esc(cut(n.title, 27))}</text>
      <text x="12" y="36" class="s">${esc(cut(n.sub, 34))}</text>
      <text x="12" y="50" class="r">${n.rows.length > 1 ? 'rows' : 'row'} ${n.rows.join(', ')}</text></g>`;
  };
  const linkSvg = ([a, b]) => {
    const p = pos.get(a), q = pos.get(b);
    const x1 = p.x + NW + 1, y1 = p.y + NH / 2 + 1, x2 = q.x + 1, y2 = q.y + NH / 2 + 1, m = (x1 + x2) / 2;
    return `<path class="link" data-a="${a}" data-b="${b}" style="--d:${p.c}" pathLength="1" d="M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}"/>`;
  };
  const svg = $('story-graph');
  svg.innerHTML = `<g class="heads">${['Providers', 'Practice locations', 'Billing'].map((t, c) => `<text x="${X[c] + 2}" y="-10">${t}</text>`).join('')}</g>` +
    g.links.map(linkSvg).join('') + cols.flat().map(nodeSvg).join('');
  svg.setAttribute('viewBox', `0 -24 ${W} ${H + 24}`);

  // Hover a node: its whole chain lights up.
  const neighbors = (id) => g.links.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));
  function chain(id) {
    const seen = new Set([id]);
    const walk = (from, dir) => { for (const n of neighbors(from)) { const d = Math.sign(pos.get(n).c - pos.get(from).c); if (d === dir && !seen.has(n)) { seen.add(n); walk(n, dir); } } };
    walk(id, 1); walk(id, -1);
    return seen;
  }
  svg.querySelectorAll('.node').forEach((el) => {
    el.onmouseenter = () => {
      const on = chain(el.dataset.id);
      svg.classList.add('focus');
      svg.querySelectorAll('.node').forEach((n) => n.classList.toggle('hl', on.has(n.dataset.id)));
      svg.querySelectorAll('.link').forEach((l) => l.classList.toggle('hl', on.has(l.dataset.a) && on.has(l.dataset.b)));
    };
    el.onmouseleave = () => { svg.classList.remove('focus'); svg.querySelectorAll('.hl').forEach((n) => n.classList.remove('hl')); };
  });

  // ─── Stages ───
  let stage = 0;
  function show(s) {
    stage = s;
    root.dataset.stage = String(s);
    root.querySelectorAll('[data-stage-btn]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.stageBtn === s)));
  }

  // Plays on its own once in view; a click on a step takes over. Reduced motion: the network, still.
  const DWELL = [1800, 9000];
  let timer = null, playing = !still, visible = false;
  const tick = () => { clearTimeout(timer); if (playing && visible) timer = setTimeout(() => { show((stage + 1) % 2); tick(); }, DWELL[stage]); };
  const setPlaying = (on) => {
    playing = on;
    $('story-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
    $('story-play').innerHTML = on ? '❚❚' : '▶';
    tick();
  };
  root.querySelectorAll('[data-stage-btn]').forEach((b) => (b.onclick = () => { setPlaying(false); show(+b.dataset.stageBtn); }));
  $('story-play').onclick = () => setPlaying(!playing);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; tick(); }, { threshold: 0.4 }).observe(root);
  show(still ? 1 : 0);
  setPlaying(playing);
})();
