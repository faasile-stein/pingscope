'use strict';
// Standalone European-sovereignty checker. Calls the shared /api/sovereignty
// endpoint and renders the web + mail scores. (The live-streaming version with
// per-hop discovery lives in the main app.)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ccFlag = (cc) => (!cc || cc.length !== 2) ? '🌐'
  : cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
// green (high / sovereign) → red (low)
const sovColor = (s) => {
  if (s == null) return 'var(--muted)';
  const p = 100 - s;
  const ch = [54 + (255 - 54) * p / 100, 241 + (59 - 241) * p / 100, 163 + (107 - 163) * p / 100];
  return `rgb(${ch.map(Math.round).join(',')})`;
};
const sovLabel = (s) => (s == null ? 'no data' : s >= 80 ? 'sovereign' : s >= 50 ? 'partial' : 'non-sovereign');

const resultEl = document.getElementById('result');

function serverHtml(sv) {
  const ownerFlag = sv.ownerCc ? ccFlag(sv.ownerCc) : '';
  const half = sv.eu && !sv.euOwned;
  const asTitle = sv.euOwned ? '' : `owned by ${esc(sv.ownerParent || sv.asName || 'a non-sovereign company')} (${esc(sv.ownerCc || '?')}) — outside the sovereign area, hosting score halved`;
  return `<div class="srv">
    <div class="srv-top"><span>${ccFlag(sv.cc)}</span><span class="srv-ip">${esc(sv.exchange || sv.ip)}</span></div>
    <div class="srv-sub">
      <span class="srv-geo">${esc([sv.city, sv.country].filter(Boolean).join(', ') || 'location unknown')}</span>
      <span class="srv-as ${sv.euOwned ? 'ok' : 'bad'}"${asTitle ? ` title="${asTitle}"` : ''}>${ownerFlag} ${esc(sv.asName || sv.as || '')}${half ? ' <b class="half">½</b>' : ''}</span>
    </div>
  </div>`;
}

function catHtml(title, icon, cat, emptyMsg) {
  if (!cat || (cat.score == null && (!cat.servers || !cat.servers.length))) {
    return `<div class="cat"><div class="cat-h">${icon} ${title}</div><div class="cat-empty">${esc(emptyMsg)}</div></div>`;
  }
  const color = sovColor(cat.score);
  const servers = (cat.servers || []).map(serverHtml).join('') || '<div class="cat-empty">no servers resolved</div>';
  const transit = cat.transit
    ? `route <b>${cat.transit.hopsNonEuPct}%</b> hops · <b>${cat.transit.netsNonEuPct}%</b> networks non-sovereign`
    : '<span class="dim">route not measured (target blocks traceroute)</span>';
  // "visualize" opens the live MTR on a map (geographic view) in the main app
  const primaryIp = (cat.servers && cat.servers[0] && cat.servers[0].ip) || '';
  const viz = primaryIp ? `<a class="viz-pill" href="/?mtr=${encodeURIComponent(primaryIp)}&view=geo" target="_blank" rel="noopener" title="trace this route on a world map">▸ visualize</a>` : '';
  return `<div class="cat">
    <div class="cat-h">${icon} ${title}${viz}</div>
    <div class="score" style="color:${color}">${cat.score == null ? '—' : cat.score}<small>/100</small></div>
    <div class="badge" style="color:${color};border-color:${color}">${sovLabel(cat.score)}</div>
    ${servers}
    <div class="transit">${transit}</div>
  </div>`;
}

async function check(input) {
  const q = (input || '').trim();
  if (!q) return;
  resultEl.innerHTML = '<div class="r-loading">tracing web + mail routes… this can take a few seconds</div>';
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setBusy(true);
  try {
    const res = await fetch('/api/sovereignty?url=' + encodeURIComponent(q));
    const data = await res.json();
    if (!res.ok) { resultEl.innerHTML = `<div class="r-error">${esc(data.error || 'scan failed')}</div>`; return; }
    const web = data.web && data.web.score, mail = data.mail && data.mail.score;
    // shareable link carries the scores so the crawler's card needs no re-scan
    const share = `${location.origin}/sovereignty?d=${encodeURIComponent(data.domain)}` +
      (web != null ? `&w=${web}` : '') + (mail != null ? `&m=${mail}` : '');
    resultEl.innerHTML =
      `<div class="r-domain">results for <b>${esc(data.domain)}</b>${data.mailDomain && data.mailDomain !== data.domain ? ` · mail on <b>${esc(data.mailDomain)}</b>` : ''}</div>` +
      '<div class="cats">' +
      catHtml('Web', '🌐', data.web, 'no web servers found') +
      catHtml('Mail', '✉️', data.mail, `no mail servers (no MX record for ${data.mailDomain || data.domain})`) +
      '</div>' +
      `<div class="share-row"><button class="share-btn" data-share="${esc(share)}">🔗 Share this result</button><span class="share-hint">a preview card with these scores</span></div>`;
    resultEl.querySelector('.share-btn').onclick = (e) => {
      const btn = e.currentTarget;
      navigator.clipboard.writeText(btn.dataset.share).then(() => {
        btn.textContent = '✓ link copied'; setTimeout(() => { btn.textContent = '🔗 Share this result'; }, 1800);
      }).catch(() => { btn.textContent = btn.dataset.share; });
    };
    // reflect scores in the URL so the current page is itself shareable
    try { history.replaceState(null, '', share.slice(location.origin.length)); } catch { /* ignore */ }
  } catch {
    resultEl.innerHTML = '<div class="r-error">scan failed — network error</div>';
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  document.querySelectorAll('#check-form button, #check-form-2 button').forEach((el) => { el.disabled = b; });
}

// wire both forms + the example links to a single input value
const inputs = [document.getElementById('check-input'), document.getElementById('check-input-2')];
function syncAndCheck(val) {
  inputs.forEach((i) => { if (i) i.value = val; });
  check(val);
}
['check-form', 'check-form-2'].forEach((id) => {
  const f = document.getElementById(id);
  if (f) f.addEventListener('submit', (e) => { e.preventDefault(); syncAndCheck(f.querySelector('input').value); });
});
document.querySelectorAll('.examples a[data-ex]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); syncAndCheck(a.dataset.ex); window.scrollTo({ top: 0, behavior: 'smooth' }); });
});

// deep link: /sovereignty?d=example.com auto-runs
const pre = new URLSearchParams(location.search).get('d');
if (pre) { inputs.forEach((i) => { if (i) i.value = pre; }); check(pre); }
