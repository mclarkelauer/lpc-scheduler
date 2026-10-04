#!/usr/bin/env python3
"""Refresh the schedule snapshot embedded in index.html from lpc.events.

    ./rebuild.py             fetch the current schedule; rewrite index.html if it changed
    ./rebuild.py --dry-run   report what would change without writing anything
    ./rebuild.py --force     rewrite even if nothing changed (refreshes the snapshot time)

.github/workflows/refresh.yml runs this on a schedule and commits the result.

Three parts of the page are regenerated: the SESSIONS array, the BREAKS array and
the footer note. The data comes from the two public Indico exports of the event
(no API key needed):

    https://lpc.events/export/event/20.json?detail=contributions   titles, speakers, abstracts
    https://lpc.events/export/timetable/20.json                    times, rooms, breaks

Sessions already on the page keep their id (matched by id, then by title), because
picks saved in visitors' browsers refer to those ids.
"""
import argparse
import collections
import datetime
import http.client
import json
import os
import re
import sys
import time
import urllib.request
from zoneinfo import ZoneInfo

EVENT = 20
BASE = 'https://lpc.events'
EVENT_URL = '%s/export/event/%d.json?detail=contributions' % (BASE, EVENT)
TIMETABLE_URL = '%s/export/timetable/%d.json' % (BASE, EVENT)
BOF = 'Birds of a Feather (BoF)'
TZ = 'Europe/Prague'
SESSIONS_PREFIX = 'const SESSIONS = '
BREAKS_RE = re.compile(r'const BREAKS = \[\n.*?\n\];', re.S)
FOOTER_RE = re.compile(r'(<footer class="note">\n).*?(</footer>)', re.S)

norm = lambda t: re.sub(r'[^a-z0-9]+', ' ', (t or '').lower()).strip()
squash = lambda t: re.sub(r'\s+', ' ', t or '').strip()
room_name = lambda r: (r or '').strip().strip('"').strip()
hm = lambda d: d['time'][:5]
mins = lambda t: int(t[:2]) * 60 + int(t[3:5])


def fetch(url, tries=3):
    req = urllib.request.Request(url, headers={'User-Agent': 'lpc-scheduler rebuild.py'})
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except (OSError, ValueError, http.client.HTTPException) as e:   # network error or a cut-off reply
            if attempt == tries:
                raise
            print('  %s: %s; retrying' % (type(e).__name__, e))
            time.sleep(10 * attempt)


def clean_abstract(t):
    t = (t or '').replace('\r\n', '\n').replace('\r', '\n')
    t = re.sub(r'<br\s*/?>', '\n', t, flags=re.I)
    lines = []
    for ln in t.split('\n'):
        ln = ln.rstrip()
        lead = len(ln) - len(ln.lstrip(' '))
        lines.append(ln[:lead] + re.sub(r' {3,}', ' ', ln[lead:]))   # some abstracts are space-padded
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()


def read_page(src):
    """Return (sessions, start, end) for the SESSIONS array literal in the page source."""
    at = src.index(SESSIONS_PREFIX) + len(SESSIONS_PREFIX)
    sessions, end = json.JSONDecoder().raw_decode(src, at)
    assert src[end] == ';', 'unexpected text after the SESSIONS array'
    return sessions, at, end


def match_ids(old, sched, contribs):
    """Map contribution db_id -> id already used on the page for that session."""
    unused = {x['db_id'] for x in sched}
    when = {x['db_id']: (x['date'], x['start']) for x in sched}
    keep = {}

    def claim(s, db):
        keep[db] = s['id']
        unused.discard(db)

    pending, still = [], []
    for s in old:                                 # 1: same id and same title
        db = int(s['id']) if s['id'].isdigit() else None
        if db in unused and norm(contribs[db]['title']) == norm(s['title']):
            claim(s, db)
        else:
            pending.append(s)
    for s in pending:                             # 2: same title; time, then track, break ties
        cand = [d for d in unused if norm(contribs[d]['title']) == norm(s['title'])]
        for narrow in (lambda d: when[d] == (s['date'], s['start']),
                       lambda d: contribs[d]['session'] == s['track']):
            if len(cand) > 1:
                cand = [d for d in cand if narrow(d)] or cand
        if len(cand) == 1:
            claim(s, cand[0])
        else:
            still.append(s)
    for s in still:                               # 3: same id, title has changed
        db = int(s['id']) if s['id'].isdigit() else None
        if db in unused:
            claim(s, db)
    return keep


