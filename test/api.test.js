import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { EXAMPLE_REQUEST, EXAMPLE_CONFLICT_REQUEST } from '../src/example.js';

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('GET /health returns ok with store info', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.equal(body.store.max, 100);
});

test('GET / returns service metadata', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'config-merge-rehearsal-api');
});

test('GET /api/v1/example returns a usable example payload', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/example' });
  assert.equal(res.statusCode, 200);
  const { mergeRequest } = res.json();
  assert.ok(mergeRequest.base && mergeRequest.patchA && mergeRequest.patchB);
});

test('POST /api/v1/merges with the example payload merges cleanly (200)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: EXAMPLE_REQUEST,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'clean');
  assert.deepEqual(body.merged, {
    app: 'payment-service',
    replicas: 3,
    servers: [
      { host: 'a2.internal', port: 8080 },
      { host: 'b2.internal', port: 9090 },
      { host: 'b.internal', port: 8080 },
    ],
    features: { cache: true, tracing: true, retries: 3 },
    tags: ['stable'],
  });
  assert.equal(body.stats.deduplicated, 1); // identical /features/tracing replace
  assert.ok(body.id);

  // stored record is retrievable
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${body.id}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().id, body.id);
  assert.deepEqual(fetched.json().base, EXAMPLE_REQUEST.base);
});

test('POST /api/v1/merges with conflicting patches returns 409 with structured conflicts', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: EXAMPLE_CONFLICT_REQUEST,
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.merged, null);
  assert.equal(body.conflicts.length, 2);

  const byReason = Object.fromEntries(body.conflicts.map((c) => [c.reason, c]));
  assert.equal(byReason['delete-vs-modify'].path, '/database');
  assert.deepEqual(
    byReason['delete-vs-modify'].operations.map((o) => [o.side, o.index]),
    [
      ['A', 0],
      ['B', 0],
    ],
  );
  assert.equal(byReason['replace-mismatch'].path, '/mode');
  assert.deepEqual(
    byReason['replace-mismatch'].operations.map((o) => [o.side, o.index]),
    [
      ['A', 1],
      ['B', 1],
    ],
  );
});

test('POST /api/v1/merges rejects unsupported ops (400)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: {
      base: {},
      patchA: [{ op: 'move', from: '/a', path: '/b' }],
      patchB: [],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/v1/merges rejects malformed bodies (400)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: { base: {}, patchA: [] },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/v1/merges with a patch that does not apply to base returns 422', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: {
      base: { a: 1 },
      patchA: [{ op: 'remove', path: '/nope' }],
      patchB: [],
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INVALID_PATCH');
  assert.equal(body.details.side, 'A');
  assert.equal(body.details.index, 0);
});

test('list, fetch and delete rehearsals', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: { base: { x: 1 }, patchA: [], patchB: [] },
  });
  const { id } = created.json();

  const list = await app.inject({ method: 'GET', url: '/api/v1/merges' });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((item) => item.id === id));

  const del = await app.inject({ method: 'DELETE', url: `/api/v1/merges/${id}` });
  assert.equal(del.statusCode, 204);

  const gone = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}` });
  assert.equal(gone.statusCode, 404);
});

test('unknown routes return JSON 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});
