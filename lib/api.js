'use strict';

/**
 * The JSON API, as a plain (req, res) handler so the same code runs under the
 * zero-dependency Node server (server.js) and as a Vercel function (api/).
 *
 * The store is loaded afresh at the start of every request, so several
 * processes (or serverless instances) can share one pool safely enough for a
 * team-sized Secret Santa.
 */

const crypto = require('crypto');
const { drawAssignments, validateAssignments } = require('./draw');

// --- tiny http helpers ------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(Buffer.byteLength(payload)));
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function readJsonBody(req, limit = 64 * 1024) {
  // Some runtimes have already parsed the body for us.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return Promise.resolve(req.body ? JSON.parse(req.body) : {}); }
      catch { return Promise.reject(Object.assign(new Error('body was not valid JSON'), { status: 400 })); }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return Promise.resolve(req.body.length ? JSON.parse(req.body.toString('utf8')) : {}); }
      catch { return Promise.reject(Object.assign(new Error('body was not valid JSON'), { status: 400 })); }
    }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('body was not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sanitiseAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers
    .slice(0, 20)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      q: String(item.q || '').slice(0, 300),
      a: String(item.a || '').slice(0, 500),
    }))
    .filter((item) => item.a.trim().length > 0);
}

function privatePerson(p) {
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    hint: p.hint,
    answers: p.answers,
    joinedAt: p.joinedAt,
    updatedAt: p.updatedAt || p.joinedAt,
  };
}

function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// --- reveal date ------------------------------------------------------------

