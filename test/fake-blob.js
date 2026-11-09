'use strict';

/**
 * Just enough of the Vercel Blob REST API for the tests: PUT a blob, GET its
 * content, list by prefix (with cursor pagination), and delete by URL.
 * Blobs are held in memory and served from the same origin.
 */

const http = require('http');

function startFakeBlob() {
  const blobs = new Map(); // pathname -> string

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const base = () => `http://127.0.0.1:${server.address().port}`;
    const read = () => new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    // list
    if (req.method === 'GET' && url.pathname === '/') {
      const prefix = url.searchParams.get('prefix') || '';
      const limit = Number(url.searchParams.get('limit') || 1000);
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const all = [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort();
      const page = all.slice(cursor, cursor + Math.min(limit, 2)); // tiny pages, to exercise paging
      const next = cursor + page.length;
      return send(200, {
        blobs: page.map((pathname) => ({ pathname, url: `${base()}/content/${pathname}` })),
        hasMore: next < all.length,
        cursor: next < all.length ? String(next) : undefined,
      });
    }
    // content
    if (req.method === 'GET' && url.pathname.startsWith('/content/')) {
      const pathname = decodeURIComponent(url.pathname.slice('/content/'.length));
      if (!blobs.has(pathname)) return send(404, { error: 'not found' });
      return send(200, JSON.parse(blobs.get(pathname)));
    }
    // delete
    if (req.method === 'POST' && url.pathname === '/delete') {
      return read().then((body) => {
        for (const u of JSON.parse(body).urls) {
          blobs.delete(decodeURIComponent(new URL(u).pathname.slice('/content/'.length)));
        }
        send(200, null);
      });
    }
    // put
    if (req.method === 'PUT') {
      const pathname = decodeURIComponent(url.pathname.slice(1));
      return read().then((body) => {
        blobs.set(pathname, body);
        send(200, { url: `${base()}/content/${pathname}`, pathname });
      });
    }
    send(404, { error: 'unhandled' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        blobs,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeBlob };
