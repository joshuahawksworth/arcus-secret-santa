'use strict';

/**
 * Builds the Secret Santa assignments.
 *
 * Uses Sattolo's algorithm, which produces a uniformly random cyclic
 * permutation of the participants. That gives us three guarantees for free:
 *
 *   1. Every person gives exactly one gift  (it is a function over all ids)
 *   2. Every person receives exactly one gift (it is a bijection, so no id
 *      can appear as a receiver twice)
 *   3. Nobody draws themselves (a cyclic permutation has no fixed points)
 *
 * The result is one big gifting circle: A -> B -> C -> ... -> A.
 *
 * @param {string[]} ids participant ids, at least 2
 * @returns {Record<string,string>} map of giverId -> receiverId
 */
function drawAssignments(ids) {
  if (!Array.isArray(ids)) throw new TypeError('ids must be an array');
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new Error('duplicate participant ids');
  if (unique.length < 2) throw new Error('need at least 2 participants to draw');

  // Sattolo's algorithm: walk from the end, swapping with a strictly
  // earlier index. Unlike Fisher-Yates this can never leave an element
  // in its own slot, so no self-assignment is possible.
  const order = unique.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i); // 0 <= j < i  (never j === i)
    [order[i], order[j]] = [order[j], order[i]];
  }

  // `order` is now a single cycle. Each person gives to the next one along,
  // and the last person closes the loop back to the first.
  const assignments = {};
  for (let i = 0; i < order.length; i++) {
    assignments[order[i]] = order[(i + 1) % order.length];
  }
  return assignments;
}

/**
 * Re-checks a set of assignments against the hard rules, so a bad draw can
 * never be written to disk. Returns a list of human readable problems.
 */
function validateAssignments(ids, assignments) {
  const problems = [];
  const givers = Object.keys(assignments);
  const receivers = Object.values(assignments);

  if (givers.length !== ids.length) {
    problems.push(`${givers.length} givers for ${ids.length} participants`);
  }
  for (const id of ids) {
    if (!(id in assignments)) problems.push(`${id} was not given anyone to buy for`);
  }
  for (const [giver, receiver] of Object.entries(assignments)) {
    if (giver === receiver) problems.push(`${giver} drew themselves`);
    if (!ids.includes(receiver)) problems.push(`${receiver} is not in the pool`);
  }
  const seen = new Set();
  for (const receiver of receivers) {
    if (seen.has(receiver)) problems.push(`${receiver} is being bought for more than once`);
    seen.add(receiver);
  }
  for (const id of ids) {
    if (!seen.has(id)) problems.push(`nobody is buying for ${id}`);
  }
  return problems;
}

module.exports = { drawAssignments, validateAssignments };
