// Picks sync and calendar feed for the LPC schedule board (Cloudflare Worker + D1).
//
// Each registered user has two random keys:
//   id    private: whoever has it can read and change that user's picks; devices are joined with it
//   feed  read-only: the only key in the calendar URL, so handing out the calendar does not let anyone edit
//
//   POST   /api/users               {picks: [...]}             -> {id, feed, picks}   register a user
//   GET    /api/users/<id>/picks                                -> {feed, picks}
//   POST   /api/users/<id>/picks    {add: [...], remove: [...]} -> {feed, picks}       star and unstar
//   DELETE /api/users/<id>                                      -> 204                 forget the user
//   GET    /cal/<feed>.ics          the picks as a calendar, for calendar apps to subscribe to
//
// Setup, once, from this directory:
//   npm install
//   npx wrangler login
//   npx wrangler d1 create lpc-scheduler-picks      # put the database_id it prints into wrangler.jsonc
//   npx wrangler d1 execute lpc-scheduler-picks --remote --file=schema.sql
//   npx wrangler deploy                             # prints the Worker URL; set SYNC_URL in ../index.html to it
// Local run:
//   npx wrangler d1 execute lpc-scheduler-picks --local --file=schema.sql && npx wrangler dev

const KEY = /^[A-Za-z0-9_-]{22}$/;
const SESSION = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_PICKS = 600;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const fail = (status, error) => json({ error }, status);

// 16 random bytes as 22 URL-safe characters.
function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 20000) return null;
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// A list of session ids from a request body, without duplicates; null when it is not one.
function idList(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_PICKS || !v.every(x => typeof x === 'string' && SESSION.test(x))) return null;
  return [...new Set(v)];
}

async function picksOf(db, id) {
  const { results } = await db.prepare('SELECT session_id FROM picks WHERE user_id = ? ORDER BY added_at, session_id').bind(id).all();
  return results.map(r => r.session_id);
}

// The ids travel as one JSON parameter, so a request is a fixed handful of statements however many picks it carries.
const addPicks = (db, id, ids, now) =>
  db.prepare('INSERT OR IGNORE INTO picks (user_id, session_id, added_at) SELECT ?1, value, ?2 FROM json_each(?3)').bind(id, now, JSON.stringify(ids));

async function register(request, env) {
  const body = await readJson(request), picks = body && idList(body.picks);
  if (!picks) return fail(400, 'expected {"picks": [session ids]}');
  const id = newKey(), feed = newKey(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, feed, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, feed, now, now),
    addPicks(env.DB, id, picks, now),
  ]);
  return json({ id, feed, picks: await picksOf(env.DB, id) }, 201);
}

async function picks(request, env, id) {
  const user = await env.DB.prepare('SELECT feed FROM users WHERE id = ?').bind(id).first();
  if (!user) return fail(404, 'unknown user');
  if (request.method === 'POST') {
    const body = await readJson(request), add = body && idList(body.add), remove = body && idList(body.remove);
    if (!add || !remove) return fail(400, 'expected {"add": [session ids], "remove": [session ids]}');
    const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM picks WHERE user_id = ?').bind(id).first();
    if (have.n + add.length > MAX_PICKS) return fail(400, 'too many picks');
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM picks WHERE user_id = ?1 AND session_id IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(remove)),
      addPicks(env.DB, id, add, now),
      env.DB.prepare('UPDATE users SET updated_at = ? WHERE id = ?').bind(now, id),
    ]);
  }
  return json({ feed: user.feed, picks: await picksOf(env.DB, id) });
}

async function forget(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM picks WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return new Response(null, { status: 204, headers: CORS });
}

// The schedule page embeds its data as "const SESSIONS = [" followed by one JSON object per line
// (rebuild.py writes it that way). Only the picked lines are parsed.
export function pickedSessions(html, picked) {
  const start = html.indexOf('const SESSIONS = ['), end = html.indexOf('\n];', start);
  if (start === -1 || end === -1) throw new Error('no SESSIONS block in the schedule page');
  const out = [];
  for (const line of html.slice(start, end).split('\n')) {
    const hit = /^\{"id": "([^"]+)"/.exec(line);
    if (hit && picked.has(hit[1])) out.push(JSON.parse(line.replace(/,$/, '')));
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

const text = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Calendar lines may be at most 75 bytes; longer ones continue on lines that start with a space.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const decoder = new TextDecoder();
  let out = '';
  for (let i = 0, room = 75; i < bytes.length; room = 74) {
    let j = Math.min(i + room, bytes.length);
    while (j < bytes.length && (bytes[j] & 0xc0) === 0x80) j--;  // do not split a UTF-8 character
    out += (i ? '\r\n ' : '') + decoder.decode(bytes.subarray(i, j));
    i = j;
  }
  return out;
}

export function ics(sessions, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const local = (date, time) => date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lpc-scheduler//LPC 2026 picks//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:LPC 2026 picks', 'X-WR-TIMEZONE:Europe/Prague',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',  // a hint; calendar apps refresh when they choose
    'BEGIN:VTIMEZONE', 'TZID:Europe/Prague',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const s of sessions) {
    const about = [s.track, (s.speakers || []).join(', '), s.url].filter(Boolean).join(' · ');
    lines.push(
      'BEGIN:VEVENT', 'UID:lpc2026-' + s.id + '@lpc.events', 'DTSTAMP:' + stamp,
      'DTSTART;TZID=Europe/Prague:' + local(s.date, s.start), 'DTEND;TZID=Europe/Prague:' + local(s.date, s.end),
      'SUMMARY:' + text(s.title),
      'LOCATION:' + text((s.room === 'TBD' ? 'TBA' : s.room) + ', Prague Congress Centre'),
      'DESCRIPTION:' + text(about + (s.abstract ? '\n\n' + s.abstract : '')),
    );
    if (s.url) lines.push('URL:' + s.url);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

async function calendar(env, feed) {
  const user = await env.DB.prepare('SELECT id FROM users WHERE feed = ?').bind(feed).first();
  if (!user) return new Response('No such calendar.\n', { status: 404 });
  const picked = new Set(await picksOf(env.DB, user.id));
  let sessions;
  try {
    const page = await fetch(env.SCHEDULE_URL, { cf: { cacheEverything: true, cacheTtl: 300 } });
    if (!page.ok) throw new Error('schedule page answered ' + page.status);
    sessions = pickedSessions(await page.text(), picked);
  } catch (e) {
    console.error(e);
    return new Response('The schedule is not reachable right now.\n', { status: 502 });  // calendar apps keep what they have
  }
  return new Response(ics(sessions), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300' } });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url), method = request.method;
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      let hit;
      if (pathname === '/api/users' && method === 'POST') return await register(request, env);
      if ((hit = /^\/api\/users\/([^/]+)\/picks$/.exec(pathname)) && (method === 'GET' || method === 'POST'))
        return KEY.test(hit[1]) ? await picks(request, env, hit[1]) : fail(404, 'unknown user');
      if ((hit = /^\/api\/users\/([^/]+)$/.exec(pathname)) && method === 'DELETE')
        return KEY.test(hit[1]) ? await forget(env, hit[1]) : fail(404, 'unknown user');
      if ((hit = /^\/cal\/([^/]+)\.ics$/.exec(pathname)) && (method === 'GET' || method === 'HEAD'))
        return KEY.test(hit[1]) ? await calendar(env, hit[1]) : new Response('No such calendar.\n', { status: 404 });
      return fail(404, 'not found');
    } catch (e) {
      console.error(e);
      return fail(500, 'server error');
    }
  },
};
