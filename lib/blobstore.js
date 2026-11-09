'use strict';

/**
 * The pool kept in Vercel Blob, for when the app runs as serverless functions
 * and has no disk of its own.
 *
 * The whole pool is one JSON blob at a fixed path, overwritten on every change,
 * talking to the Blob REST API directly so the app stays dependency-free. The
 * blob's public URL sits behind a CDN, so reads go through the (uncached)
 * list endpoint to find the current URL and then fetch it with a cache-buster.
 *
 * Two people saving in the same instant could overwrite each other; for a
 * team joining over a few weeks that is an acceptable trade for simplicity.
 */

const { emptyState, Store } = require('./store');

const API = 'https://blob.vercel-storage.com';
const API_VERSION = '7';

class BlobStore {
  constructor({ token = process.env.BLOB_READ_WRITE_TOKEN, pathname = 'secret-santa/pool.json' } = {}) {
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
    this.token = token;
    this.pathname = pathname;
    this.state = emptyState();
    this._url = null;
  }

  // --- the blob -----------------------------------------------------------

  async _request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-api-version': API_VERSION,
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`blob ${options.method || 'GET'} ${url} failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response;
  }

  async load() {
    // The list endpoint is never cached, so it always knows the current blob.
    const list = await this._request(`${API}?prefix=${encodeURIComponent(this.pathname)}&limit=5`);
    const { blobs = [] } = await list.json();
    const match = blobs.find((b) => b.pathname === this.pathname);
    if (!match) {
      this.state = emptyState();
      this._url = null;
      return this.state;
    }
    this._url = match.url;
    // The content URL is CDN-cached; a unique query string skips that cache.
    const response = await fetch(`${match.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
    this.state = Object.assign(emptyState(), await response.json());
    return this.state;
  }

  async save() {
    const body = JSON.stringify(this.state, null, 2);
    const response = await this._request(`${API}/${this.pathname}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        'x-cache-control-max-age': '60',
      },
      body,
    });
    const result = await response.json().catch(() => null);
    if (result && result.url) this._url = result.url;
  }

  // --- everything else is the file store's logic over this.state ---------

  async emptyPool() {
    this.state.participants = [];
    await this.save();
  }
}

// Share the read helpers and the async mutators with the file store, so the
// API sees exactly one interface.
for (const name of [
  'findByName', 'findById', 'authenticate', 'addParticipant', 'updateParticipant',
  'removeParticipant', 'newCode', 'findByCode', 'signIn', 'setAssignments',
  'clearAssignments', 'markSeen',
]) {
  BlobStore.prototype[name] = Store.prototype[name];
}
Object.defineProperty(BlobStore.prototype, 'isDrawn', Object.getOwnPropertyDescriptor(Store.prototype, 'isDrawn'));

module.exports = { BlobStore };
