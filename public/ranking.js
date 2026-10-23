'use strict';
// Sovereignty leaderboard — fetches /api/rankings and renders the table.

const sovColor = (s) => {
  if (s == null) return 'var(--faint)';
  const p = (100 - s) / 100; // green #35e0a1 → red #ff6272
  const ch = [53 + (255 - 53) * p, 224 + (98 - 224) * p, 161 + (114 - 161) * p];
  return `rgb(${ch.map(Math.round).join(',')})`;
};
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
// tiny DOM builder: text goes in as text nodes, so nothing is ever parsed as HTML
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'color') el.style.color = v;
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((c) => c != null && c !== false));
  return el;
};
const cell = (v) => v == null ? h('span', { class: 'sc dash' }, '—') : h('span', { class: 'sc', color: sovColor(v) }, String(v));

const PER = 100;
const body = () => document.getElementById('rank-body');
const state = () => document.getElementById('rank-state');
const countEl = () => document.getElementById('rank-count');
const pagerEl = () => document.getElementById('rank-pager');

function renderPager(d) {
  if (!d || d.pages <= 1) { pagerEl().replaceChildren(); return; }
  const btn = (label, page, disabled) => {
    const b = h('button', { class: 'pg', disabled, data: { page } }, label);
    b.onclick = () => { if (!b.disabled) load(page); };
    return b;
  };
  pagerEl().replaceChildren(
    btn('← prev', d.page - 1, d.page <= 1),
    h('span', { class: 'pg-info' }, `page ${d.page.toLocaleString()} of ${d.pages.toLocaleString()}`),
    btn('next →', d.page + 1, d.page >= d.pages),
  );
}

async function load(page) {
  page = page || Number(new URLSearchParams(location.search).get('page')) || 1;
  state().replaceChildren();
  try {
    const res = await fetch(`/api/rankings?page=${page}&per=${PER}`);
    const data = await res.json();
    const rows = data.rankings || [];
    if (!data.total) {
      countEl().textContent = 'no domains checked yet';
      state().replaceChildren(h('div', { class: 'state' }, 'Nothing here yet. ', h('a', { href: '/sovereignty' }, 'Run the first sovereignty check →')));
      body().replaceChildren(); pagerEl().replaceChildren();
      return;
    }
    const from = (data.page - 1) * data.per + 1, to = (data.page - 1) * data.per + rows.length;
    countEl().textContent = `${data.total.toLocaleString()} domains checked · ranked most → least sovereign · showing ${from.toLocaleString()}–${to.toLocaleString()}`;
    body().replaceChildren(...rows.map((r) => {
      const href = '/sovereignty?d=' + encodeURIComponent(r.domain);
      return h('tr', null,
        h('td', { class: 'rank' }, String(r.rank)),
        h('td', { class: 'dom' }, h('a', { href }, r.domain)),
        h('td', null, cell(r.web)),
        h('td', null, cell(r.mail)),
        h('td', { class: 'when' }, ago(r.at)),
        h('td', { class: 'go' }, h('a', { href, title: 'open the full check' }, '→')));
    }));
    renderPager(data);
    try { history.replaceState(null, '', data.page > 1 ? `?page=${data.page}` : location.pathname); } catch { /* ignore */ }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    countEl().textContent = '';
    state().replaceChildren(h('div', { class: 'state' }, "Couldn't load the ranking. ", h('a', { href: '/ranking' }, 'Retry')));
  }
}
load();
