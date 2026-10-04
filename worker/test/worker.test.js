// Runs the Worker in Node against an in-memory SQLite database standing in for D1:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { ics, pickedSessions } from '../src/index.js';

const here = new URL('.', import.meta.url);
const schema = readFileSync(new URL('../schema.sql', here), 'utf8');
const page = readFileSync(new URL('../../index.html', here), 'utf8');
const SCHEDULE_URL = 'https://schedule.test/';

// The part of the D1 API the Worker uses.
class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
}
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;' + schema);
  return {
    prepare: sql => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try { for (const s of statements) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    count: table => db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n,
  };
}

function setup({ scheduleStatus = 200 } = {}) {
  const env = { DB: fakeD1(), SCHEDULE_URL };
  globalThis.fetch = async url => {
    assert.equal(String(url), SCHEDULE_URL);
    return new Response(scheduleStatus === 200 ? page : 'nope', { status: scheduleStatus });
  };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request('https://picks.test' + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }), env);
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { env, call };
}

test('register stores the picks and hands out two different keys', async () => {
  const { env, call } = setup();
  const r = await call('POST', '/api/users', { picks: ['2439', '2602a', '2439'] });
  assert.equal(r.status, 201);
  assert.match(r.body.id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(r.body.feed, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(r.body.id, r.body.feed);
  assert.deepEqual(r.body.picks.sort(), ['2439', '2602a']);
  assert.equal(env.DB.count('users'), 1);
  assert.equal(env.DB.count('picks'), 2);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  const other = await call('POST', '/api/users', {});
  assert.notEqual(other.body.id, r.body.id);
  assert.deepEqual(other.body.picks, []);
});

test('bad input is refused', async () => {
  const { env, call } = setup();
  for (const body of [{ picks: 'x' }, { picks: [1] }, { picks: ['has space'] }, { picks: ['x'.repeat(41)] }, []]) {
    assert.equal((await call('POST', '/api/users', body)).status, 400);
  }
  assert.equal(env.DB.count('users'), 0);
  const { body: user } = await call('POST', '/api/users', { picks: [] });
  assert.equal((await call('POST', `/api/users/${user.id}/picks`, { add: ['ok'], remove: 'no' })).status, 400);
  assert.equal((await call('POST', `/api/users/${user.id}/picks`, { add: Array.from({ length: 601 }, (_, i) => 's' + i) })).status, 400);
  assert.equal((await call('POST', `/api/users/${user.id}/picks`, { add: Array.from({ length: 400 }, (_, i) => 'a' + i) })).status, 200);
  assert.equal((await call('POST', `/api/users/${user.id}/picks`, { add: Array.from({ length: 400 }, (_, i) => 'b' + i) })).status, 400);
  assert.equal((await call('GET', '/api/users/short/picks')).status, 404);
  assert.equal((await call('GET', '/api/users/' + 'A'.repeat(22) + '/picks')).status, 404);
  assert.equal((await call('GET', '/nothing')).status, 404);
  assert.equal((await call('PUT', '/api/users')).status, 404);
});

test('two devices sharing one id see each other\'s stars and unstars', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', { picks: ['2439'] });
  const url = `/api/users/${user.id}/picks`;
  const phone = await call('POST', url, { add: ['2453', '2436'] });
  assert.deepEqual(phone.body.picks.sort(), ['2436', '2439', '2453']);
  assert.equal(phone.body.feed, user.feed);
  const laptop = await call('POST', url, { remove: ['2439'], add: ['2453'] });       // adding twice is harmless
  assert.deepEqual(laptop.body.picks.sort(), ['2436', '2453']);
  assert.deepEqual((await call('GET', url)).body.picks.sort(), ['2436', '2453']);
  assert.deepEqual((await call('POST', url, { add: ['2436'], remove: ['2436'] })).body.picks.sort(), ['2436', '2453']);  // add wins
  assert.deepEqual((await call('POST', url, {})).body.picks.sort(), ['2436', '2453']);
});

test('a pick is either interested (1) or attending (2), and attending is what "picks" lists', async () => {
  const { env, call } = setup();
  const r = await call('POST', '/api/users', { levels: { '2439': 2, '2453': 1 } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.levels, { '2439': 2, '2453': 1 });
  assert.deepEqual(r.body.picks, ['2439']);
  const url = `/api/users/${r.body.id}/picks`;
  let now = await call('POST', url, { set: { '2453': 2, '2439': 1, '2436': 1 } });       // swap which one is attended, add an interest
  assert.deepEqual(now.body.levels, { '2439': 1, '2453': 2, '2436': 1 });
  assert.deepEqual(now.body.picks, ['2453']);
  now = await call('POST', url, { set: { '2439': 0, 'never-there': 0 } });                // 0 removes; removing nothing is fine
  assert.deepEqual(now.body.levels, { '2453': 2, '2436': 1 });
  assert.equal(env.DB.count('picks'), 2);
  assert.deepEqual((await call('GET', url)).body.levels, { '2453': 2, '2436': 1 });
  for (const body of [{ set: { a: 3 } }, { set: { a: '2' } }, { set: ['a'] }, { raise: { a: 0 } }, { set: { 'bad id': 1 } }]) {
    assert.equal((await call('POST', url, body)).status, 400);
  }
  assert.equal((await call('POST', '/api/users', { levels: { a: 0 } })).status, 400);
});

test('raise adds what a newly linked browser has without lowering anything', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', { levels: { '2439': 2, '2453': 1 } });
  const url = `/api/users/${user.id}/picks`;
  const r = await call('POST', url, { raise: { '2439': 1, '2453': 2, '2436': 1, '2445': 2 } });
  assert.deepEqual(r.body.levels, { '2439': 2, '2453': 2, '2436': 1, '2445': 2 });
  const both = await call('POST', url, { raise: { '2436': 2 }, set: { '2436': 1 } });      // set is applied after raise
  assert.equal(both.body.levels['2436'], 1);
});

test('the calendar holds the attended sessions only', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', { levels: { '2439': 2, '2453': 1, 'evening-20261007': 2 } });
  const uids = async () => (await call('GET', `/cal/${user.feed}.ics`)).body.replace(/\r\n /g, '').split('\r\n').filter(l => l.startsWith('UID:'));
  assert.deepEqual(await uids(), ['UID:lpc2026-2439@lpc.events', 'UID:lpc2026-evening-20261007@lpc.events']);
  await call('POST', `/api/users/${user.id}/picks`, { set: { '2453': 2, '2439': 1 } });
  assert.deepEqual(await uids(), ['UID:lpc2026-2453@lpc.events', 'UID:lpc2026-evening-20261007@lpc.events']);
});

