/**
 * Adding a guest from the browser.
 *
 * The warden fills in a name, a room and a few photos. That can't be a plain
 * request/response: enroll.py loads a ~300MB model, which takes tens of
 * seconds on a mini PC and minutes the very first time while the model pack
 * downloads. So this starts a job, hands back an id, and the page polls it.
 *
 * The photos are a temporary artifact and are treated like one. They are
 * written to a scratch directory, read once by enroll.py, and deleted the
 * moment the job ends — success or failure. What survives is the embedding in
 * data/embeddings.json. The register never stores a photograph of anybody.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIN_PHOTOS = 3;
const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_PROGRESS_LINES = 40;

/** First run downloads the model pack, so this has to be generous. */
const JOB_TIMEOUT_MS = Number(process.env.ENROLL_TIMEOUT_MS || 15 * 60 * 1000);

const jobs = new Map();
let running = null;

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const SIGNATURES = [
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

function looksLikeHeic(buf) {
  // iPhones shoot HEIC by default and OpenCV can't read it. Worth naming,
  // because "that photo didn't work" is useless to someone holding a phone.
  return buf.length > 12 && buf.slice(4, 8).toString('latin1') === 'ftyp'
    && ['heic', 'heix', 'hevc', 'mif1'].includes(buf.slice(8, 12).toString('latin1'));
}

function imageKind(buf) {
  for (const sig of SIGNATURES) {
    if (buf.length >= sig.bytes.length && sig.bytes.every((b, i) => buf[i] === b)) {
      return sig.name;
    }
  }
  return looksLikeHeic(buf) ? 'heic' : null;
}

function fieldError(message, code) {
  return { error: message, code };
}

/**
 * Check the form before anything is written or spawned. Every message here
 * ends up in front of a warden, so none of them mention base64 or MIME types.
 */
function validate(body) {
  const name = String(body?.name ?? '').trim();
  const roomNo = String(body?.room_no ?? '').trim();
  const phone = String(body?.phone ?? '').trim();
  const photos = body?.photos;

  if (!name) return fieldError('Please enter the guest\u2019s name.', 'name_required');
  if (name.length > 80) return fieldError('That name is too long.', 'name_too_long');
  if (!roomNo) return fieldError('Please enter a room number.', 'room_required');
  if (roomNo.length > 12) return fieldError('That room number is too long.', 'room_too_long');
  if (phone.length > 20) return fieldError('That phone number is too long.', 'phone_too_long');
  if (body?.consent !== true) {
    return fieldError(
      'Please tick the box confirming the guest has agreed to face recognition.',
      'consent_required'
    );
  }
  if (!Array.isArray(photos)) return fieldError('Please add some photos.', 'photos_required');
  if (photos.length < MIN_PHOTOS) {
    return fieldError(
      `Please add at least ${MIN_PHOTOS} photos. You added ${photos.length}.`,
      'too_few_photos'
    );
  }
  if (photos.length > MAX_PHOTOS) {
    return fieldError(
      `Please use no more than ${MAX_PHOTOS} photos. You added ${photos.length}.`,
      'too_many_photos'
    );
  }

  const decoded = [];
  let total = 0;

  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i] || {};
    const label = String(photo.filename || `photo ${i + 1}`).slice(0, 60);
    const raw = String(photo.data || '');
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;

    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return fieldError(`${label} could not be read. Try a different photo.`, 'photo_unreadable');
    }
    if (!buf.length) {
      return fieldError(`${label} is empty. Try a different photo.`, 'photo_empty');
    }
    if (buf.length > MAX_PHOTO_BYTES) {
      return fieldError(
        `${label} is too big (${(buf.length / 1048576).toFixed(1)}MB). Photos must be under 8MB each.`,
        'photo_too_large'
      );
    }

    const kind = imageKind(buf);
    if (kind === 'heic') {
      return fieldError(
        `${label} is an iPhone HEIC photo, which this system can\u2019t read. On the iPhone: `
        + 'Settings \u203a Camera \u203a Formats \u203a Most Compatible, then take the photos again. '
        + 'Or share them to yourself over WhatsApp, which converts them to JPG.',
        'photo_heic'
      );
    }
    if (!kind) {
      return fieldError(`${label} isn\u2019t a JPG or PNG photo.`, 'photo_wrong_type');
    }

    total += buf.length;
    if (total > MAX_TOTAL_BYTES) {
      return fieldError('Those photos add up to too much. Try fewer, or smaller ones.', 'photos_too_large');
    }

    decoded.push({ filename: `photo_${i + 1}.${kind === 'png' ? 'png' : 'jpg'}`, buf });
  }

  return { clean: { name, roomNo, phone, photos: decoded } };
}

