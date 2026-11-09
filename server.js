'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Store } = require('./lib/store');
const { drawAssignments, validateAssignments } = require('./lib/draw');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store();

// --- reveal date ------------------------------------------------------------

/** 1st December, 00:00 in the server's own timezone, unless REVEAL_DATE says otherwise. */
function revealDate() {
  const override = process.env.REVEAL_DATE;
  if (override) {
    const parsed = new Date(`${override}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    console.warn(`REVEAL_DATE="${override}" is not a valid YYYY-MM-DD date, ignoring it`);
  }
  return new Date(new Date().getFullYear(), 11, 1, 0, 0, 0, 0);
}

function isRevealTime() {
  return Date.now() >= revealDate().getTime();
}

/**
 * Once the reveal date arrives the pool closes and the names are drawn, once.
 * Called before anything that reads assignments so nobody has to press a button
 * on the morning of the 1st.
 */
function drawIfDue() {
  if (store.isDrawn || !isRevealTime()) return;
  const ids = store.state.participants.map((p) => p.id);
  if (ids.length < 2) return;
  performDraw(ids);
}

function performDraw(ids) {
  const assignments = drawAssignments(ids);
  const problems = validateAssignments(ids, assignments);
  if (problems.length) {
    throw new Error(`refusing to save an invalid draw: ${problems.join('; ')}`);
  }
  store.setAssignments(assignments);
  console.log(`drew ${ids.length} names at ${new Date().toISOString()}`);
  return assignments;
}

// --- tiny http helpers ------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req, limit = 64 * 1024) {
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = path.join(PUBLIC_DIR, path.normalize(rel));
  // path.normalize collapses "..", so anything escaping PUBLIC_DIR is a traversal attempt.
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': path.extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// --- shaping ----------------------------------------------------------------

function publicState() {
  drawIfDue();
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

function isAdmin(req, url) {
  if (!ADMIN_TOKEN) return false;
  const supplied = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
  const a = Buffer.from(ADMIN_TOKEN);
  const b = Buffer.from(String(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- api --------------------------------------------------------------------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/state':
      return sendJson(res, 200, publicState());

    case 'POST /api/join': {
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
      const person = store.addParticipant({ name, hint, answers });
      return sendJson(res, 201, { ...privatePerson(person), token: person.token });
    }

    case 'POST /api/signin': {
      const body = await readJsonBody(req);
      const person = store.signIn(body.name, body.code);
      if (!person) {
        return sendJson(res, 404, {
          error: 'That name and elf code do not match anyone in the pool.',
        });
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

      store.updateParticipant(person.id, {
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
      if (store.isDrawn) {
        return sendJson(res, 409, { error: 'Too late, the names have been drawn.' });
      }
      store.removeParticipant(person.id);
      return sendJson(res, 200, { ok: true });
    }

    case 'GET /api/match': {
      drawIfDue();
      const person = store.authenticate(url.searchParams.get('id'), url.searchParams.get('token'));
      if (!person) return sendJson(res, 404, { error: 'We do not recognise you.' });
      if (!isRevealTime()) {
        return sendJson(res, 423, {
          error: 'Not yet!',
          revealDate: revealDate().toISOString(),
        });
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
      store.markSeen(person.id);
      return sendJson(res, 200, {
        you: { id: person.id, name: person.name },
        receiver: { name: receiver.name, hint: receiver.hint, answers: receiver.answers },
      });
    }

    // --- admin ---

    case 'GET /api/admin/overview': {
      if (!isAdmin(req, url)) return sendJson(res, 403, { error: 'forbidden' });
      return sendJson(res, 200 , {
        ...publicState(),
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
      performDraw(ids);
      return sendJson(res, 200, { ok: true, drawnAt: store.state.drawnAt });
    }

    case 'POST /api/admin/reset': {
      if (!isAdmin(req, url)) return sendJson(res, 403, { error: 'forbidden' });
      const body = await readJsonBody(req);
      store.clearAssignments();
      if (body.emptyPool === true) {
        store.state.participants = [];
        store.save();
      }
      return sendJson(res, 200, { ok: true });
    }

    default:
      return sendJson(res, 404, { error: 'no such endpoint' });
  }
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

// --- server -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('api error', err);
      sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const when = revealDate();
  console.log(`Arcus Secret Santa listening on http://localhost:${PORT}`);
  console.log(`Reveal date: ${when.toString()}`);
  console.log(`In the pool: ${store.state.participants.length}`);
  console.log(store.isDrawn ? `Names drawn at ${store.state.drawnAt}` : 'Names not drawn yet');
  if (!ADMIN_TOKEN) console.log('ADMIN_TOKEN is not set, so the admin endpoints are switched off.');
});

module.exports = { server, store };