def build_sessions(event, timetable, old):
    contribs = {c['db_id']: c for c in event['contributions']}
    sched, blocks, extras = [], [], []
    for ents in timetable.values():
        for e in ents.values():
            assert e['startDate']['tz'] == TZ, e['startDate']
            subs = [x for x in (e.get('entries') or {}).values() if x['entryType'] == 'Contribution']
            if e['entryType'] != 'Session' or not subs:
                extras.append(e)                  # evening events, session blocks without talks
                continue
            blocks.append(e)
            for sub in subs:
                sched.append({'db_id': sub['contributionId'], 'date': sub['startDate']['date'],
                              'start': hm(sub['startDate']), 'end': hm(sub['endDate']),
                              'room': room_name(sub.get('room')) or room_name(e.get('room')),
                              'block': e['id'], 'track': e['title']})
    assert len(sched) == len({x['db_id'] for x in sched}), 'a contribution is scheduled twice'

    old_by_id = {s['id']: s for s in old}
    keep = match_ids([s for s in old if s['type'] != 'other'], sched, contribs)
    kept, block_rooms = collections.Counter(), collections.defaultdict(collections.Counter)
    new, roomless = {}, []
    for x in sched:
        c = contribs[x['db_id']]
        sid = keep.get(x['db_id'], str(x['db_id']))
        assert sid not in new, 'duplicate session id %s' % sid
        prev = old_by_id.get(sid) if x['db_id'] in keep else None
        room = x['room']
        if not room and prev and prev['room'] != 'TBD':
            room = prev['room']                   # the exports leave some rooms blank
            kept[room] += 1
        elif not room:
            roomless.append((sid, x['block']))
        speakers = []
        for p in c['speakers']:
            name = squash(p['first_name'] + ' ' + p['last_name'])
            if name and name not in speakers:
                speakers.append(name)
        track = c['session'] or x['track']
        new[sid] = {'id': sid, 'title': squash(c['title']), 'date': x['date'], 'start': x['start'], 'end': x['end'],
                    'room': room or 'TBD', 'track': track, 'speakers': speakers,
                    'type': 'bof' if track == BOF else 'talk',
                    'url': '%s/event/%d/contributions/%d/' % (BASE, EVENT, x['db_id']),
                    'abstract': clean_abstract(c['description'])}
        if room:
            block_rooms[x['block']][room] += 1
    for sid, block in roomless:                   # new talk in a block whose room the page already knows
        if block_rooms[block]:
            new[sid]['room'] = block_rooms[block].most_common(1)[0][0]
            kept[new[sid]['room']] += 1
    notes = ['room is blank in the export for %d session%s, kept "%s" from the page' % (n, '' if n == 1 else 's', r)
             for r, n in sorted(kept.items())]

    for e in extras:
        date = e['startDate']['date']
        if e['entryType'] == 'Session':
            sid = 'session-%s' % e['sessionId']
            url = '%s/event/%d/sessions/%s/' % (BASE, EVENT, e['sessionId'])
        else:
            same = [s for s in old if s['type'] == 'other' and s['date'] == date and norm(s['title']) == norm(e['title'])]
            sid = same[0]['id'] if same else 'break-%s' % e['id']
            url = '%s/event/%d/timetable/#%s.detailed' % (BASE, EVENT, date.replace('-', ''))
        assert sid not in new, 'duplicate session id %s' % sid
        new[sid] = {'id': sid, 'title': squash(e['title']), 'date': date, 'start': hm(e['startDate']),
                    'end': hm(e['endDate']), 'room': room_name(e.get('room')) or 'TBD', 'track': '', 'speakers': [],
                    'type': 'other', 'url': url, 'abstract': clean_abstract(e.get('description'))}
    return new, blocks, block_rooms, notes


