/**
 * The live door view: one frame, held in memory, never written to disk.
 *
 * The recognition service pushes annotated frames here and the browser pulls
 * them. Nothing is stored — there is exactly one frame in existence at a time
 * and it is overwritten a few times a second. A picture of whoever is at the
 * door is the most sensitive thing this system handles, so it does not go
 * anywhere it would persist.
 *
 * The important behaviour is the backpressure. `wanted()` is false unless a
 * browser has actually asked for a frame in the last few seconds, and the
 * recognition service checks it before encoding anything. So:
 *
 *   nobody watching  ->  wanted() false  ->  no JPEG encode on the mini PC
 *   warden opens it  ->  wanted() true   ->  frames flow
 *   warden walks off ->  times out       ->  frames stop on their own
 *
 * That last line is the point. The saving doesn't depend on anyone
 * remembering to switch the view off.
 */

/** No browser has asked in this long — assume nobody is watching. */
const VIEWER_TIMEOUT_MS = Number(process.env.LIVE_VIEW_TIMEOUT_MS || 10000);

/** A frame older than this is history, not a live view. */
const FRAME_TTL_MS = Number(process.env.LIVE_VIEW_TTL_MS || 6000);

/** Roughly 2MB of base64 — far above a 480px JPEG, far below a memory problem. */
const MAX_IMAGE_CHARS = 2_800_000;

const MAX_FACES = 12;
const MAX_NAME_CHARS = 60;

let latest = null;
let lastAskedAt = 0;
let enabled = true;

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/**
 * Frames arrive from another process. Shape them before anything is held, so
 * a malformed payload can't reach the browser or grow without bound.
 */
function cleanFaces(faces) {
  if (!Array.isArray(faces)) return [];
  const out = [];
  for (const face of faces.slice(0, MAX_FACES)) {
    if (!face || typeof face !== 'object') continue;
    const x = clamp01(face.x);
    const y = clamp01(face.y);
    const w = clamp01(face.w);
    const h = clamp01(face.h);
    if (x === null || y === null || w === null || h === null) continue;

    const score = Number(face.score);
    out.push({
      x,
      y,
      w,
      h,
      name: String(face.name ?? '').slice(0, MAX_NAME_CHARS),
      known: face.known === true,
      score: Number.isFinite(score) ? score : null,
    });
  }
  return out;
}

/** Called by the recognition service. Returns whether to keep sending. */
function put(frame, now = Date.now()) {
  const { image, faces, width, height, captured_at } = frame || {};

  if (typeof image !== 'string' || !image) {
    return { ok: false, error: 'image must be a base64 string' };
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return { ok: false, error: 'frame too large' };
  }
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, error: 'width and height must be positive' };
  }

  latest = {
    image,
    faces: cleanFaces(faces),
    width: Math.round(w),
    height: Math.round(h),
    captured_at: typeof captured_at === 'string' ? captured_at : new Date(now).toISOString(),
    received_at: now,
  };

  return { ok: true, wanted: wanted(now) };
}

/**
 * Called by the browser. This is the only thing that counts as watching —
 * the recognition service's own state poll deliberately does not, or the
 * service would keep itself awake forever.
 */
function take(now = Date.now()) {
  lastAskedAt = now;

  if (!enabled) {
    return { enabled: false, frame: null, reason: 'off' };
  }
  if (!latest) {
    return { enabled: true, frame: null, reason: 'waiting' };
  }
  if (now - latest.received_at > FRAME_TTL_MS) {
    return { enabled: true, frame: null, reason: 'camera_quiet' };
  }
  return { enabled: true, frame: latest, reason: 'ok' };
}

/** Is anyone watching right now, and is the view switched on at all? */
function wanted(now = Date.now()) {
  return enabled && now - lastAskedAt < VIEWER_TIMEOUT_MS;
}

/** The recognition service's poll. Must not count as a viewer. */
function state(now = Date.now()) {
  return {
    enabled,
    wanted: wanted(now),
    watching: now - lastAskedAt < VIEWER_TIMEOUT_MS,
    has_frame: Boolean(latest) && now - latest.received_at <= FRAME_TTL_MS,
  };
}

/** The warden's switch. Off drops the held frame immediately. */
function setEnabled(value, now = Date.now()) {
  enabled = value === true;
  if (!enabled) latest = null;
  return state(now);
}

/** Tests only. */
function reset() {
  latest = null;
  lastAskedAt = 0;
  enabled = true;
}

module.exports = {
  VIEWER_TIMEOUT_MS,
  FRAME_TTL_MS,
  MAX_IMAGE_CHARS,
  put,
  take,
  wanted,
  state,
  setEnabled,
  reset,
};