test('pages from before levels existed keep working: their picks mean attending', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', { picks: ['2439'], levels: { '2453': 1 } });
  assert.deepEqual(user.levels, { '2439': 2, '2453': 1 });
  const url = `/api/users/${user.id}/picks`;
  const added = await call('POST', url, { add: ['2453', '2436'] });                        // starring there means attending
  assert.deepEqual(added.body.levels, { '2439': 2, '2453': 2, '2436': 2 });
  const removed = await call('POST', url, { remove: ['2439'] });
  assert.deepEqual(removed.body.picks.sort(), ['2436', '2453']);
  assert.equal(removed.body.levels['2439'], undefined);
});

test('the feed key only reads the calendar; it cannot edit', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', { picks: ['2439'] });
  assert.equal((await call('POST', `/api/users/${user.feed}/picks`, { add: ['2453'] })).status, 404);
  assert.equal((await call('GET', `/api/users/${user.feed}/picks`)).status, 404);
  assert.equal((await call('GET', `/cal/${user.id}.ics`)).status, 404);
  assert.deepEqual((await call('GET', `/api/users/${user.id}/picks`)).body.picks, ['2439']);
});

test('deleting a user removes the picks and the calendar', async () => {
  const { env, call } = setup();
  const { body: user } = await call('POST', '/api/users', { picks: ['2439', '2453'] });
  const { body: other } = await call('POST', '/api/users', { picks: ['2439'] });
  assert.equal((await call('DELETE', `/api/users/${user.id}`)).status, 204);
  assert.equal((await call('GET', `/api/users/${user.id}/picks`)).status, 404);
  assert.equal((await call('GET', `/cal/${user.feed}.ics`)).status, 404);
  assert.equal(env.DB.count('users'), 1);
  assert.equal(env.DB.count('picks'), 1);
  assert.deepEqual((await call('GET', `/api/users/${other.id}/picks`)).body.picks, ['2439']);
});

