'use strict';
// Sovereignty leaderboard — fetches /api/rankings and renders the table.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
const cell = (v) => v == null ? '<span class="sc dash">—</span>' : `<span class="sc" style="color:${sovColor(v)}">${v}</span>`;

const PER = 100;
const body = () => document.getElementById('rank-body');
const state = () => document.getElementById('rank-state');
const countEl = () => document.getElementById('rank-count');
const pagerEl = () => document.getElementById('rank-pager');

function renderPager(d) {
  if (!d || d.pages <= 1) { pagerEl().innerHTML = ''; return; }
  pagerEl().innerHTML =
    `<button class="pg" ${d.page <= 1 ? 'disabled' : ''} data-page="${d.page - 1}">← prev</button>` +
    `<span class="pg-info">page ${d.page.toLocaleString()} of ${d.pages.toLocaleString()}</span>` +
    `<button class="pg" ${d.page >= d.pages ? 'disabled' : ''} data-page="${d.page + 1}">next →</button>`;
  pagerEl().querySelectorAll('button[data-page]').forEach((b) => {
    b.onclick = () => { if (!b.disabled) load(Number(b.dataset.page)); };
  });
}

async function load(page) {
  page = page || Number(new URLSearchParams(location.search).get('page')) || 1;
  state().innerHTML = '';
  try {
    const res = await fetch(`/api/rankings?page=${page}&per=${PER}`);
    const data = await res.json();
    const rows = data.rankings || [];
    if (!data.total) {
      countEl().textContent = 'no domains checked yet';
      state().innerHTML = '<div class="state">Nothing here yet. <a href="/sovereignty">Run the first sovereignty check →</a></div>';
      body().innerHTML = ''; pagerEl().innerHTML = '';
      return;
    }
    const from = (data.page - 1) * data.per + 1, to = (data.page - 1) * data.per + rows.length;
    countEl().textContent = `${data.total.toLocaleString()} domains checked · ranked most → least sovereign · showing ${from.toLocaleString()}–${to.toLocaleString()}`;
    body().innerHTML = rows.map((r) => {
      const href = '/sovereignty?d=' + encodeURIComponent(r.domain);
      return `<tr>
        <td class="rank">${r.rank}</td>
        <td class="dom"><a href="${esc(href)}">${esc(r.domain)}</a></td>
        <td>${cell(r.web)}</td>
        <td>${cell(r.mail)}</td>
        <td class="when">${esc(ago(r.at))}</td>
        <td class="go"><a href="${esc(href)}" title="open the full check">→</a></td>
      </tr>`;
    }).join('');
    renderPager(data);
    try { history.replaceState(null, '', data.page > 1 ? `?page=${data.page}` : location.pathname); } catch { /* ignore */ }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    countEl().textContent = '';
    state().innerHTML = '<div class="state">Couldn\'t load the ranking. <a href="/ranking">Retry</a></div>';
  }
}
load();
