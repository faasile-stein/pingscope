'use strict';
// Standalone European-sovereignty checker. Calls the shared /api/sovereignty
// endpoint and renders the web + mail scores. (The live-streaming version with
// per-hop discovery lives in the main app.)

const ccFlag = (cc) => (!cc || cc.length !== 2) ? '🌐'
  : cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
// sovereign green (#35e0a1, score 100) → non-sovereign red (#ff6272, score 0)
const sovColor = (s) => {
  if (s == null) return 'var(--muted)';
  const p = (100 - s) / 100;
  const ch = [53 + (255 - 53) * p, 224 + (98 - 224) * p, 161 + (114 - 161) * p];
  return `rgb(${ch.map(Math.round).join(',')})`;
};
const sovLabel = (s) => (s == null ? 'no data' : s >= 80 ? 'sovereign' : s >= 50 ? 'partial' : 'non-sovereign');
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

const resultEl = document.getElementById('result');

// tiny DOM builder: text goes in as text nodes, so nothing is ever parsed as HTML
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'color') el.style.color = v;
    else if (k === 'borderColor') el.style.borderColor = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((c) => c != null && c !== false));
  return el;
};

function serverEl(sv) {
  const ownerFlag = sv.ownerCc ? ccFlag(sv.ownerCc) : '';
  const half = sv.eu && !sv.euOwned;
  const asTitle = sv.euOwned ? '' : `owned by ${sv.ownerParent || sv.asName || 'a non-sovereign company'} (${sv.ownerCc || '?'}) — outside the sovereign area, hosting score halved`;
  return h('div', { class: 'srv' },
    h('div', { class: 'srv-top' }, h('span', null, ccFlag(sv.cc)), h('span', { class: 'srv-ip' }, sv.exchange || sv.ip)),
    h('div', { class: 'srv-sub' },
      h('span', { class: 'srv-geo' }, [sv.city, sv.country].filter(Boolean).join(', ') || 'location unknown'),
      h('span', { class: `srv-as ${sv.euOwned ? 'ok' : 'bad'}`, title: asTitle || null },
        `${ownerFlag} ${sv.asName || sv.as || ''}`, half ? [' ', h('b', { class: 'half' }, '½')] : null)));
}

function catEl(title, icon, cat, emptyMsg) {
  if (!cat || (cat.score == null && (!cat.servers || !cat.servers.length))) {
    return h('div', { class: 'cat' }, h('div', { class: 'cat-h' }, `${icon} ${title}`), h('div', { class: 'cat-empty' }, emptyMsg));
  }
  const color = sovColor(cat.score);
  const servers = (cat.servers || []).map(serverEl);
  const transit = cat.transit
    ? ['route ', h('b', null, `${cat.transit.hopsNonEuPct}%`), ' hops · ', h('b', null, `${cat.transit.netsNonEuPct}%`), ' networks non-sovereign']
    : h('span', { class: 'dim' }, 'route not measured (target blocks traceroute)');
  // "visualize" opens the live MTR on a map (geographic view) in the main app
  const primaryIp = (cat.servers && cat.servers[0] && cat.servers[0].ip) || '';
  const viz = primaryIp ? h('a', { class: 'viz-pill', href: `/?mtr=${encodeURIComponent(primaryIp)}&view=geo`, target: '_blank', rel: 'noopener', title: 'trace this route on a world map' }, '▸ visualize') : null;
  return h('div', { class: 'cat' },
    h('div', { class: 'cat-h' }, `${icon} ${title}`, viz),
    h('div', { class: 'score', color }, cat.score == null ? '—' : String(cat.score), h('small', null, '/100')),
    h('div', { class: 'badge', color, borderColor: color }, sovLabel(cat.score)),
    h('div', { class: 'srvs' }, servers.length ? servers : h('div', { class: 'cat-empty' }, 'no servers resolved')),
    h('div', { class: 'transit' }, transit));
}

// domains only — reject bare IPs / single-label / malformed hosts before the round-trip
function looksLikeDomain(q) {
  let s = String(q || '').trim();
  try { s = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? new URL(s).hostname : s.split(/[/?#]/)[0]; } catch { return false; }
  s = s.replace(/:\d+$/, '').toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':')) return false; // IPv4 / IPv6
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9]{2,59})$/.test(s);
}

async function check(input, fresh) {
  const q = (input || '').trim();
  if (!q) return;
  if (!looksLikeDomain(q)) {
    resultEl.replaceChildren(h('div', { class: 'r-error' }, 'Enter a domain, e.g. ', h('b', null, 'example.com'), ' — not an IP address.'));
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  resultEl.replaceChildren(h('div', { class: 'r-loading' }, `${fresh ? 're-tracing' : 'tracing'} web + mail routes… this can take a few seconds`));
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setBusy(true);
  try {
    const res = await fetch('/api/sovereignty?url=' + encodeURIComponent(q) + (fresh ? '&fresh=1' : ''));
    const data = await res.json();
    if (!res.ok) { resultEl.replaceChildren(h('div', { class: 'r-error' }, data.error || 'scan failed')); return; }
    const web = data.web && data.web.score, mail = data.mail && data.mail.score;
    // shareable link carries the scores so the crawler's card needs no re-scan
    const share = `${location.origin}/sovereignty?d=${encodeURIComponent(data.domain)}` +
      (web != null ? `&w=${web}` : '') + (mail != null ? `&m=${mail}` : '');
    const note = data.cached
      ? `cached · scored ${ago(data.at)}${data.rateLimited ? ' · rate-limited, showing last result' : ''}`
      : 'freshly scored · a preview card with these scores';
    const shareBtn = h('button', { class: 'share-btn' }, '🔗 Share this result');
    const retestBtn = h('button', { class: 'retest-btn' }, '↻ Retest');
    resultEl.replaceChildren(
      h('div', { class: 'r-domain' }, 'results for ', h('b', null, data.domain),
        data.mailDomain && data.mailDomain !== data.domain ? [' · mail on ', h('b', null, data.mailDomain)] : null),
      h('div', { class: 'cats' },
        catEl('Web', '🌐', data.web, 'no web servers found'),
        catEl('Mail', '✉️', data.mail, `no mail servers (no MX record for ${data.mailDomain || data.domain})`)),
      h('div', { class: 'share-row' }, shareBtn, retestBtn, h('span', { class: 'share-hint' }, note)));
    shareBtn.dataset.share = share;
    retestBtn.dataset.domain = data.domain;
    shareBtn.onclick = (e) => {
      const btn = e.currentTarget;
      navigator.clipboard.writeText(btn.dataset.share).then(() => {
        btn.textContent = '✓ link copied'; setTimeout(() => { btn.textContent = '🔗 Share this result'; }, 1800);
      }).catch(() => { btn.textContent = btn.dataset.share; });
    };
    retestBtn.onclick = (e) => check(e.currentTarget.dataset.domain, true);
    // reflect scores in the URL so the current page is itself shareable
    try { history.replaceState(null, '', share.slice(location.origin.length)); } catch { /* ignore */ }
  } catch {
    resultEl.replaceChildren(h('div', { class: 'r-error' }, 'scan failed — network error'));
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