def build_breaks(blocks, block_rooms, room_order):
    """Coffee and lunch breaks, in the shape the page expects ('rooms' only when a break is not conference-wide)."""
    rank = lambda r: room_order.index(r) if r in room_order else len(room_order)
    found = collections.defaultdict(set)          # (date, label, start, end) -> rooms
    for e in blocks:
        fallback = block_rooms[e['id']].most_common(1)
        for sub in (e.get('entries') or {}).values():
            if sub['entryType'] != 'Break':
                continue
            start, end = hm(sub['startDate']), hm(sub['endDate'])
            if mins(end) - mins(start) < 10:
                continue                          # "short break" gaps between talks
            title = squash(sub['title'])
            label = 'Lunch break' if title.lower().startswith('lunch') else \
                    'Coffee break' if title.lower().startswith('coffee') else title
            room = room_name(sub.get('room')) or room_name(e.get('room')) or (fallback[0][0] if fallback else '')
            found[(sub['startDate']['date'], label, start, end)].add(room)

    out = []
    groups = collections.defaultdict(list)
    for (date, label, start, end), rooms in found.items():
        groups[(date, label)].append([start, end, rooms])
    for (date, label), wins in groups.items():
        wins.sort(key=lambda w: (mins(w[0]), mins(w[1])))
        clusters = []                             # windows that overlap in time are one break
        for w in wins:
            if clusters and mins(w[0]) < max(mins(x[1]) for x in clusters[-1]):
                clusters[-1].append(w)
            else:
                clusters.append([w])
        for cl in clusters:
            main = max(cl, key=lambda w: (len(w[2]), -mins(w[0])))
            rest = []
            for w in cl:                          # fold windows within 5 minutes of the main one into it
                if w is not main and abs(mins(w[0]) - mins(main[0])) <= 5 and abs(mins(w[1]) - mins(main[1])) <= 5:
                    main[2] |= w[2]
                elif w is not main:
                    rest.append(w)
            for w in [main] + rest:
                rooms = sorted((r for r in w[2] if r), key=rank) if rest else None
                out.append({'date': date, 'start': w[0], 'end': w[1], 'title': label, 'rooms': rooms})
    out.sort(key=lambda b: (b['date'], mins(b['start']), mins(b['end'])))
    return out


def js_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'").replace('</', '<\\/') + "'"


def breaks_js(breaks):
    rows = []
    for b in breaks:
        row = "  {date:%s,start:%s,end:%s,title:%s" % tuple(js_str(b[k]) for k in ('date', 'start', 'end', 'title'))
        if b['rooms']:
            row += ',rooms:[%s]' % ','.join(js_str(r) for r in b['rooms'])
        rows.append(row + '}')
    return 'const BREAKS = [\n' + ',\n'.join(rows) + '\n];'


def sessions_js(sessions):
    """One session per line, so a snapshot diff shows which sessions changed."""
    enc = lambda s: (json.dumps(s, ensure_ascii=False).replace('</', '<\\/')
                     .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))
    return '[\n' + ',\n'.join(enc(s) for s in sessions) + '\n]'


def footer_text(sessions, taken):
    rooms = {s['room'] for s in sessions if s['room'] != 'TBD'}
    tracks = {s['track'] for s in sessions if s['track']}
    stamp = '%s %d %d, %s' % (taken.strftime('%b'), taken.day, taken.year, taken.strftime('%H:%M'))
    return ('  Data: full scheduled program from lpc.events (Indico export), snapshot taken %s Prague time — %d sessions across\n'
            '  %d tracks and %d rooms, with abstracts embedded for %d of them (the search box looks through abstracts too).\n'
            '  Times are Europe/Prague. Breaks follow the lpc.events timetable.\n'
            % (stamp, len(sessions), len(tracks), len(rooms), sum(1 for s in sessions if s['abstract'])))


