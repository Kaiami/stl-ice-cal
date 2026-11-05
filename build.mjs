#!/usr/bin/env node
// Build subscribable .ics calendar feeds from icetimestl.com's schedule API.
//
// Produces, into ./public:
//   all.ics            every included session, every rink
//   <rinkId>.ics       one feed per rink
//   index.html         a page of subscribe links (webcal:// + https)
//   feeds.json         machine-readable list of the feeds that were built
//
// Usage:
//   node build.mjs                 # fetch live from icetimestl.com
//   ICE_SCHEDULE_FILE=sched.json node build.mjs   # build from a local JSON file (offline test)
//
// Config via env (all optional):
//   INCLUDE_TYPES   comma list of session types to include
//                   (default: public,freestyle,training,club_ice)
//   SOURCE_URL      schedule API URL (default: https://icetimestl.com/api/schedule)

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RINKS, rinkInfo } from './rinks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'public');

const SOURCE_URL = process.env.SOURCE_URL || 'https://icetimestl.com/api/schedule';
const INCLUDE_TYPES = new Set(
  (process.env.INCLUDE_TYPES || 'public,freestyle,training,club_ice')
    .split(',').map(s => s.trim()).filter(Boolean)
);
const SOURCE_SITE = 'https://icetimestl.com';
const CAL_TZID = 'America/Chicago';
const PRODID = '-//icetimestl-cal//EN';

