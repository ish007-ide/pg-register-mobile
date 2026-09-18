/**
 * Flat JSON data store for the PG register.
 *
 * Keeps K.A.V.A.C.H's read-modify-write-whole-file pattern, which is fine at
 * 20 guests and a few hundred log rows a month. Record shape changes from a
 * case file to a visit log:
 *
 *   { id, guest_id, guest_name, direction: "in"|"out", timestamp,
 *     confidence, source, event_id, flagged }
 *
 * Two files this module reads but never writes: data/guests.json is owned by
 * recognition/enroll.py. data/embeddings.json is never read here at all —
 * biometrics stay on the mini PC and are not served to the browser.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');

const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const UNKNOWN_FILE = path.join(DATA_DIR, 'unknown.json');

/**
 * Hour at which the register rolls over and everyone is presumed in.
 *
 * This is the safety net under the toggle heuristic. A single missed
 * recognition inverts a guest's in/out state, and without a reset that
 * inversion would persist for weeks. Resetting at 4am — when essentially
 * everyone is home — bounds the damage to one day.
 */
const DAY_RESET_HOUR = Number(process.env.DAY_RESET_HOUR || 4);

// --------------------------------------------------------------------------
// File helpers
// --------------------------------------------------------------------------

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`[db] could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

/** Write via a temp file + rename so a crash can't leave a half-written register. */
function writeJson(file, payload) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// --------------------------------------------------------------------------
// Day boundary
// --------------------------------------------------------------------------

/** Most recent DAY_RESET_HOUR in server-local time, at or before `now`. */
function dayBoundary(now = new Date()) {
  const b = new Date(now);
  b.setHours(DAY_RESET_HOUR, 0, 0, 0);
  if (b > now) b.setDate(b.getDate() - 1);
  return b;
}

// --------------------------------------------------------------------------
// Guests
// --------------------------------------------------------------------------

function readGuests() {
  return readJson(GUESTS_FILE, []).map((g) => ({
    id: g.id,
    name: g.name,
    room_no: String(g.room_no),
    phone: g.phone || '',
    active: g.active !== false,
    enrolled_at: g.enrolled_at || null,
    photo_count: g.photo_count || 0,
  }));
}

function readLogs() {
  return readJson(LOGS_FILE, []);
}

function writeLogs(logs) {
  writeJson(LOGS_FILE, logs);
}

/** Logs for one guest, newest first. */
function logsForGuest(guestId, logs = readLogs()) {
  return logs
    .filter((l) => l.guest_id === guestId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Current in/out state for a guest.
 *
 * Only logs since the last 4am rollover count. With none, the guest is
 * presumed in, which is both the safe default and the self-healing one.
 */
function statusFor(guestId, logs = readLogs(), now = new Date()) {
  const boundary = dayBoundary(now);
  const mine = logsForGuest(guestId, logs);
  const today = mine.filter((l) => new Date(l.timestamp) >= boundary);
  const last = mine[0] || null;

  return {
    status: today.length ? today[0].direction : 'in',
    presumed: today.length === 0, // no evidence today — this is the default, not an observation
    last_seen: last ? last.timestamp : null,
    last_direction: last ? last.direction : null,
    movements_today: today.length,
  };
}

/** Roster joined with current status, sorted by room. */
function guestsWithStatus(now = new Date()) {
  const logs = readLogs();
  return readGuests()
    .map((g) => ({ ...g, ...statusFor(g.id, logs, now) }))
    .sort((a, b) =>
      a.room_no.localeCompare(b.room_no, undefined, { numeric: true }) ||
      a.name.localeCompare(b.name)
    );
}

function guestDetail(guestId, now = new Date()) {
  const guest = readGuests().find((g) => g.id === guestId);
  if (!guest) return null;
  const logs = readLogs();
  return { ...guest, ...statusFor(guestId, logs, now), logs: logsForGuest(guestId, logs) };
}

// --------------------------------------------------------------------------
// Appending a movement
// --------------------------------------------------------------------------

function nextId(logs) {
  return `log_${Date.now().toString(36)}_${(logs.length + 1).toString(36)}`;
}

/**
 * Record one movement. Returns { log, duplicate }.
 *
 * Direction comes from the camera when the track gave a confident read
 * (face growing = walking in). Otherwise it falls back to toggling the last
 * known state. Idempotent on event_id, so the recognition service can retry
 * a queued event without double-toggling anyone.
 */
function appendLog({
  guest_id,
  timestamp,
  confidence = null,
  direction = null,
  source = 'camera',
  event_id = null,
  note = '',
}, now = new Date()) {
  const guest = readGuests().find((g) => g.id === guest_id);
  if (!guest) {
    const err = new Error(`unknown guest_id ${guest_id}`);
    err.code = 'UNKNOWN_GUEST';
    throw err;
  }

  const logs = readLogs();

  if (event_id) {
    const seen = logs.find((l) => l.event_id === event_id);
    if (seen) return { log: seen, duplicate: true };
  }

  const current = statusFor(guest_id, logs, now).status;
  const resolved = direction === 'in' || direction === 'out'
    ? direction
    : current === 'in' ? 'out' : 'in';

  // Camera says "in" for someone already in: their exit was missed. Trust the
  // direct observation, but flag the row so the register shows why the
  // history has two entries in a row.
  const flagged = resolved === current && direction !== null;

  const log = {
    id: nextId(logs),
    event_id: event_id || null,
    guest_id,
    guest_name: guest.name,
    room_no: guest.room_no,
    direction: resolved,
    timestamp: timestamp || new Date().toISOString(),
    confidence: confidence === null ? null : Number(confidence),
    source,
    inferred: direction === null, // true = toggled, false = camera read the direction
    flagged,
    note: note || (flagged ? 'repeat direction — a movement was probably missed' : ''),
    created_at: new Date().toISOString(),
  };

  logs.push(log);
  writeLogs(logs);
  return { log, duplicate: false };
}

// --------------------------------------------------------------------------
// Queries
// --------------------------------------------------------------------------

/** Full history, newest first. `date` is YYYY-MM-DD in server-local time. */
function queryLogs({ date = null, guest_id = null, limit = null } = {}) {
  let logs = readLogs();

  if (guest_id) logs = logs.filter((l) => l.guest_id === guest_id);
  if (date) {
    const start = new Date(`${date}T00:00:00`);
    if (Number.isNaN(start.getTime())) {
      const err = new Error('date must be YYYY-MM-DD');
      err.code = 'BAD_DATE';
      throw err;
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    logs = logs.filter((l) => {
      const t = new Date(l.timestamp);
      return t >= start && t < end;
    });
  }

  logs = logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return limit ? logs.slice(0, Number(limit)) : logs;
}

function summary(now = new Date()) {
  const guests = guestsWithStatus(now);
  const active = guests.filter((g) => g.active);
  return {
    total_guests: active.length,
    currently_in: active.filter((g) => g.status === 'in').length,
    currently_out: active.filter((g) => g.status === 'out').length,
    movements_today: queryLogs().filter((l) => new Date(l.timestamp) >= dayBoundary(now)).length,
    unconfirmed: active.filter((g) => g.presumed).length,
    day_started: dayBoundary(now).toISOString(),
  };
}

// --------------------------------------------------------------------------
// Unknown faces — kept apart from the register
// --------------------------------------------------------------------------

function appendUnknown(event) {
  const rows = readJson(UNKNOWN_FILE, []);
  if (event.event_id && rows.some((r) => r.event_id === event.event_id)) {
    return { row: rows.find((r) => r.event_id === event.event_id), duplicate: true };
  }
  const row = {
    id: `unk_${Date.now().toString(36)}_${(rows.length + 1).toString(36)}`,
    event_id: event.event_id || null,
    timestamp: event.timestamp || new Date().toISOString(),
    best_score: event.best_score ?? null,
    reason: event.reason || 'unknown',
    direction: event.direction || null,
  };
  rows.push(row);
  // Unbounded growth here is a real risk at a busy door: keep the last 500.
  writeJson(UNKNOWN_FILE, rows.slice(-500));
  return { row, duplicate: false };
}

function queryUnknown({ limit = 100 } = {}) {
  return readJson(UNKNOWN_FILE, [])
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, Number(limit));
}

module.exports = {
  DATA_DIR,
  DAY_RESET_HOUR,
  dayBoundary,
  readGuests,
  readLogs,
  writeLogs,
  logsForGuest,
  statusFor,
  guestsWithStatus,
  guestDetail,
  appendLog,
  queryLogs,
  summary,
  appendUnknown,
  queryUnknown,
};
