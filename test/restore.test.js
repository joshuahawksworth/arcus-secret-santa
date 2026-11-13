'use strict';
// Export and restore through the API, against a file store in a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { Store } = require('../lib/store');
const { createApi } = require('../lib/api');

const TOKEN = 'test-admin';

function call(api, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: 'x', 'x-admin-token': TOKEN };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) { resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null }); },
    };
    api(req, res);
  });
}

test('export then restore puts the pool back exactly, tokens and all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'santa-'));
  const store = new Store(path.join(dir, 'pool.json'));
  const api = createApi({ store, adminToken: TOKEN, revealDate: () => new Date('2099-01-01') });

  const a = await store.addParticipant({ name: 'Ann', hint: 'tea', answers: [{ q: 'q', a: 'a' }] });
  const b = await store.addParticipant({ name: 'Bob', hint: '', answers: [] });

  const exp = await call(api, 'GET', '/api/admin/export');
  assert.strictEqual(exp.status, 200);
  assert.strictEqual(exp.body.pool.participants.length, 2);
  assert.ok(exp.body.pool.participants.every((p) => p.token), 'tokens included');

  // Things go wrong after the snapshot...
  await store.removeParticipant(b.id);
  await store.addParticipant({ name: 'Intruder', hint: '', answers: [] });
  await store.updateParticipant(a.id, { hint: 'changed' });

  const res = await call(api, 'POST', '/api/admin/restore', exp.body);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.participants, 2);

  const reread = new Store(path.join(dir, 'pool.json'));
  assert.deepStrictEqual(reread.state.participants.map((p) => p.name), ['Ann', 'Bob']);
  assert.strictEqual(reread.findById(a.id).hint, 'tea');
  assert.ok(reread.authenticate(b.id, b.token), 'Bob can still sign in with his old token');
});

test('restore refuses something that is not an export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'santa-'));
  const store = new Store(path.join(dir, 'pool.json'));
  const api = createApi({ store, adminToken: TOKEN });
  assert.strictEqual((await call(api, 'POST', '/api/admin/restore', { hello: 1 })).status, 400);
  assert.strictEqual((await call(api, 'POST', '/api/admin/restore', { participants: [{ name: 'x' }] })).status, 400);
});