def report(old, new):
    day = lambda d: datetime.date.fromisoformat(d).strftime('%a')
    old_by_id = {s['id']: s for s in old}
    lines = []
    for s in new:
        o = old_by_id.get(s['id'])
        what = '%s %s %s' % (day(s['date']), s['start'], s['title'][:70])
        if o is None:
            lines.append('  added     %s  [%s]' % (what, s['room']))
            continue
        if (o['date'], o['start'], o['end']) != (s['date'], s['start'], s['end']):
            lines.append('  time      %s %s-%s -> %s %s-%s  %s' % (day(o['date']), o['start'], o['end'], day(s['date']),
                                                                 s['start'], s['end'], s['title'][:60]))
        if o['room'] != s['room']:
            lines.append('  room      %s -> %s  %s' % (o['room'], s['room'], what))
        if o['title'] != s['title']:
            lines.append('  title     "%s" -> "%s"' % (o['title'], s['title']))
        if o['speakers'] != s['speakers']:
            lines.append('  speakers  %s -> %s  %s' % (', '.join(o['speakers']) or '(none)', ', '.join(s['speakers']) or '(none)', what))
        if o['track'] != s['track']:
            lines.append('  track     %s -> %s  %s' % (o['track'], s['track'], what))
        if o.get('abstract', '') != s['abstract']:
            lines.append('  abstract  %s' % what)
        if (o['url'], o['type']) != (s['url'], s['type']):
            lines.append('  link/type %s' % what)
    ids = {s['id'] for s in new}
    for o in old:
        if o['id'] not in ids:
            lines.append('  removed   %s %s %s' % (day(o['date']), o['start'], o['title'][:70]))
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('page', nargs='?', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html'),
                    help='page to update (default: index.html next to this script)')
    ap.add_argument('--dry-run', action='store_true', help='report what would change, write nothing')
    ap.add_argument('--force', action='store_true', help='rewrite the page even if the schedule has not changed')
    args = ap.parse_args()

    src = open(args.page, encoding='utf-8').read()
    old, at, end = read_page(src)
    room_order = json.loads(re.search(r'const ROOM_ORDER = (\[.*?\]);', src).group(1).replace("'", '"'))
    old_breaks = BREAKS_RE.search(src).group(0)

    print('Fetching %s' % EVENT_URL)
    ev = fetch(EVENT_URL)
    print('Fetching %s' % TIMETABLE_URL)
    tt = fetch(TIMETABLE_URL)
    taken = datetime.datetime.fromtimestamp(ev['ts'], ZoneInfo(TZ))

    new, blocks, block_rooms, notes = build_sessions(ev['results'][0], tt['results'][str(EVENT)], old)
    rank = lambda r: room_order.index(r) if r in room_order else len(room_order)
    sessions = sorted(new.values(), key=lambda s: (s['date'], s['start'], rank(s['room']), s['title'], s['id']))
    if len(sessions) < max(1, len(old) // 2):
        sys.exit('Refusing to write: the export has %d sessions, the page has %d. Is lpc.events returning a full schedule?'
                 % (len(sessions), len(old)))
    breaks = breaks_js(build_breaks(blocks, block_rooms, room_order))

    changes = report(old, sessions)
    if breaks != old_breaks:
        changes.append('  breaks    changed:\n' + '\n'.join('    ' + ln for ln in breaks.split('\n')[1:-1]))
    for r in sorted({s['room'] for s in sessions} - set(room_order) - {'TBD'}):
        notes.append('WARNING: room "%s" is not in ROOM_ORDER in the page, so "Now & next" will not show it' % r)
    print('Snapshot of %s Prague time: %d sessions (page had %d), %d with an abstract'
          % (taken.strftime('%Y-%m-%d %H:%M'), len(sessions), len(old), sum(1 for s in sessions if s['abstract'])))
    print('\n'.join(changes) if changes else '  no schedule changes')
    for n in notes:
        print('  note: ' + n)

    out = src[:at] + sessions_js(sessions) + src[end:]
    out, n = BREAKS_RE.subn(lambda m: breaks, out, count=1)
    assert n == 1, 'BREAKS block not found'
    out, n = FOOTER_RE.subn(lambda m: m.group(1) + footer_text(sessions, taken) + m.group(2), out, count=1)
    assert n == 1, 'footer note not found'
    if args.dry_run:
        print('Dry run: %s not written.' % args.page)
        return
    if not changes and not args.force:
        print('%s left as it is (--force rewrites it with the new snapshot time).' % args.page)
        return
    tmp = args.page + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(out)
    os.replace(tmp, args.page)
    print('Wrote %s (%d bytes).' % (args.page, len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()
