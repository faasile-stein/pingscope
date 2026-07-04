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

async function load() {
  const body = document.getElementById('rank-body');
  const state = document.getElementById('rank-state');
  const count = document.getElementById('rank-count');
  try {
    const res = await fetch('/api/rankings');
    const data = await res.json();
    const rows = data.rankings || [];
    if (!rows.length) {
      count.textContent = 'no domains checked yet';
      state.innerHTML = '<div class="state">Nothing here yet. <a href="/sovereignty">Run the first sovereignty check →</a></div>';
      return;
    }
    count.textContent = `${rows.length} domain${rows.length === 1 ? '' : 's'} checked · ranked most → least sovereign`;
    body.innerHTML = rows.map((r, i) => {
      const href = '/sovereignty?d=' + encodeURIComponent(r.domain);
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td class="dom"><a href="${esc(href)}">${esc(r.domain)}</a></td>
        <td>${cell(r.web)}</td>
        <td>${cell(r.mail)}</td>
        <td class="when">${esc(ago(r.at))}</td>
        <td class="go"><a href="${esc(href)}" title="open the full check">→</a></td>
      </tr>`;
    }).join('');
  } catch {
    count.textContent = '';
    state.innerHTML = '<div class="state">Couldn\'t load the ranking. <a href="/ranking">Retry</a></div>';
  }
}
load();