/** 1st December, 00:00 in the server's own timezone, unless REVEAL_DATE says otherwise. */
function defaultRevealDate() {
  const override = process.env.REVEAL_DATE;
  if (override) {
    const parsed = new Date(`${override}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    console.warn(`REVEAL_DATE="${override}" is not a valid YYYY-MM-DD date, ignoring it`);
  }
  return new Date(new Date().getFullYear(), 11, 1, 0, 0, 0, 0);
}

// --- the api ----------------------------------------------------------------

/**
 * @param {object} options
 *   store        a Store (see store.js / blobstore.js)
 *   revealDate   () => Date
 *   adminToken   string, or empty to switch the admin endpoints off
 * @returns {(req, res) => Promise<void>}
 */
function createApi({ store, revealDate = defaultRevealDate, adminToken = process.env.ADMIN_TOKEN || '' }) {
  const isRevealTime = () => Date.now() >= revealDate().getTime();

  async function performDraw(ids) {
    const assignments = drawAssignments(ids);
    const problems = validateAssignments(ids, assignments);
    if (problems.length) {
      throw new Error(`refusing to save an invalid draw: ${problems.join('; ')}`);
    }
    await store.setAssignments(assignments);
    console.log(`drew ${ids.length} names at ${new Date().toISOString()}`);
    return assignments;
  }

  /**
   * Once the reveal date arrives the pool closes and the names are drawn, once.
   * Called before anything that reads assignments so nobody has to press a
   * button on the morning of the 1st.
   */
  async function drawIfDue() {
    if (store.isDrawn || !isRevealTime()) return;
    const ids = store.state.participants.map((p) => p.id);
    if (ids.length < 2) return;
    await performDraw(ids);
  }

  async function publicState() {
    await drawIfDue();
    const people = store.state.participants;
    return {
      revealDate: revealDate().toISOString(),
      revealed: isRevealTime() && store.isDrawn,
      revealTime: isRevealTime(),
      drawn: store.isDrawn,
      poolOpen: !store.isDrawn,
      count: people.length,
      even: people.length % 2 === 0,
      participants: people.map((p) => ({ id: p.id, name: p.name, hasHint: Boolean(p.hint) })),
    };
  }

  function isAdmin(req, url) {
    if (!adminToken) return false;
    const supplied = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
    return constantTimeEqual(adminToken, supplied);
  }

  async function route(req, res, url) {
    const key = `${req.method} ${url.pathname}`;

    switch (key) {
      case 'GET /api/state':
        return sendJson(res, 200, await publicState());

      case 'POST /api/join': {
        await drawIfDue();
        if (store.isDrawn) {
          return sendJson(res, 409, { error: 'The names have already been drawn, the pool is closed.' });
        }
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim().replace(/\s+/g, ' ');
        if (name.length < 2 || name.length > 40) {
          return sendJson(res, 400, { error: 'Please give a name between 2 and 40 characters.' });
        }
        if (store.findByName(name)) {
          return sendJson(res, 409, { error: `${name} is already in the pool.` });
        }
        const hint = String(body.hint || '').slice(0, 500);
        const answers = sanitiseAnswers(body.answers);
        const person = await store.addParticipant({ name, hint, answers });
        return sendJson(res, 201, { ...privatePerson(person), token: person.token });
      }

      case 'POST /api/signin': {
        const body = await readJsonBody(req);
        const person = store.signIn(body.name, body.code);
        if (!person) {
          return sendJson(res, 404, { error: 'That name and elf code do not match anyone in the pool.' });
        }
        return sendJson(res, 200, { ...privatePerson(person), token: person.token });
      }

      case 'GET /api/me': {
        const person = store.authenticate(url.searchParams.get('id'), url.searchParams.get('token'));
        if (!person) return sendJson(res, 404, { error: 'We do not recognise you.' });
        return sendJson(res, 200, privatePerson(person));
      }

      case 'POST /api/me': {
        const body = await readJsonBody(req);
        const person = store.authenticate(body.id, body.token);
        if (!person) return sendJson(res, 404, { error: 'We do not recognise you.' });

        let name;
        if (body.name !== undefined) {
          name = String(body.name).trim().replace(/\s+/g, ' ');
          if (name.length < 2 || name.length > 40) {
            return sendJson(res, 400, { error: 'Please give a name between 2 and 40 characters.' });
          }
          const clash = store.findByName(name);
          if (clash && clash.id !== person.id) {
            return sendJson(res, 409, { error: `${name} is already in the pool.` });
          }
        }

        await store.updateParticipant(person.id, {
          name,
          hint: body.hint === undefined ? undefined : String(body.hint).slice(0, 500),
          answers: body.answers === undefined ? undefined : sanitiseAnswers(body.answers),
        });
        return sendJson(res, 200, privatePerson(store.findById(person.id)));
      }

      case 'POST /api/leave': {
        const body = await readJsonBody(req);
        const person = store.authenticate(body.id, body.token);
        if (!person) return sendJson(res, 404, { error: 'We do not recognise you.' });
        await drawIfDue();
        if (store.isDrawn) {
          return sendJson(res, 409, { error: 'Too late, the names have been drawn.' });
        }
        await store.removeParticipant(person.id);
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/match': {
        await drawIfDue();
        const person = store.authenticate(url.searchParams.get('id'), url.searchParams.get('token'));
        if (!person) return sendJson(res, 404, { error: 'We do not recognise you.' });
        if (!isRevealTime()) {
          return sendJson(res, 423, { error: 'Not yet!', revealDate: revealDate().toISOString() });
        }
        if (!store.isDrawn) {
          return sendJson(res, 409, {
            error: 'The names have not been drawn yet, there may not be enough people in the pool.',
          });
        }
        const receiverId = store.state.assignments[person.id];
        const receiver = receiverId && store.findById(receiverId);
        if (!receiver) {
          return sendJson(res, 409, { error: 'You joined after the draw, so you have nobody to buy for.' });
        }
        await store.markSeen(person.id);
        return sendJson(res, 200, {
          you: { id: person.id, name: person.name },
          receiver: { name: receiver.name, hint: receiver.hint, answers: receiver.answers },
        });
      }

      // --- admin ---

      case 'GET /api/admin/overview': {
        if (!isAdmin(req, url)) return sendJson(res, 403, { error: 'forbidden' });
        return sendJson(res, 200, {
          ...(await publicState()),
          drawnAt: store.state.drawnAt,
          seenBy: store.state.seenBy,
          participants: store.state.participants.map(privatePerson),
          assignments: store.state.assignments,
        });
      }

      case 'POST /api/admin/draw': {
        if (!isAdmin(req, url)) return sendJson(res, 403, { error: 'forbidden' });
        if (store.isDrawn) return sendJson(res, 409, { error: 'Already drawn. Reset first.' });
        const ids = store.state.participants.map((p) => p.id);
        if (ids.length < 2) return sendJson(res, 400, { error: 'Need at least 2 people.' });
        await performDraw(ids);
        return sendJson(res, 200, { ok: true, drawnAt: store.state.drawnAt });
      }

      case 'POST /api/admin/reset': {
        if (!isAdmin(req, url)) return sendJson(res, 403, { error: 'forbidden' });
        const body = await readJsonBody(req);
        await store.clearAssignments();
        if (body.emptyPool === true) await store.emptyPool();
        return sendJson(res, 200, { ok: true });
      }

      default:
        return sendJson(res, 404, { error: 'no such endpoint' });
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      await store.load();
      await route(req, res, url);
    } catch (err) {
      console.error('api error', err);
      sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
    }
  };
}

module.exports = { createApi, defaultRevealDate, sendJson };
