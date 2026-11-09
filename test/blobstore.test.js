'use strict';
// The per-person Blob layout, against a local stand-in for the Blob API
// (test/fake-blob.js), so it runs with no credentials:  npm test
const test = require('node:test');
const assert = require('node:assert');
const { startFakeBlob } = require('./fake-blob');

let fake;
let BlobStore;

test.before(async () => {
  fake = await startFakeBlob();
  process.env.BLOB_API_URL = fake.url;
  ({ BlobStore } = require('../lib/blobstore'));
});
test.after(() => fake.close());

const fresh = (prefix) => {
  const s = new BlobStore({ token: 'test', prefix });
  return s.load().then(() => s);
};

test('each person is their own blob, the draw another, and a new instance sees all of it', async () => {
  const prefix = 'pool-a';
  const a = await fresh(prefix);
  assert.strictEqual(a.state.participants.length, 0);

  const ann = await a.addParticipant({ name: 'Ann', hint: 'tea', answers: [] });
  const bob = await a.addParticipant({ name: 'Bob', hint: '', answers: [{ q: 'q', a: 'a' }] });
  const cat = await a.addParticipant({ name: 'Cat', hint: '', answers: [] });
  await a.setAssignments({ [ann.id]: bob.id, [bob.id]: cat.id, [cat.id]: ann.id });

  assert.deepStrictEqual([...fake.blobs.keys()].sort(), [
    `${prefix}/draw.json`,
    `${prefix}/people/${ann.id}.json`,
    `${prefix}/people/${bob.id}.json`,
    `${prefix}/people/${cat.id}.json`,
  ].sort());

  const b = await fresh(prefix);               // another serverless invocation
  assert.deepStrictEqual(b.state.participants.map((p) => p.name), ['Ann', 'Bob', 'Cat']);
  assert.strictEqual(b.state.assignments[ann.id], bob.id);
  assert.strictEqual(b.signIn('ann', ann.code).id, ann.id);
  assert.strictEqual(b.authenticate(bob.id, bob.token).name, 'Bob');
});

test('two instances editing different people at once do not clobber each other', async () => {
  const prefix = 'pool-b';
  const seed = await fresh(prefix);
  const ann = await seed.addParticipant({ name: 'Ann', hint: '', answers: [] });
  const bob = await seed.addParticipant({ name: 'Bob', hint: '', answers: [] });

  const x = await fresh(prefix);
  const y = await fresh(prefix);
  await Promise.all([
    x.updateParticipant(ann.id, { hint: 'coffee' }),
    y.updateParticipant(bob.id, { hint: 'socks' }),
    x.addParticipant({ name: 'Dan', hint: '', answers: [] }),
    y.addParticipant({ name: 'Eve', hint: '', answers: [] }),
  ]);

  const z = await fresh(prefix);
  assert.strictEqual(z.findById(ann.id).hint, 'coffee');
  assert.strictEqual(z.findById(bob.id).hint, 'socks');
  assert.deepStrictEqual(z.state.participants.map((p) => p.name).sort(), ['Ann', 'Bob', 'Dan', 'Eve']);
});

test('save() writes only what changed, and removing someone deletes their blob', async () => {
  const prefix = 'pool-c';
  const s = await fresh(prefix);
  const ann = await s.addParticipant({ name: 'Ann', hint: '', answers: [] });
  const bob = await s.addParticipant({ name: 'Bob', hint: '', answers: [] });

  const before = new Map([...fake.blobs]);
  await s.updateParticipant(bob.id, { hint: 'new' });
  assert.strictEqual(fake.blobs.get(`${prefix}/people/${ann.id}.json`), before.get(`${prefix}/people/${ann.id}.json`), 'Ann untouched');
  assert.notStrictEqual(fake.blobs.get(`${prefix}/people/${bob.id}.json`), before.get(`${prefix}/people/${bob.id}.json`), 'Bob rewritten');

  await s.removeParticipant(bob.id);
  assert.ok(!fake.blobs.has(`${prefix}/people/${bob.id}.json`));
  const t = await fresh(prefix);
  assert.deepStrictEqual(t.state.participants.map((p) => p.name), ['Ann']);

  await t.emptyPool();
  assert.ok(![...fake.blobs.keys()].some((k) => k.startsWith(`${prefix}/people/`)));
});

test('a single-blob pool is split into the per-person layout on first read', async () => {
  const prefix = 'pool-legacy';
  const legacy = {
    participants: [
      { id: 'p1', token: 't1', code: 'AAAAAA', name: 'Old One', hint: '', answers: [], joinedAt: '2025-01-01T00:00:00Z' },
      { id: 'p2', token: 't2', code: 'BBBBBB', name: 'Old Two', hint: 'x', answers: [], joinedAt: '2025-01-02T00:00:00Z' },
    ],
    assignments: { p1: 'p2', p2: 'p1' },
    drawnAt: '2025-12-01T00:00:00Z',
    seenBy: {},
  };
  fake.blobs.set(`${prefix}/pool.json`, JSON.stringify(legacy));

  const s = await fresh(prefix);
  assert.deepStrictEqual(s.state.participants.map((p) => p.name), ['Old One', 'Old Two']);
  assert.strictEqual(s.state.assignments.p1, 'p2');
  assert.deepStrictEqual([...fake.blobs.keys()].filter((k) => k.startsWith(prefix)).sort(), [
    `${prefix}/draw.json`, `${prefix}/people/p1.json`, `${prefix}/people/p2.json`,
  ]);

  const t = await fresh(prefix);               // and it stays that way
  assert.strictEqual(t.state.participants.length, 2);
  assert.strictEqual(t.signIn('old two', 'BBBBBB').id, 'p2');
});

test('list pagination is followed across pages', async () => {
  const prefix = 'pool-many';
  const s = await fresh(prefix);
  for (let i = 0; i < 7; i++) await s.addParticipant({ name: `P${i}`, hint: '', answers: [] });
  const t = await fresh(prefix);               // the fake serves 2 per page
  assert.strictEqual(t.state.participants.length, 7);
});
