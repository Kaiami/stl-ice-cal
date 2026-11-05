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
  const rows = feeds.map(f => `
      <tr${f.club ? ' class="club"' : ''}>
        <td class="name">${escapeHtml(f.name)}${f.club ? ' <span class="badge">members</span>' : ''}</td>
        <td class="count">${f.count}</td>
        <td class="links" data-file="${escapeHtml(f.file)}">
          <a class="sub" href="#">Subscribe</a>
          <a class="copy" href="#">Copy link</a>
          <a class="raw" href="${escapeHtml(f.file)}">.ics</a>
        </td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STL Ice Times — subscribable calendars</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 2rem 1rem; background: Canvas; color: CanvasText; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  p.sub { margin-top: 0; opacity: .8; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
  th, td { text-align: left; padding: .6rem .5rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  td.count { text-align: right; font-variant-numeric: tabular-nums; opacity: .7; width: 4rem; }
  td.links { white-space: nowrap; text-align: right; }
  td.links a { margin-left: .75rem; text-decoration: none; font-weight: 600; }
  td.links a.sub { color: #0a7; }
  td.links a.raw, td.links a.copy { opacity: .6; font-weight: 500; }
  tr.club .name { opacity: .85; }
  .badge { font-size: .65rem; text-transform: uppercase; letter-spacing: .05em;
           border: 1px solid currentColor; border-radius: 1em; padding: 0 .5em; opacity: .6; vertical-align: middle; }
  .how { margin-top: 2rem; font-size: .9rem; opacity: .85; }
  .how code { background: color-mix(in srgb, CanvasText 10%, transparent); padding: .1em .35em; border-radius: .3em; }
  footer { margin-top: 2rem; font-size: .8rem; opacity: .6; }
  .toast { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
           background: CanvasText; color: Canvas; padding: .5rem 1rem; border-radius: .5rem;
           opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<main>
  <h1>St. Louis Ice Times — subscribable calendars</h1>
  <p class="sub">Public skating, freestyle, training, and club ice across St. Louis rinks.
     Pick a rink, hit <strong>Subscribe</strong>, and your calendar app keeps it up to date automatically.
     Rebuilt nightly from <a href="${SOURCE_SITE}">icetimestl.com</a>.</p>

  <table>
    <thead><tr><th>Calendar</th><th class="count">Events</th><th></th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>

  <div class="how">
    <p><strong>How to subscribe</strong></p>
    <ul>
      <li><strong>Apple Calendar / iPhone:</strong> tap <em>Subscribe</em> (opens via <code>webcal://</code>), or paste the link in Calendar → File → New Calendar Subscription.</li>
      <li><strong>Google Calendar:</strong> <em>Copy link</em>, then Google Calendar → Other calendars → <em>From URL</em>. (Google refreshes subscribed URLs on its own schedule — often every several to 24 hours.)</li>
      <li><strong>Outlook:</strong> Add calendar → Subscribe from web → paste the link.</li>
    </ul>
    <p>Each rink is a separate calendar, so you can toggle and color them independently. Times are U.S. Central (handles DST automatically).</p>
  </div>

  <footer>
    Updated ${escapeHtml(meta.generatedAt)} · ${meta.total} sessions · source window ${escapeHtml(meta.window)}.
    Unofficial; verify times with the rink before you go.
  </footer>
</main>
<div class="toast" id="toast"></div>
<script>
  (function () {
    var base = location.href.replace(/[^/]*$/, ''); // directory of this page
    var webcalBase = base.replace(/^https?:/, 'webcal:');
    function toast(msg) {
      var t = document.getElementById('toast');
      t.textContent = msg; t.classList.add('show');
      setTimeout(function () { t.classList.remove('show'); }, 1600);
    }
    document.querySelectorAll('td.links').forEach(function (td) {
      var file = td.getAttribute('data-file');
      var httpsUrl = base + file;
      var webcalUrl = webcalBase + file;
      td.querySelector('a.sub').setAttribute('href', webcalUrl);
      td.querySelector('a.raw').setAttribute('href', httpsUrl);
      td.querySelector('a.copy').addEventListener('click', function (e) {
        e.preventDefault();
        navigator.clipboard.writeText(httpsUrl).then(
          function () { toast('Link copied'); },
          function () { prompt('Copy this subscribe link:', httpsUrl); }
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

  // "All rinks" first.
  await writeFile(path.join(OUT_DIR, 'all.ics'),
    buildCalendar({ calName: 'STL Ice — All Rinks', sessions, includeRinkInSummary: true, dtstamp }));
  feeds.push({ file: 'all.ics', name: 'All rinks', short: 'All', count: sessions.length, club: false });

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
    feeds.push({ file, name: info.name, short: info.short, count: list.length, club: !!info.club });
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
