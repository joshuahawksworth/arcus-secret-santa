'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRevealDate } = require('../lib/api');

test('reveal date takes a day, or a day and a time', () => {
  assert.strictEqual(parseRevealDate('2026-11-27T15:00Z').toISOString(), '2026-11-27T15:00:00.000Z');
  assert.strictEqual(parseRevealDate('2026-11-27T15:00:00+00:00').toISOString(), '2026-11-27T15:00:00.000Z');
  assert.ok(parseRevealDate('2026-11-27'), 'a bare day still works');
  assert.strictEqual(parseRevealDate('not a date'), null);
  assert.strictEqual(parseRevealDate(''), null);
});