// --------------------------------------------------------------------------
// Running
// --------------------------------------------------------------------------

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - (job.finished_at_ms || now) > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function publicView(job) {
  return {
    id: job.id,
    status: job.status,
    name: job.name,
    room_no: job.room_no,
    photo_count: job.photo_count,
    started_at: job.started_at,
    finished_at: job.finished_at,
    guest: job.guest,
    error: job.error,
    code: job.code,
    progress: job.progress.slice(-6),
  };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[enroll] could not remove scratch photos: ${err.message}`);
  }
}

/**
 * Start an enrollment. Returns the job, or { error, code } if the form is
 * wrong or another enrollment is already running.
 *
 * One at a time is deliberate: two model loads at once on a mini PC with 8GB
 * will swap, and the warden adding two guests in parallel is not a real case.
 */
function start(body, options = {}) {
  sweep();

  const checked = validate(body);
  if (checked.error) return checked;

  if (running && jobs.get(running)?.status === 'running') {
    return fieldError(
      'Another guest is being added right now. Wait for that to finish, then try again.',
      'busy'
    );
  }

  const { name, roomNo, phone, photos } = checked.clean;
  const dataDir = options.dataDir || require('./db').DATA_DIR;
  const scriptPath = options.scriptPath
    || path.resolve(__dirname, '../../recognition/enroll.py');
  const pythonBin = options.pythonBin || process.env.PYTHON_BIN || 'python3';

  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(dataDir, 'tmp', id);

  let files;
  try {
    fs.mkdirSync(dir, { recursive: true });
    files = photos.map((photo) => {
      const file = path.join(dir, photo.filename);
      fs.writeFileSync(file, photo.buf);
      return file;
    });
  } catch (err) {
    cleanup(dir);
    return fieldError(`Could not save the photos to work on them: ${err.message}`, 'scratch_failed');
  }

  const job = {
    id,
    status: 'running',
    name,
    room_no: roomNo,
    photo_count: files.length,
    started_at: new Date().toISOString(),
    finished_at: null,
    guest: null,
    error: null,
    code: null,
    progress: ['Starting up the face recognition software\u2026'],
    stdout: '',
  };
  jobs.set(id, job);
  running = id;

  const args = [
    scriptPath, '--json',
    '--name', name,
    '--room', roomNo,
    '--consent-given',
    '--photos', ...files,
  ];
  if (phone) args.push('--phone', phone);

  const child = spawn(pythonBin, args, {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  const finish = (patch) => {
    if (job.status !== 'running') return;
    Object.assign(job, patch, {
      finished_at: new Date().toISOString(),
      finished_at_ms: Date.now(),
    });
    if (running === id) running = null;
    cleanup(dir);
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({
      status: 'failed',
      error: 'Adding the guest took too long and was stopped. Try again, and if it keeps '
        + 'happening ask whoever set this up to check the recognition software.',
      code: 'timeout',
    });
  }, JOB_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => {
    job.stdout += chunk.toString();
    if (job.stdout.length > 200_000) job.stdout = job.stdout.slice(-200_000);
  });

  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const text = line.trim();
      if (text) job.progress.push(text.slice(0, 200));
    }
    if (job.progress.length > MAX_PROGRESS_LINES) {
      job.progress = job.progress.slice(-MAX_PROGRESS_LINES);
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    finish({
      status: 'failed',
      error: `Could not start the face recognition software (${err.message}). `
        + 'Ask whoever set this up to check that Python is installed.',
      code: 'spawn_failed',
    });
  });

  child.on('close', () => {
    clearTimeout(timer);
    if (job.status !== 'running') return; // already timed out or failed to spawn

    const line = job.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    let parsed = null;
    try {
      parsed = line ? JSON.parse(line) : null;
    } catch {
      parsed = null;
    }

    if (parsed?.ok) {
      finish({
        status: 'done',
        guest: {
          id: parsed.id,
          name: parsed.name,
          room_no: parsed.room_no,
          photo_count: parsed.photo_count,
        },
      });
    } else if (parsed?.error) {
      finish({ status: 'failed', error: parsed.error, code: parsed.code || 'error' });
    } else {
      const tail = job.progress.slice(-2).join(' ');
      finish({
        status: 'failed',
        error: tail || 'Adding the guest failed, and the reason wasn\u2019t clear. Please try again.',
        code: 'unknown',
      });
    }
  });

  return { job: publicView(job) };
}

function get(id) {
  sweep();
  const job = jobs.get(id);
  return job ? publicView(job) : null;
}

/** Tests only. */
function reset() {
  jobs.clear();
  running = null;
}

module.exports = {
  MIN_PHOTOS,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  validate,
  start,
  get,
  reset,
};
