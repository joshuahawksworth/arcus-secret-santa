'use strict';

/**
 * The zero-dependency server: static files out of public/, and the JSON API
 * from lib/api.js backed by a JSON file on disk.
 *
 *   PORT          port to listen on              (3000)
 *   HOST          interface to bind              (0.0.0.0)
 *   REVEAL_DATE   YYYY-MM-DD, midnight local     (1 December this year)
 *   DATA_FILE     where the pool is stored       (data/pool.json)
 *   ADMIN_TOKEN   enables the admin endpoints    (off when unset)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store } = require('./lib/store');
const { createApi, defaultRevealDate, sendJson } = require('./lib/api');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store();
const api = createApi({ store });

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return api(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Arcus Secret Santa listening on http://localhost:${PORT}`);
  console.log(`Reveal date: ${defaultRevealDate().toString()}`);
  console.log(`In the pool: ${store.state.participants.length}`);
  console.log(store.isDrawn ? `Names drawn at ${store.state.drawnAt}` : 'Names not drawn yet');
  if (!process.env.ADMIN_TOKEN) console.log('ADMIN_TOKEN is not set, so the admin endpoints are switched off.');
});

module.exports = { server, store };
