/**
 * Live view + enrollment job tests. No framework: node backend/server/live-view.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-live-'));
process.env.DATA_DIR = tmp;

const view = require('./live-view');
const enroll = require('./enroll-jobs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  view.reset();
  enroll.reset();
  try {
    fn();
    passed += 1;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function asyncTest(name, fn) {
  return { name, fn };
}

const T0 = 1_000_000;
const frame = (over = {}) => ({
  image: 'aGVsbG8=',
  faces: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, name: 'Asha Kulkarni', known: true, score: 0.71 }],
  width: 480,
  height: 270,
  captured_at: '2026-09-18T10:00:00.000Z',
  ...over,
});

// --------------------------------------------------------------------------
// Backpressure — the whole point of the module
// --------------------------------------------------------------------------

test('nothing is wanted until a browser actually asks', () => {
  assert.strictEqual(view.wanted(T0), false);
  assert.strictEqual(view.put(frame(), T0).wanted, false);
});

test('asking for a frame turns the camera feed on', () => {
  view.take(T0);
  assert.strictEqual(view.wanted(T0), true);
  assert.strictEqual(view.put(frame(), T0).wanted, true);
});

test('walking away from the screen turns it off again', () => {
  view.take(T0);
  assert.strictEqual(view.wanted(T0 + view.VIEWER_TIMEOUT_MS - 1), true);
  assert.strictEqual(view.wanted(T0 + view.VIEWER_TIMEOUT_MS + 1), false);
});

test('the recognition service polling state does not count as watching', () => {
  view.state(T0);
  view.state(T0 + 1000);
  assert.strictEqual(view.wanted(T0 + 2000), false, 'the service must not keep itself awake');
});

test('the switch overrides a watching browser', () => {
  view.take(T0);
  view.put(frame(), T0);
  view.setEnabled(false, T0);

  assert.strictEqual(view.wanted(T0), false);
  assert.strictEqual(view.take(T0).frame, null, 'the held frame is dropped when switched off');
  assert.strictEqual(view.take(T0).reason, 'off');

  view.setEnabled(true, T0);
  view.take(T0);
  assert.strictEqual(view.wanted(T0), true);
});

// --------------------------------------------------------------------------
// Frames
// --------------------------------------------------------------------------

test('a fresh frame comes back, a stale one does not', () => {
  view.put(frame(), T0);
  assert.strictEqual(view.take(T0 + 1000).frame.width, 480);
  assert.strictEqual(view.take(T0 + view.FRAME_TTL_MS + 1).frame, null);
  assert.strictEqual(view.take(T0 + view.FRAME_TTL_MS + 1).reason, 'camera_quiet');
});

test('only the newest frame is kept', () => {
  view.put(frame({ image: 'first' }), T0);
  view.put(frame({ image: 'second' }), T0 + 100);
  assert.strictEqual(view.take(T0 + 200).frame.image, 'second');
});

test('a malformed frame is refused rather than held', () => {
  assert.strictEqual(view.put({ image: '', width: 10, height: 10 }, T0).ok, false);
  assert.strictEqual(view.put({ image: 'x', width: 0, height: 10 }, T0).ok, false);
  assert.strictEqual(view.put({ image: 'x', width: 10, height: -5 }, T0).ok, false);
  assert.strictEqual(view.put(null, T0).ok, false);
  assert.strictEqual(view.take(T0).frame, null);
});

test('an oversized frame is refused', () => {
  const huge = { ...frame(), image: 'a'.repeat(view.MAX_IMAGE_CHARS + 1) };
  assert.strictEqual(view.put(huge, T0).ok, false);
});

test('face boxes are clamped and junk entries dropped', () => {
  view.put(
    frame({
      faces: [
        { x: -3, y: 9, w: 0.5, h: 0.5, name: 'Edge Case', known: true, score: 0.9 },
        { x: 'nonsense', y: 0.1, w: 0.1, h: 0.1 },
        null,
        { x: 0.2, y: 0.2, w: 0.2, h: 0.2, name: 'x'.repeat(500), known: 'yes' },
      ],
    }),
    T0
  );

  const faces = view.take(T0).frame.faces;
  assert.strictEqual(faces.length, 2, 'unreadable boxes are dropped');
  assert.strictEqual(faces[0].x, 0);
  assert.strictEqual(faces[0].y, 1);
  assert.ok(faces[1].name.length <= 60);
  assert.strictEqual(faces[1].known, false, 'known must be a real boolean');
  assert.strictEqual(faces[1].score, null);
});

test('more than a dozen faces cannot blow up the payload', () => {
  const many = Array.from({ length: 40 }, () => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.1, name: 'A' }));
  view.put(frame({ faces: many }), T0);
  assert.ok(view.take(T0).frame.faces.length <= 12);
});

// --------------------------------------------------------------------------
// Enrollment form validation
// --------------------------------------------------------------------------

const jpeg = (size = 200) => {
  const buf = Buffer.alloc(size, 7);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return buf.toString('base64');
};
const png = () => {
  const buf = Buffer.alloc(200, 3);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf.toString('base64');
};
const heic = () => {
  const buf = Buffer.alloc(200, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write('heic', 8, 'latin1');
  return buf.toString('base64');
};

const form = (over = {}) => ({
  name: 'Asha Kulkarni',
  room_no: '204',
  consent: true,
  photos: [{ filename: 'a.jpg', data: jpeg() }, { filename: 'b.jpg', data: jpeg() },
           { filename: 'c.jpg', data: jpeg() }],
  ...over,
});

test('a good form validates', () => {
  const result = enroll.validate(form());
  assert.ok(result.clean, result.error);
  assert.strictEqual(result.clean.photos.length, 3);
});

test('the form insists on a name, a room and consent', () => {
  assert.strictEqual(enroll.validate(form({ name: '  ' })).code, 'name_required');
  assert.strictEqual(enroll.validate(form({ room_no: '' })).code, 'room_required');
  assert.strictEqual(enroll.validate(form({ consent: false })).code, 'consent_required');
});

test('the 3-photo minimum is explained, not just enforced', () => {
  const result = enroll.validate(form({ photos: [{ data: jpeg() }, { data: jpeg() }] }));
  assert.strictEqual(result.code, 'too_few_photos');
  assert.ok(/at least 3/.test(result.error), result.error);
  assert.ok(/You added 2/.test(result.error), result.error);
});

test('too many photos is refused too', () => {
  const nine = Array.from({ length: 9 }, () => ({ data: jpeg() }));
  assert.strictEqual(enroll.validate(form({ photos: nine })).code, 'too_many_photos');
});

test('png is accepted alongside jpg', () => {
  const result = enroll.validate(form({
    photos: [{ data: png() }, { data: jpeg() }, { data: png() }],
  }));
  assert.ok(result.clean, result.error);
  assert.ok(result.clean.photos.some((p) => p.filename.endsWith('.png')));
});

test('an iPhone HEIC photo gets told what to do about it', () => {
  const result = enroll.validate(form({
    photos: [{ filename: 'IMG_0021.HEIC', data: heic() }, { data: jpeg() }, { data: jpeg() }],
  }));
  assert.strictEqual(result.code, 'photo_heic');
  assert.ok(/IMG_0021.HEIC/.test(result.error));
  assert.ok(/Most Compatible/.test(result.error), 'should say how to fix it');
});

test('a file that is not an image at all is refused', () => {
  const result = enroll.validate(form({
    photos: [{ filename: 'notes.txt', data: Buffer.from('hello there').toString('base64') },
             { data: jpeg() }, { data: jpeg() }],
  }));
  assert.strictEqual(result.code, 'photo_wrong_type');
});

test('an empty photo is refused', () => {
  const result = enroll.validate(form({
    photos: [{ data: '' }, { data: jpeg() }, { data: jpeg() }],
  }));
  assert.strictEqual(result.code, 'photo_empty');
});

test('a data-url prefix from the browser is stripped', () => {
  const result = enroll.validate(form({
    photos: [{ data: `data:image/jpeg;base64,${jpeg()}` }, { data: jpeg() }, { data: jpeg() }],
  }));
  assert.ok(result.clean, result.error);
});

test('an oversized photo is refused with a size the warden recognises', () => {
  const big = jpeg(enroll.MAX_PHOTO_BYTES + 1024);
  const result = enroll.validate(form({
    photos: [{ filename: 'huge.jpg', data: big }, { data: jpeg() }, { data: jpeg() }],
  }));
  assert.strictEqual(result.code, 'photo_too_large');
  assert.ok(/MB/.test(result.error));
});

// --------------------------------------------------------------------------
// Running a job — with a stub standing in for enroll.py
// --------------------------------------------------------------------------

const STUBS = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-stub-'));

function stubScript(name, body) {
  const file = path.join(STUBS, name);
  fs.writeFileSync(file, body);
  return file;
}

const OK_SCRIPT = stubScript('ok.py', `
import json, sys
photos = sys.argv[sys.argv.index('--photos') + 1:]
print("reading photos", file=sys.stderr)
print(json.dumps({"ok": True, "id": "guest_1", "name": "Asha Kulkarni",
                  "room_no": "204", "photo_count": len(photos)}))
`);

const FAIL_SCRIPT = stubScript('fail.py', `
import json
print(json.dumps({"ok": False, "code": "duplicate_person",
                  "error": "These photos look like someone already on the list: Rohit."}))
raise SystemExit(1)
`);

const CRASH_SCRIPT = stubScript('crash.py', `
import sys
print("Traceback (most recent call last):", file=sys.stderr)
print("MemoryError", file=sys.stderr)
raise SystemExit(1)
`);

function waitFor(jobId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const job = enroll.get(jobId);
      if (job && job.status !== 'running') return resolve(job);
      if (Date.now() - started > timeoutMs) return reject(new Error('job never finished'));
      return setTimeout(tick, 25);
    };
    tick();
  });
}

const ASYNC = [
  asyncTest('a successful enrollment reports the new guest', async () => {
    const { job, error } = enroll.start(form(), { dataDir: tmp, scriptPath: OK_SCRIPT });
    assert.ok(job, error);
    assert.strictEqual(job.status, 'running');

    const done = await waitFor(job.id);
    assert.strictEqual(done.status, 'done', done.error);
    assert.strictEqual(done.guest.name, 'Asha Kulkarni');
    assert.strictEqual(done.guest.photo_count, 3, 'all three photos reached the script');
  }),

  asyncTest('the photos are deleted once the job ends', async () => {
    const { job } = enroll.start(form(), { dataDir: tmp, scriptPath: OK_SCRIPT });
    await waitFor(job.id);
    const scratch = path.join(tmp, 'tmp', job.id);
    assert.strictEqual(fs.existsSync(scratch), false, 'guest photos must not linger on disk');
  }),

  asyncTest('a refusal from enroll.py reaches the warden in its own words', async () => {
    const { job } = enroll.start(form(), { dataDir: tmp, scriptPath: FAIL_SCRIPT });
    const done = await waitFor(job.id);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.code, 'duplicate_person');
    assert.ok(/already on the list/.test(done.error));
  }),

  asyncTest('a crash still produces something readable, and cleans up', async () => {
    const { job } = enroll.start(form(), { dataDir: tmp, scriptPath: CRASH_SCRIPT });
    const done = await waitFor(job.id);
    assert.strictEqual(done.status, 'failed');
    assert.ok(done.error && done.error.length > 0);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'tmp', job.id)), false);
  }),

  asyncTest('a missing python interpreter is explained, not swallowed', async () => {
    const { job } = enroll.start(form(), {
      dataDir: tmp, scriptPath: OK_SCRIPT, pythonBin: 'python-that-does-not-exist',
    });
    const done = await waitFor(job.id);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.code, 'spawn_failed');
  }),

  asyncTest('two enrollments at once is refused, and allowed again afterwards', async () => {
    const first = enroll.start(form(), { dataDir: tmp, scriptPath: OK_SCRIPT });
    const second = enroll.start(form({ name: 'Rohit Deshmukh' }), {
      dataDir: tmp, scriptPath: OK_SCRIPT,
    });
    assert.strictEqual(second.code, 'busy');
    assert.ok(/Wait for that to finish/.test(second.error));

    await waitFor(first.job.id);
    const third = enroll.start(form({ name: 'Rohit Deshmukh' }), {
      dataDir: tmp, scriptPath: OK_SCRIPT,
    });
    assert.ok(third.job, third.error);
    await waitFor(third.job.id);
  }),

  asyncTest('an unknown job id is not an error, just nothing', async () => {
    assert.strictEqual(enroll.get('job_nope'), null);
  }),
];

(async () => {
  for (const { name, fn } of ASYNC) {
    view.reset();
    enroll.reset();
    try {
      await fn();
      passed += 1;
      console.log(`  pass  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${name}: ${err.message}`);
    }
  }

  console.log(`\n${passed}/${passed + failed} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(STUBS, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
