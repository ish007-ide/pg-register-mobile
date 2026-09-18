/**
 * Register logic tests. No test framework needed: node backend/server/db.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-db-'));
process.env.DATA_DIR = tmp;
process.env.DAY_RESET_HOUR = '4';

const db = require('./db');

const GUESTS = [
  { id: 'g1', name: 'Asha Kulkarni', room_no: '204', enrolled_at: '2026-09-01T00:00:00Z' },
  { id: 'g2', name: 'Rohit Deshmukh', room_no: '101', enrolled_at: '2026-09-01T00:00:00Z' },
  { id: 'g3', name: 'Meera Joshi', room_no: '15', active: false },
];

function reset() {
  fs.writeFileSync(path.join(tmp, 'guests.json'), JSON.stringify(GUESTS));
  fs.writeFileSync(path.join(tmp, 'logs.json'), '[]');
  fs.writeFileSync(path.join(tmp, 'unknown.json'), '[]');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  reset();
  try {
    fn();
    passed += 1;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// local-time helper so tests don't depend on the machine's timezone
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0);
const iso = (...a) => at(...a).toISOString();

// --------------------------------------------------------------------------

test('a guest with no logs is presumed in', () => {
  const s = db.statusFor('g1', db.readLogs(), at(2026, 9, 18, 10));
  eq(s.status, 'in');
  eq(s.presumed, true);
  eq(s.last_seen, null);
});

test('first movement of the day toggles to out', () => {
  const { log } = db.appendLog(
    { guest_id: 'g1', timestamp: iso(2026, 9, 18, 9), confidence: 0.61 },
    at(2026, 9, 18, 9)
  );
  eq(log.direction, 'out');
  eq(log.inferred, true);
  eq(log.guest_name, 'Asha Kulkarni');
  eq(log.room_no, '204');
  eq(db.statusFor('g1', db.readLogs(), at(2026, 9, 18, 10)).status, 'out');
});

test('successive movements alternate out, in, out', () => {
  const dirs = [9, 18, 20].map(
    (h) => db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, h) }, at(2026, 9, 18, h)).log.direction
  );
  eq(dirs.join(','), 'out,in,out');
});

test('camera-supplied direction overrides the toggle', () => {
  const { log } = db.appendLog(
    { guest_id: 'g1', timestamp: iso(2026, 9, 18, 9), direction: 'in' },
    at(2026, 9, 18, 9)
  );
  eq(log.direction, 'in');
  eq(log.inferred, false);
});

test('two identical directions in a row are kept but flagged', () => {
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, 9), direction: 'out' }, at(2026, 9, 18, 9));
  const { log } = db.appendLog(
    { guest_id: 'g1', timestamp: iso(2026, 9, 18, 11), direction: 'out' },
    at(2026, 9, 18, 11)
  );
  eq(log.direction, 'out');
  eq(log.flagged, true);
  assert(log.note.length > 0, 'flagged row should explain itself');
});

test('replaying an event_id does not double-toggle', () => {
  const first = db.appendLog(
    { guest_id: 'g1', timestamp: iso(2026, 9, 18, 9), event_id: 'evt-1' },
    at(2026, 9, 18, 9)
  );
  const replay = db.appendLog(
    { guest_id: 'g1', timestamp: iso(2026, 9, 18, 9), event_id: 'evt-1' },
    at(2026, 9, 18, 9)
  );
  eq(replay.duplicate, true);
  eq(replay.log.id, first.log.id);
  eq(db.readLogs().length, 1);
  eq(db.statusFor('g1', db.readLogs(), at(2026, 9, 18, 10)).status, 'out');
});

test('state resets to in after the 4am rollover', () => {
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 17, 22), direction: 'out' }, at(2026, 9, 17, 22));
  // 11pm the same evening: still out
  eq(db.statusFor('g1', db.readLogs(), at(2026, 9, 17, 23)).status, 'out');
  // 8am next morning: rolled over, presumed in again
  const s = db.statusFor('g1', db.readLogs(), at(2026, 9, 18, 8));
  eq(s.status, 'in');
  eq(s.presumed, true);
  // history is not lost
  eq(s.last_direction, 'out');
  assert(s.last_seen !== null, 'last_seen should survive the rollover');
});

test('a 1am movement still belongs to the previous day', () => {
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, 1), direction: 'in' }, at(2026, 9, 18, 1));
  eq(db.statusFor('g1', db.readLogs(), at(2026, 9, 18, 2)).status, 'in');
  eq(db.dayBoundary(at(2026, 9, 18, 2)).getDate(), 17);
});

test('guests are listed by room with status attached', () => {
  db.appendLog({ guest_id: 'g2', timestamp: iso(2026, 9, 18, 8), direction: 'out' }, at(2026, 9, 18, 8));
  const rows = db.guestsWithStatus(at(2026, 9, 18, 10));
  eq(rows.length, 3);
  eq(rows.map((r) => r.room_no).join(','), '15,101,204', 'rooms sort numerically, not lexically');
  eq(rows.find((r) => r.id === 'g2').status, 'out');
  assert(!('embedding' in rows[0]), 'embeddings must never reach the API layer');
});

test('summary counts only active guests', () => {
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, 8), direction: 'out' }, at(2026, 9, 18, 8));
  const s = db.summary(at(2026, 9, 18, 10));
  eq(s.total_guests, 2, 'moved-out guest excluded');
  eq(s.currently_out, 1);
  eq(s.currently_in, 1);
  eq(s.movements_today, 1);
  eq(s.unconfirmed, 1, 'g2 has no movement today');
});

test('logs filter by date and by guest', () => {
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 17, 10) }, at(2026, 9, 17, 10));
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, 10) }, at(2026, 9, 18, 10));
  db.appendLog({ guest_id: 'g2', timestamp: iso(2026, 9, 18, 11) }, at(2026, 9, 18, 11));

  eq(db.queryLogs({ date: '2026-09-18' }).length, 2);
  eq(db.queryLogs({ guest_id: 'g1' }).length, 2);
  eq(db.queryLogs({ date: '2026-09-18', guest_id: 'g2' }).length, 1);
  eq(db.queryLogs({ limit: 1 }).length, 1);
  eq(db.queryLogs()[0].guest_id, 'g2', 'newest first');
});

test('bad date is rejected', () => {
  let code = null;
  try {
    db.queryLogs({ date: 'yesterday' });
  } catch (e) {
    code = e.code;
  }
  eq(code, 'BAD_DATE');
});

test('unknown guest_id is rejected', () => {
  let code = null;
  try {
    db.appendLog({ guest_id: 'nope', timestamp: iso(2026, 9, 18, 9) });
  } catch (e) {
    code = e.code;
  }
  eq(code, 'UNKNOWN_GUEST');
});

test('guest detail carries the full history newest first', () => {
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, 9) }, at(2026, 9, 18, 9));
  db.appendLog({ guest_id: 'g1', timestamp: iso(2026, 9, 18, 18) }, at(2026, 9, 18, 18));
  const d = db.guestDetail('g1', at(2026, 9, 18, 19));
  eq(d.name, 'Asha Kulkarni');
  eq(d.logs.length, 2);
  eq(d.logs[0].direction, 'in');
  eq(db.guestDetail('missing'), null);
});

test('manual overrides are recorded as manual', () => {
  const { log } = db.appendLog(
    { guest_id: 'g1', timestamp: iso(2026, 9, 18, 9), direction: 'out', source: 'manual', note: 'camera down' },
    at(2026, 9, 18, 9)
  );
  eq(log.source, 'manual');
  eq(log.note, 'camera down');
  eq(log.confidence, null);
});

test('unknown faces are stored separately and deduplicated', () => {
  db.appendUnknown({ event_id: 'u1', timestamp: iso(2026, 9, 18, 9), best_score: 0.31, reason: 'below_threshold' });
  const again = db.appendUnknown({ event_id: 'u1', timestamp: iso(2026, 9, 18, 9) });
  eq(again.duplicate, true);
  eq(db.queryUnknown().length, 1);
  eq(db.readLogs().length, 0, 'unknown faces must not enter the register');
});

test('a corrupt logs file does not take the register down', () => {
  fs.writeFileSync(path.join(tmp, 'logs.json'), '{ this is not json');
  eq(db.readLogs().length, 0);
  eq(db.summary(at(2026, 9, 18, 10)).total_guests, 2);
});

console.log(`\n${passed}/${passed + failed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
