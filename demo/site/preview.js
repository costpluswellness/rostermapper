// The home page's sample preview: a sample roster as sent and as cleaned. The data comes from
// scripts/demo-previews.ts at build time (#pv-data); this only draws it.
(() => {
  const data = JSON.parse(document.getElementById('pv-data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const at = { sample: Math.floor(Math.random() * data.length), sheet: 0, view: 'sent' };

  function draw() {
    const s = data[at.sample];
    const sh = s.sheets[at.sheet] ?? s.sheets[0];
    document.querySelectorAll('.pv-pick [data-i]').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.i === at.sample)));
    document.querySelectorAll('.seg [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === at.view));
    $('pv-blurb').textContent = s.blurb;
    $('pv-open').href = 'app/?sample=' + encodeURIComponent(s.file);
    $('pv-download').href = 'rosters/' + encodeURIComponent(s.file);
    $('pv-download').textContent = `Download ${s.format}`;
    $('pv-sheets').innerHTML = s.sheets.length > 1
      ? s.sheets.map((x, i) => `<button type="button" data-sheet="${i}" class="${i === at.sheet ? 'on' : ''}">${esc(x.name)}</button>`).join('')
      : '';
    $('pv-sheets').querySelectorAll('button').forEach((b) => (b.onclick = () => { at.sheet = +b.dataset.sheet; draw(); }));
    const c = sh.counts;
    $('pv-stats').innerHTML = `${plural(c.rows, 'row')} · <b class="chg-text">${plural(c.changed, 'value')} cleaned</b>` + (c.leftOut ? ` · <b class="drop-text">${c.leftOut} left out</b>` : '');
    const notes = [];
    if (at.view === 'sent') {
      if (sh.headerRow > 0) notes.push(`Header found on row ${sh.headerRow + 1}, under ${plural(sh.headerRow, 'row')} of titles.`);
      notes.push(`Underlined cells change when cleaned.`);
    } else {
      notes.push(`<b>${esc(sh.action)}</b>, ${esc(sh.category)}: ${esc(sh.actionWhy)}.`);
      const unmapped = sh.headers.filter((h, i) => h && !sh.fields[i]);
      if (unmapped.length) notes.push(`Not mapped: ${unmapped.map(esc).join(', ')}.`);
    }
    if (sh.transform) notes.push(`<span class="warn-text">${esc(sh.transform)}</span>`);
    $('pv-note').innerHTML = notes.join(' ');
    $('pv-table').innerHTML = at.view === 'sent' ? sent(sh) : clean(sh);
    const dropped = at.view === 'clean' ? sh.rows.filter((r) => r.drop).map((r) => `<span class="drop-text">Row ${r.n} left out:</span> ${esc(r.drop)}`) : [];
    $('pv-foot').innerHTML = dropped.join('<br>') + (dropped.length && sh.more ? '<br>' : '') + (sh.more ? `${plural(sh.more, 'more row')} in the app. <a href="app/?sample=${encodeURIComponent(s.file)}">Open it →</a>` : '');
  }

  function sent(sh) {
    const width = sh.headers.length;
    const pad = (r) => Array.from({ length: width }, (_, i) => r[i] ?? '');
    const above = sh.above.map((r, i) => `<tr class="above"><th class="n">${i + 1}</th>${pad(r).map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
    const head = `<tr class="hdr"><th class="n" title="The header row">${sh.headerRow + 1}</th>${sh.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`;
    const body = sh.rows.map((r) => `<tr class="${r.drop ? 'drop' : ''}"><th class="n">${r.n}</th>${r.raw.map((v, i) =>
      `<td class="${r.changed.includes(i) ? 'will' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('');
    return `<thead>${above}${head}</thead><tbody>${body}</tbody>`;
  }

  function clean(sh) {
    const cols = sh.fields.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    const head = `<tr><th class="n"></th><th class="status">Status</th>${cols.map((i) => `<th title="From the column &quot;${esc(sh.headers[i])}&quot;"><code>${esc(sh.fields[i])}</code><small>${esc(sh.headers[i])}</small></th>`).join('')}` +
      sh.added.map((a) => `<th class="added" title="${esc(a.why)}"><code>${esc(a.field)}</code><small>added</small></th>`).join('') + `</tr>`;
    const body = sh.rows.map((r) => `<tr class="${r.drop ? 'drop' : ''}"><th class="n">${r.n}</th>${r.drop
      ? `<td class="status" title="${esc(r.drop)}"><span class="drop-text">Left out</span></td>`
      : '<td class="status"><span class="ok-text">Moves on</span></td>'}${cols.map((i) => {
      const changed = r.changed.includes(i);
      const flag = r.flags[i];
      const tip = [changed ? `was: ${r.raw[i] || '(blank)'}` : '', flag ?? ''].filter(Boolean).join('\n');
      return `<td class="${changed ? 'chg' : ''}${flag ? ' flag' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(r.clean[i])}</td>`;
    }).join('')}${r.extra.map((v) => `<td class="added">${esc(v)}</td>`).join('')}</tr>`).join('');
    return `<thead>${head}</thead><tbody>${body}</tbody>`;
  }

  document.querySelectorAll('.pv-pick [data-i]').forEach((b) => (b.onclick = () => { at.sample = +b.dataset.i; at.sheet = 0; draw(); }));
  document.querySelectorAll('.seg [data-view]').forEach((b) => (b.onclick = () => { at.view = b.dataset.view; draw(); }));
  $('pv-random').onclick = () => {
    let next = at.sample;
    while (data.length > 1 && next === at.sample) next = Math.floor(Math.random() * data.length);
    at.sample = next; at.sheet = 0; draw();
  };
  draw();
})();
