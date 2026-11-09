'use strict';
// Run with: npm test   (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { drawAssignments, validateAssignments } = require('../lib/draw');

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

test('every draw is a valid one-to-one matching', () => {
  for (const n of [2, 3, 4, 5, 8, 12, 13, 40]) {
    for (let run = 0; run < 400; run++) {
      const people = ids(n);
      const assignments = drawAssignments(people);
      assert.deepStrictEqual(
        validateAssignments(people, assignments), [],
        `n=${n} run=${run} produced an invalid draw`
      );
    }
  }
});

test('nobody ever draws themselves', () => {
  for (let run = 0; run < 2000; run++) {
    for (const [giver, receiver] of Object.entries(drawAssignments(ids(6)))) {
      assert.notStrictEqual(giver, receiver);
    }
  }
});

test('nobody is bought for twice', () => {
  for (let run = 0; run < 2000; run++) {
    const receivers = Object.values(drawAssignments(ids(7)));
    assert.strictEqual(new Set(receivers).size, receivers.length);
  }
});

test('the draw forms a single gifting circle', () => {
  const people = ids(10);
  const assignments = drawAssignments(people);
  let current = people[0];
  const visited = new Set();
  do { visited.add(current); current = assignments[current]; } while (current !== people[0]);
  assert.strictEqual(visited.size, people.length, 'expected one circle covering everyone');
});

test('refuses impossible pools', () => {
  assert.throws(() => drawAssignments([]), /at least 2/);
  assert.throws(() => drawAssignments(['solo']), /at least 2/);
  assert.throws(() => drawAssignments(['a', 'a']), /duplicate/);
});

test('validateAssignments catches a bad matching', () => {
  const problems = validateAssignments(['a', 'b', 'c'], { a: 'a', b: 'c', c: 'c' });
  assert.ok(problems.some((p) => /drew themselves/.test(p)));
  assert.ok(problems.some((p) => /more than once/.test(p)));
});