test('the calendar lists exactly the picked sessions with the page\'s details', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', { picks: ['2453', '2439', 'evening-20261007', 'not-a-session'] });
  const r = await call('GET', `/cal/${user.feed}.ics`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  assert.ok(r.body.startsWith('BEGIN:VCALENDAR\r\n') && r.body.endsWith('END:VCALENDAR\r\n'));
  const raw = r.body.split('\r\n');
  assert.ok(raw.every(l => Buffer.byteLength(l) <= 75), 'a line is longer than 75 bytes');
  const lines = r.body.replace(/\r\n /g, '').split('\r\n');                              // unfold
  assert.deepEqual(lines.filter(l => l.startsWith('UID:')), [
    'UID:lpc2026-2439@lpc.events', 'UID:lpc2026-2453@lpc.events', 'UID:lpc2026-evening-20261007@lpc.events']);  // in time order
  const sessions = pickedSessions(page, new Set(['2439']));
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.ok(lines.includes('DTSTART;TZID=Europe/Prague:' + s.date.replace(/-/g, '') + 'T' + s.start.replace(':', '') + '00'));
  assert.ok(lines.includes('URL:' + s.url));
  assert.ok(lines.some(l => l.startsWith('SUMMARY:') && l.includes(s.title.split(',')[0].split(';')[0])));
  assert.ok(lines.includes('LOCATION:TBA\\, Prague Congress Centre'));                  // the evening event has no room
  await call('POST', `/api/users/${user.id}/picks`, { remove: ['2439'] });
  const after = (await call('GET', `/cal/${user.feed}.ics`)).body;
  assert.ok(!after.includes('lpc2026-2439@') && after.includes('lpc2026-2453@'));
});

test('an empty calendar is still a valid calendar, and a schedule outage is a 502', async () => {
  const { call } = setup();
  const { body: user } = await call('POST', '/api/users', {});
  const r = await call('GET', `/cal/${user.feed}.ics`);
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes('BEGIN:VEVENT') && r.body.includes('END:VTIMEZONE'));
  const down = setup({ scheduleStatus: 503 });
  const { body: u2 } = await down.call('POST', '/api/users', { picks: ['2439'] });
  assert.equal((await down.call('GET', `/cal/${u2.feed}.ics`)).status, 502);
});

test('calendar text is escaped and folded without breaking characters', () => {
  const out = ics([{ id: 'x1', title: 'Töpel; a, b\\c ' + 'é'.repeat(80), date: '2026-10-05', start: '10:00', end: '10:30', room: 'Club A',
    track: 'T', speakers: ['A', 'B'], url: 'https://example.org/x', abstract: 'line one\nline two' }], new Date('2026-10-04T00:00:00Z'));
  assert.ok(out.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
  const lines = out.replace(/\r\n /g, '').split('\r\n');
  assert.ok(lines.includes('SUMMARY:Töpel\\; a\\, b\\\\c ' + 'é'.repeat(80)));
  assert.ok(lines.includes('DESCRIPTION:T · A\\, B · https://example.org/x\\n\\nline one\\nline two'));
  assert.ok(lines.includes('DTSTAMP:20261004T000000Z'));
  assert.ok(lines.includes('DTEND;TZID=Europe/Prague:20261005T103000'));
});

test('preflight requests are answered for the page\'s cross-origin calls', async () => {
  const { call } = setup();
  const r = await call('OPTIONS', '/api/users');
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(r.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  assert.equal(r.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});