// ---------------------------------------------------------------------------
// Fetch the schedule (global fetch if available, else node:https, else file).
// ---------------------------------------------------------------------------
async function loadSchedule() {
  if (process.env.ICE_SCHEDULE_FILE) {
    const raw = readFileSync(process.env.ICE_SCHEDULE_FILE, 'utf8');
    return JSON.parse(raw);
  }
  if (typeof fetch === 'function') {
    const res = await fetch(SOURCE_URL, { headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }
  // Fallback for older Node (e.g. local Node 16): use https module.
  const { get } = await import('node:https');
  return new Promise((resolve, reject) => {
    get(SOURCE_URL, { headers: { 'accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`Fetch failed: ${res.statusCode}`)); res.resume(); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// ICS helpers
// ---------------------------------------------------------------------------
// RFC 5545 text escaping for property values.
function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold a content line to <=75 octets per RFC 5545 (continuation lines start with a space).
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    // Avoid splitting a multi-byte UTF-8 sequence: back off to a lead byte.
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines are prefixed with a single space
  }
  return out.join('\r\n ');
}

// Convert an ISO-8601 timestamp that carries an offset (e.g. ...-06:00) to UTC basic format.
function toUtcBasic(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function uidFor(s) {
  const h = createHash('sha1')
    .update([s.rinkId, s.start, s.end, s.type, s.label].join('|'))
    .digest('hex').slice(0, 20);
  return `${h}@icetimestl-cal`;
}

function typeLabel(type) {
  return { public: 'Public', freestyle: 'Freestyle', training: 'Training', club_ice: 'Club Ice' }[type] || type;
}

function buildCalendar({ calName, sessions, includeRinkInSummary, dtstamp }) {
  const lines = [];
  const push = (k, v) => lines.push(fold(`${k}:${v}`));
  lines.push('BEGIN:VCALENDAR');
  push('VERSION', '2.0');
  push('PRODID', PRODID);
  push('CALSCALE', 'GREGORIAN');
  push('METHOD', 'PUBLISH');
  push('NAME', esc(calName));
  push('X-WR-CALNAME', esc(calName));
  push('X-WR-TIMEZONE', CAL_TZID);
  // Hint to clients how often to re-poll (clients ultimately decide).
  push('REFRESH-INTERVAL;VALUE=DURATION', 'PT12H');
  push('X-PUBLISHED-TTL', 'PT12H');

  for (const s of sessions) {
    const info = rinkInfo(s.rinkId);
    const summary = includeRinkInSummary ? `${s.label} — ${info.short}` : s.label;
    const descParts = [];
    if (s.type === 'club_ice') descParts.push('Members only (figure-skating club ice).');
    if (s.notes) descParts.push(String(s.notes));
    descParts.push(`Rink: ${info.name}`);
    descParts.push(`Updated nightly from ${SOURCE_SITE}`);

    lines.push('BEGIN:VEVENT');
    push('UID', uidFor(s));
    push('DTSTAMP', dtstamp);
    push('DTSTART', toUtcBasic(s.start));
    push('DTEND', toUtcBasic(s.end));
    push('SUMMARY', esc(summary));
    push('LOCATION', esc(info.name));
    push('DESCRIPTION', esc(descParts.join('\n')));
    // Each category value is escaped individually; commas between them are separators, not text.
    push('CATEGORIES', [typeLabel(s.type), info.short].map(esc).join(','));
    push('URL', SOURCE_SITE);
    if (s.themed) push('X-ICE-THEMED', 'TRUE');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// index.html (subscribe page). webcal:// links are built client-side from the
// page's own origin+path so this works under any GitHub user / repo name.
// ---------------------------------------------------------------------------
function buildIndexHtml(feeds, meta) {
  const TYPE_META = {
    public:    { label: 'Public',    color: '#2563eb' },
    freestyle: { label: 'Freestyle', color: '#7c3aed' },
    training:  { label: 'Training',  color: '#d9770a' },
    club_ice:  { label: 'Club ice',  color: '#db2777' },
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtYmd = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
  const windowPretty = (meta.window && meta.window.includes('→'))
    ? meta.window.split('→').map(s => fmtYmd(s.trim())).join(' – ') : escapeHtml(meta.window);
  const u = new Date(meta.generatedAt);
  const updatedPretty = isNaN(u) ? escapeHtml(meta.generatedAt)
    : `${MONTHS[u.getMonth()]} ${u.getDate()}, ${u.getFullYear()}`;

  const chips = (types) => Object.entries(types || {})
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => {
      const m = TYPE_META[t] || { label: t, color: '#64748b' };
      return `<span class="chip"><i style="--c:${m.color}"></i>${escapeHtml(m.label)} ${n}</span>`;
    }).join('');

  const card = (f, featured) => `
      <article class="card${featured ? ' featured' : ''}${f.club ? ' club' : ''}" data-file="${escapeHtml(f.file)}">
        <div class="card-top">
          <h3>${escapeHtml(f.name)}${f.club ? '<span class="badge">members only</span>' : ''}</h3>
          <span class="count"><strong>${f.count}</strong> events</span>
        </div>
        <div class="chips">${chips(f.types)}</div>
        <div class="actions">
          <a class="btn sub" href="#"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v3M17 2v3M3.5 8.5h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5V19A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5Z"/><path d="M12 11.5v5M9.5 14h5"/></svg>Subscribe</a>
          <a class="btn ghost copy" href="#">Copy link</a>
          <a class="btn ghost raw" href="${escapeHtml(f.file)}">.ics</a>
        </div>
      </article>`;

  const all = feeds.find(f => f.file === 'all.ics');
  const publicRinks = feeds.filter(f => f.file !== 'all.ics' && !f.club);
  const clubRinks = feeds.filter(f => f.club);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STL Ice Times — subscribable calendars</title>
<meta name="description" content="Subscribable calendars for St. Louis skating times — public skate, freestyle, training and club ice, one feed per rink.">
<style>
  :root {
    color-scheme: light dark;
    --bg1:#eaf2fb; --bg2:#dde9f6; --bg3:#d2e4f3;
    --ink:#122536; --muted:#4f677d; --faint:#7b93a8;
    --card:rgba(255,255,255,.72); --card-border:rgba(255,255,255,.75); --card-shadow:0 10px 30px -14px rgba(18,42,70,.45);
    --line:rgba(18,42,70,.12);
    --accent1:#0ea5b7; --accent2:#2a79e0; --accent-ink:#fff;
    --chip-bg:rgba(18,42,70,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg1:#0a1826; --bg2:#0c2033; --bg3:#091422;
      --ink:#e8f0f8; --muted:#9fb4c8; --faint:#6f8aa2;
      --card:rgba(255,255,255,.055); --card-border:rgba(255,255,255,.10); --card-shadow:0 14px 34px -18px rgba(0,0,0,.7);
      --line:rgba(255,255,255,.10);
      --accent1:#22c3d6; --accent2:#4c90f0; --accent-ink:#06121d;
      --chip-bg:rgba(255,255,255,.07);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0; color: var(--ink); min-height: 100vh;
    background:
      radial-gradient(1200px 600px at 85% -10%, rgba(42,121,224,.18), transparent 60%),
      radial-gradient(900px 500px at 5% 0%, rgba(14,165,183,.16), transparent 55%),
      linear-gradient(165deg, var(--bg1), var(--bg2) 45%, var(--bg3));
    background-attachment: fixed;
  }
  main { max-width: 860px; margin: 0 auto; padding: clamp(1.5rem, 4vw, 3rem) 1.1rem 3rem; }

  header.hero { margin-bottom: 1.8rem; }
  .mark { display:inline-flex; align-items:center; justify-content:center; width:46px; height:46px; border-radius:14px;
          background: linear-gradient(140deg, var(--accent1), var(--accent2)); color: var(--accent-ink);
          box-shadow: var(--card-shadow); margin-bottom: .9rem; }
  .mark svg { width: 26px; height: 26px; }
  h1 { font-size: clamp(1.65rem, 4.5vw, 2.3rem); line-height:1.1; margin: 0 0 .5rem; letter-spacing: -.02em; }
  .lede { margin: 0; color: var(--muted); max-width: 54ch; font-size: 1.02rem; }
  .lede a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .meta { display:flex; flex-wrap:wrap; gap:.5rem; margin-top: 1.1rem; }
  .pill { display:inline-flex; align-items:center; gap:.4rem; font-size:.82rem; font-weight:600; color:var(--muted);
          background: var(--card); border:1px solid var(--card-border); border-radius:999px; padding:.3rem .7rem;
          backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }

  .section-label { font-size:.78rem; text-transform:uppercase; letter-spacing:.09em; color:var(--faint);
                   font-weight:700; margin: 2rem 0 .8rem; }

  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)); gap: .9rem; }

  .card {
    background: var(--card); border:1px solid var(--card-border); border-radius:16px;
    padding: 1.05rem 1.1rem 1.1rem; box-shadow: var(--card-shadow);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    display:flex; flex-direction:column; gap:.75rem; transition: transform .15s ease, box-shadow .15s ease;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 18px 40px -16px rgba(18,42,70,.5); }
  .card.featured { background: linear-gradient(135deg, var(--accent1), var(--accent2)); color: var(--accent-ink); border-color: transparent; }
  .card.featured .count, .card.featured h3 { color: var(--accent-ink); }
  .card.club { opacity: .96; }
  .card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:.6rem; }
  .card h3 { margin:0; font-size:1.08rem; letter-spacing:-.01em; line-height:1.2; }
  .badge { display:inline-block; margin-left:.5rem; font-size:.6rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em;
           color:var(--muted); background:var(--chip-bg); border-radius:999px; padding:.12rem .5rem; vertical-align:middle; }
  .count { font-size:.86rem; color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .count strong { font-size:1rem; color:var(--ink); }
  .card.featured .count strong { color: var(--accent-ink); }

  .chips { display:flex; flex-wrap:wrap; gap:.35rem; min-height: .5rem; }
  .chip { display:inline-flex; align-items:center; gap:.35rem; font-size:.74rem; font-weight:600; color:var(--muted);
          background:var(--chip-bg); border-radius:999px; padding:.18rem .55rem; }
  .chip i { width:.56rem; height:.56rem; border-radius:50%; background:var(--c); flex:none; }
  .card.featured .chip { background: rgba(255,255,255,.2); color: var(--accent-ink); }

  .actions { display:flex; flex-wrap:wrap; align-items:center; gap:.45rem; margin-top:auto; }
  .btn { display:inline-flex; align-items:center; gap:.4rem; font-size:.86rem; font-weight:650; text-decoration:none;
         border-radius:10px; padding:.5rem .8rem; cursor:pointer; transition: background .15s ease, border-color .15s ease; }
  .btn svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .btn.sub { background: linear-gradient(135deg, var(--accent1), var(--accent2)); color:var(--accent-ink);
             box-shadow: 0 6px 16px -8px rgba(42,121,224,.7); }
  .btn.sub:hover { filter: brightness(1.06); }
  .btn.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); padding:.5rem .7rem; }
  .btn.ghost:hover { border-color:var(--muted); color:var(--ink); }
  .card.featured .btn.sub { background: var(--accent-ink); color: var(--accent2); }
  .card.featured .btn.ghost { color: var(--accent-ink); border-color: rgba(255,255,255,.5); }
  .card.featured .btn.ghost:hover { border-color: var(--accent-ink); }

  .info { margin-top: 2.2rem; background: var(--card); border:1px solid var(--card-border); border-radius:16px;
          padding: 1.2rem 1.3rem; box-shadow: var(--card-shadow); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .info h2 { margin:0 0 .7rem; font-size:1.05rem; }
  .info ul { margin:0; padding-left:1.1rem; color:var(--muted); }
  .info li { margin:.35rem 0; }
  .info li strong { color:var(--ink); }
  .info code { background:var(--chip-bg); padding:.1em .4em; border-radius:.35em; font-size:.9em; }
  .info .note { margin:.85rem 0 0; font-size:.9rem; color:var(--muted); }

  footer { margin-top:2rem; font-size:.82rem; color:var(--faint); text-align:center; }
  footer a { color:inherit; }

  .toast { position:fixed; bottom:1.2rem; left:50%; transform:translateX(-50%) translateY(10px);
           background:var(--ink); color:var(--bg1); padding:.55rem 1rem; border-radius:10px; font-size:.86rem; font-weight:600;
           opacity:0; transition:opacity .2s ease, transform .2s ease; pointer-events:none; box-shadow:var(--card-shadow); }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
</style>
</head>
<body>
<main>
  <header class="hero">
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2v20M2 12h20M4.8 4.8l14.4 14.4M19.2 4.8 4.8 19.2"/>
        <path d="M12 2l1.8 1.8M12 2 10.2 3.8M12 22l1.8-1.8M12 22l-1.8-1.8M2 12l1.8 1.8M2 12l1.8-1.8M22 12l-1.8 1.8M22 12l-1.8-1.8"/>
      </svg>
    </span>
    <h1>St. Louis Ice Times</h1>
    <p class="lede">Subscribable calendars for skating across St. Louis — pick a rink, hit
      <strong>Subscribe</strong>, and your calendar keeps itself up to date. Rebuilt from
      <a href="${SOURCE_SITE}">icetimestl.com</a>.</p>
    <div class="meta">
      <span class="pill">⛸️ ${meta.total} sessions</span>
      <span class="pill">📅 ${escapeHtml(windowPretty)}</span>
      <span class="pill">↻ Updated ${escapeHtml(updatedPretty)}</span>
    </div>
  </header>

  <div class="grid" style="margin-top:.5rem">
    ${all ? card(all, true) : ''}
  </div>

  <p class="section-label">Rinks</p>
  <div class="grid">
    ${publicRinks.map(f => card(f, false)).join('')}
  </div>

  ${clubRinks.length ? `
  <p class="section-label">Members-only club ice</p>
  <div class="grid">
    ${clubRinks.map(f => card(f, false)).join('')}
  </div>` : ''}

  <section class="info">
    <h2>How to subscribe</h2>
    <ul>
      <li><strong>Apple Calendar / iPhone:</strong> tap <em>Subscribe</em> (opens via <code>webcal://</code>), or paste the link into Calendar → File → New Calendar Subscription.</li>
      <li><strong>Google Calendar:</strong> <em>Copy link</em>, then Other calendars → <em>From URL</em>. Google refreshes subscribed URLs on its own schedule — often several hours to a day.</li>
      <li><strong>Outlook:</strong> Add calendar → Subscribe from web → paste the link.</li>
    </ul>
    <p class="note">Each rink is its own calendar, so you can toggle and color them independently. Times are U.S. Central and adjust for daylight saving automatically.</p>
  </section>

  <footer>
    ${meta.total} sessions · ${escapeHtml(windowPretty)} · updated ${escapeHtml(updatedPretty)}<br>
    Unofficial — always verify times with the rink. Source: <a href="${SOURCE_SITE}">icetimestl.com</a>.
  </footer>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
  (function () {
    var base = location.href.replace(/[^/]*$/, ''); // directory this page lives in
    var webcalBase = base.replace(/^https?:/, 'webcal:');
    var toastEl = document.getElementById('toast'), toastT;
    function toast(msg) {
      toastEl.textContent = msg; toastEl.classList.add('show');
      clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 1600);
    }
    document.querySelectorAll('.card').forEach(function (card) {
      var file = card.getAttribute('data-file');
      var httpsUrl = base + file, webcalUrl = webcalBase + file;
      card.querySelector('a.sub').setAttribute('href', webcalUrl);
      card.querySelector('a.raw').setAttribute('href', httpsUrl);
      card.querySelector('a.copy').addEventListener('click', function (e) {
        e.preventDefault();
        (navigator.clipboard ? navigator.clipboard.writeText(httpsUrl) : Promise.reject()).then(
          function () { toast('Link copied'); },
          function () { window.prompt('Copy this subscribe link:', httpsUrl); }
        );
      });
    });
  })();
</script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const data = await loadSchedule();
  const all = Array.isArray(data.sessions) ? data.sessions : [];

  // Apply club foldInto, then filter by included types.
  const routed = all.map(s => {
    const info = RINKS[s.rinkId];
    if (info && info.foldInto) return { ...s, rinkId: info.foldInto };
    return s;
  });
  const sessions = routed
    .filter(s => INCLUDE_TYPES.has(s.type))
    .sort((a, b) => a.start.localeCompare(b.start));

  const dtstamp = toUtcBasic(data.generatedAt || new Date().toISOString());
  const starts = sessions.map(s => s.start).sort();
  const ends = sessions.map(s => s.end).sort();
  const windowStr = starts.length
    ? `${starts[0].slice(0, 10)} → ${ends[ends.length - 1].slice(0, 10)}`
    : 'n/a';

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // Per-rink feeds (only for rinks that actually have included sessions).
  const byRink = new Map();
  for (const s of sessions) {
    if (!byRink.has(s.rinkId)) byRink.set(s.rinkId, []);
    byRink.get(s.rinkId).push(s);
  }

  const feeds = [];
  const tally = (list) => list.reduce((m, s) => { m[s.type] = (m[s.type] || 0) + 1; return m; }, {});

  // "All rinks" first.
  await writeFile(path.join(OUT_DIR, 'all.ics'),
    buildCalendar({ calName: 'STL Ice — All Rinks', sessions, includeRinkInSummary: true, dtstamp }));
  feeds.push({ file: 'all.ics', name: 'All rinks', short: 'All', count: sessions.length, club: false, types: tally(sessions) });

  // Per-rink, ordered: public rinks first (by name), then club ice.
  const rinkIds = [...byRink.keys()].sort((a, b) => {
    const ia = rinkInfo(a), ib = rinkInfo(b);
    const ca = ia.club ? 1 : 0, cb = ib.club ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return ia.name.localeCompare(ib.name);
  });

  for (const rinkId of rinkIds) {
    const list = byRink.get(rinkId);
    const info = rinkInfo(rinkId);
    const file = `${rinkId}.ics`;
    await writeFile(path.join(OUT_DIR, file),
      buildCalendar({ calName: `STL Ice — ${info.name}`, sessions: list, includeRinkInSummary: false, dtstamp }));
    feeds.push({ file, name: info.name, short: info.short, count: list.length, club: !!info.club, types: tally(list) });
  }

  const meta = { generatedAt: new Date().toISOString(), total: sessions.length, window: windowStr };
  await writeFile(path.join(OUT_DIR, 'index.html'), buildIndexHtml(feeds, meta));
  await writeFile(path.join(OUT_DIR, 'feeds.json'), JSON.stringify({ meta, feeds }, null, 2) + '\n');

  // Console summary.
  console.log(`Built ${feeds.length} feeds into ${path.relative(process.cwd(), OUT_DIR)}/`);
  console.log(`  types included: ${[...INCLUDE_TYPES].join(', ')}`);
  console.log(`  window: ${windowStr}  (${sessions.length} sessions)`);
  for (const f of feeds) console.log(`  ${f.file.padEnd(18)} ${String(f.count).padStart(4)}  ${f.name}`);
}

main().catch(err => { console.error(err); process.exit(1); });
