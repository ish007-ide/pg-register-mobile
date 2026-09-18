/**
 * Route contract tests for index.js.
 *
 * The container has no network, so express can't be installed here. Rather
 * than leave the HTTP layer untested, this stubs the sliver of express the
 * server actually uses (get/post/use, req.body, req.query, res.status/json)
 * and drives the real handlers from index.js.
 *
 * Once you've run `npm install` on the mini PC, this still works — and the
 * stub is only used if express is genuinely missing.
 *
 *   node backend/server/routes.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --------------------------------------------------------------------------
// express / cors stub
// --------------------------------------------------------------------------

function makeApp() {
  const routes = { GET: [], POST: [] };
  const middleware = [];

  const register = (method) => (routePath, ...handlers) => {
    routes[method].push({ routePath, handlers });
  };

  const app = {
    routes,
    middleware,
    get: register('GET'),
    post: register('POST'),
    use: (fn) => middleware.push(fn),
    listen: () => {},
  };
  return app;
}

function matchRoute(routePath, actual) {
  const a = routePath.split('/');
  const b = actual.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/** Drive one request through the real handler chain. */
function request(app, method, url, { body = {}, headers = {} } = {}) {
  const [rawPath, qs] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));

  const req = {
    method,
    path: rawPath,
    body,
    query,
    params: {},
    get: (h) => headers[h] ?? headers[h.toLowerCase()],
  };

  const out = { status: 200, body: null };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
  };

  for (const mw of app.middleware) {
    if (mw.length >= 3) mw(req, res, () => {});
  }

  for (const route of app.routes[method]) {
    const params = matchRoute(route.routePath, rawPath);
    if (!params) continue;
    req.params = params;
    let i = 0;
    const next = () => {
      const h = route.handlers[i];
      i += 1;
      if (h) h(req, res, next);
    };
    next();
    return out;
  }

  // fall through to the 404 middleware registered with app.use(handler)
  const notFound = app.middleware.find((m) => m.length === 2);
  if (notFound) notFound(req, res);
  return out;
}

// --------------------------------------------------------------------------
// Install the stub, then load the real server
// --------------------------------------------------------------------------

let app;
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

try {
  require.resolve('express');
  console.log('using the installed express');
} catch {
  Module._load = function patched(requested, parent, isMain) {
    if (requested === 'express') {
      const express = () => {
        app = makeApp();
        return app;
      };
      express.json = () => (req, _res, next) => next && next();
      return express;
    }
    if (requested === 'cors') return () => (req, _res, next) => next && next();
    return origLoad.apply(this, [requested, parent, isMain]);
  };
  console.log('express not installed — using the built-in stub');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-routes-'));
process.env.DATA_DIR = tmp;
process.env.DAY_RESET_HOUR = '4';
process.env.SERVICE_TOKEN = 'secret123';

require('./index');
Module._load = origLoad;
Module._resolveFilename = origResolve;

const GUESTS = [
  { id: 'g1', name: 'Asha Kulkarni', room_no: '204' },
  { id: 'g2', name: 'Rohit Deshmukh', room_no: '101' },
];

let passed = 0;
let failed = 0;
const AUTH = { headers: { 'X-Service-Token': 'secret123' } };

function test(name, fn) {
  fs.writeFileSync(path.join(tmp, 'guests.json'), JSON.stringify(GUESTS));
  fs.writeFileSync(path.join(tmp, 'logs.json'), '[]');
  fs.writeFileSync(path.join(tmp, 'unknown.json'), '[]');
  try {
    fn();
    passed += 1;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const GET = (url) => request(app, 'GET', url);
const POST = (url, body, opts = AUTH) => request(app, 'POST', url, { body, ...opts });

// --------------------------------------------------------------------------

test('GET /api/health reports config', () => {
  const r = GET('/api/health');
  eq(r.status, 200);
  eq(r.body.ok, true);
  eq(r.body.day_reset_hour, 4);
});

test('GET /api/guests returns the roster with status and no biometrics', () => {
  const r = GET('/api/guests');
  eq(r.status, 200);
  eq(r.body.length, 2);
  eq(r.body[0].room_no, '101');
  eq(r.body[0].status, 'in');
  eq('embeddings' in r.body[0], false);
});

test('GET /api/guests/:id returns history, 404s when missing', () => {
  POST('/api/logs', { guest_id: 'g1', direction: 'out' });
  const r = GET('/api/guests/g1');
  eq(r.status, 200);
  eq(r.body.name, 'Asha Kulkarni');
  eq(r.body.logs.length, 1);
  eq(GET('/api/guests/nope').status, 404);
});

test('POST /api/logs creates a movement', () => {
  const r = POST('/api/logs', { guest_id: 'g1', confidence: 0.58, event_id: 'e1' });
  eq(r.status, 201);
  eq(r.body.log.direction, 'out');
  eq(r.body.duplicate, false);
});

test('POST /api/logs is idempotent on event_id', () => {
  POST('/api/logs', { guest_id: 'g1', event_id: 'e1' });
  const again = POST('/api/logs', { guest_id: 'g1', event_id: 'e1' });
  eq(again.status, 200, 'replay returns 200, not 201');
  eq(again.body.duplicate, true);
  eq(GET('/api/logs').body.length, 1);
});

test('POST /api/logs rejects a missing guest_id', () => {
  eq(POST('/api/logs', {}).status, 400);
});

test('POST /api/logs rejects a nonsense direction', () => {
  const r = POST('/api/logs', { guest_id: 'g1', direction: 'sideways' });
  eq(r.status, 400);
});

test('POST /api/logs rejects a manual entry with no direction', () => {
  const r = POST('/api/logs', { guest_id: 'g1', source: 'manual' });
  eq(r.status, 400);
});

test('POST /api/logs 404s on an unknown guest', () => {
  eq(POST('/api/logs', { guest_id: 'ghost' }).status, 404);
});

test('POST /api/logs needs the service token', () => {
  const r = POST('/api/logs', { guest_id: 'g1' }, { headers: {} });
  eq(r.status, 401);
  eq(GET('/api/logs').body.length, 0, 'nothing written on a rejected request');
});

test('GET /api/logs filters by guest and rejects a bad date', () => {
  POST('/api/logs', { guest_id: 'g1' });
  POST('/api/logs', { guest_id: 'g2' });
  eq(GET('/api/logs').body.length, 2);
  eq(GET('/api/logs?guest_id=g1').body.length, 1);
  eq(GET('/api/logs?limit=1').body.length, 1);
  eq(GET('/api/logs?date=tuesday').status, 400);
});

test('GET /api/summary counts in and out', () => {
  POST('/api/logs', { guest_id: 'g1', direction: 'out' });
  const s = GET('/api/summary').body;
  eq(s.total_guests, 2);
  eq(s.currently_out, 1);
  eq(s.currently_in, 1);
  eq(s.movements_today, 1);
});

test('unknown faces post separately and stay out of the register', () => {
  const r = POST('/api/unknown', { event_id: 'u1', best_score: 0.3, reason: 'below_threshold' });
  eq(r.status, 201);
  eq(GET('/api/unknown').body.length, 1);
  eq(GET('/api/logs').body.length, 0);
});

test('an unrouted path 404s as JSON', () => {
  const r = GET('/api/nonsense');
  eq(r.status, 404);
  eq(typeof r.body.error, 'string');
});

console.log(`\n${passed}/${passed + failed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
