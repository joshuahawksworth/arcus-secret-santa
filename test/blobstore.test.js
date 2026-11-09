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

  const keys = [...fake.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
  assert.strictEqual(keys.length, 4, 'one current version per document');
  assert.ok(keys.some((k) => k.startsWith(`${prefix}/draw/`)));
  for (const id of [ann.id, bob.id, cat.id]) assert.ok(keys.some((k) => k.startsWith(`${prefix}/people/${id}/`)));

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

  const pathsFor = (id) => [...fake.blobs.keys()].filter((k) => k.startsWith(`${prefix}/people/${id}/`));
  const annBefore = pathsFor(ann.id);
  const bobBefore = pathsFor(bob.id);
  await s.updateParticipant(bob.id, { hint: 'new' });
  assert.deepStrictEqual(pathsFor(ann.id), annBefore, 'Ann untouched');
  const bobAfter = pathsFor(bob.id);
  assert.strictEqual(bobAfter.length, 1, 'old version of Bob deleted');
  assert.notStrictEqual(bobAfter[0], bobBefore[0], 'Bob written to a new URL, never overwritten');

  await s.removeParticipant(bob.id);
  assert.strictEqual(pathsFor(bob.id).length, 0);
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
  const after = [...fake.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
  assert.strictEqual(after.length, 3);
  assert.ok(!after.includes(`${prefix}/pool.json`), 'legacy blob removed');
  assert.ok(after.some((k) => k.startsWith(`${prefix}/draw/`)));
  assert.ok(after.some((k) => k.startsWith(`${prefix}/people/p1/`)));

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

test('the flat per-person layout is converted to versioned documents on first read', async () => {
  const prefix = 'pool-flat';
  fake.blobs.set(`${prefix}/people/p1.json`, JSON.stringify({ id: 'p1', token: 't', code: 'CCCCCC', name: 'Flat One', hint: '', answers: [], joinedAt: '2025-01-01T00:00:00Z' }));
  fake.blobs.set(`${prefix}/draw.json`, JSON.stringify({ assignments: null, drawnAt: null, seenBy: {}, settings: { revealDate: '2030-01-01' } }));

  const s = await fresh(prefix);
  assert.deepStrictEqual(s.state.participants.map((p) => p.name), ['Flat One']);
  assert.strictEqual(s.state.settings.revealDate, '2030-01-01');
  const keys = [...fake.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
  assert.ok(!keys.includes(`${prefix}/people/p1.json`) && !keys.includes(`${prefix}/draw.json`), 'flat files replaced');
  assert.ok(keys.some((k) => k.startsWith(`${prefix}/people/p1/`)) && keys.some((k) => k.startsWith(`${prefix}/draw/`)));
});

test('a stale CDN cannot hand back an old draw: every write is a brand-new URL', async () => {
  const prefix = 'pool-versions';
  const s = await fresh(prefix);
  const a = await s.addParticipant({ name: 'A', hint: '', answers: [] });
  const b = await s.addParticipant({ name: 'B', hint: '', answers: [] });
  const drawPaths = () => [...fake.blobs.keys()].filter((k) => k.startsWith(`${prefix}/draw/`));
  const v1 = drawPaths();
  await s.setAssignments({ [a.id]: b.id, [b.id]: a.id });
  const v2 = drawPaths();
  assert.strictEqual(v2.length, 1);
  assert.notStrictEqual(v2[0], v1[0]);
  await s.clearAssignments();
  const v3 = drawPaths();
  assert.strictEqual(v3.length, 1);
  assert.notStrictEqual(v3[0], v2[0]);
});
