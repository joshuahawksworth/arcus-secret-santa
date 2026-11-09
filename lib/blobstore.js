'use strict';

/**
 * The pool kept in Vercel Blob, for when the app runs as serverless functions
 * and has no disk of its own.
 *
 * Layout:
 *   secret-santa/people/<id>/<version>.json   one document per person
 *   secret-santa/draw/<version>.json          the assignments, when drawn, who
 *                                             has looked, and dev-tool settings
 *
 * Two rules keep it correct:
 *
 *  1. One document per person, so two people joining or editing at the same
 *     moment write different files and cannot overwrite each other. The draw
 *     document is written once, at the draw.
 *
 *  2. Blobs are never overwritten. Every save writes a NEW version (a fresh
 *     pathname, so a fresh URL) and then deletes the older versions. The Blob
 *     CDN caches each URL for at least a minute even when asked not to, so
 *     overwriting in place could hand a reader last minute's content; a URL
 *     that has never existed before cannot be stale. The list endpoint, which
 *     is never cached, always says which version is current.
 *
 * Each request lists the prefix and fetches the current documents in parallel:
 * a few hundred milliseconds for a team-sized pool. Talks to the Blob REST API
 * directly, so the app stays dependency-free. Pools written by the two earlier
 * layouts (a single pool.json; flat people/<id>.json + draw.json) are
 * converted on first read.
 */

const crypto = require('crypto');
const { emptyState, Store } = require('./store');

const API = process.env.BLOB_API_URL || 'https://blob.vercel-storage.com';
const API_VERSION = '7';

/** A version id that sorts by time as a plain string: 13-digit ms + random. */
const newVersion = () => `${String(Date.now()).padStart(13, '0')}-${crypto.randomBytes(4).toString('hex')}`;

class BlobStore {
  constructor({ token = process.env.BLOB_READ_WRITE_TOKEN, prefix = 'secret-santa' } = {}) {
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
    this.token = token;
    this.prefix = prefix.replace(/\/+$/, '');
    this.state = emptyState();
    // What was last read or written, per key ('draw' or a person id):
    //   { text, pathname, stale: [pathnames of older versions still to delete] }
    this._docs = new Map();
    this._urls = new Map();     // pathname -> url, for deletes
  }

  // --- the blob api -------------------------------------------------------

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

  /** Every blob under the prefix. The list endpoint is never cached. */
  async _list() {
    const blobs = [];
    let cursor;
    do {
      const params = new URLSearchParams({ prefix: `${this.prefix}/`, limit: '1000' });
      if (cursor) params.set('cursor', cursor);
      const page = await (await this._request(`${API}?${params}`)).json();
      blobs.push(...(page.blobs || []));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  async _read(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
    return response.text();
  }

  async _put(pathname, text) {
    const response = await this._request(`${API}/${pathname}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '0',
      },
      body: text,
    });
    const result = await response.json().catch(() => null);
    if (result && result.url) this._urls.set(pathname, result.url);
  }

  async _delete(pathnames) {
    const urls = pathnames.map((p) => this._urls.get(p)).filter(Boolean);
    if (!urls.length) return;
    await this._request(`${API}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    for (const p of pathnames) this._urls.delete(p);
  }

  // --- paths --------------------------------------------------------------

  _personPath(id, version) { return `${this.prefix}/people/${id}/${version}.json`; }
  _drawPath(version) { return `${this.prefix}/draw/${version}.json`; }

  /**
   * Works out which document a pathname belongs to.
   *   people/<id>/<version>.json  -> { key: id, version }
   *   draw/<version>.json         -> { key: 'draw', version }
   *   people/<id>.json            -> { key: id, version: '' }      (older layout)
   *   draw.json                   -> { key: 'draw', version: '' }  (older layout)
   *   pool.json                   -> { key: 'legacy' }             (oldest layout)
   */
  _classify(pathname) {
    const rel = pathname.slice(this.prefix.length + 1);
    let m;
    if ((m = rel.match(/^people\/([^/]+)\/([^/]+)\.json$/))) return { key: m[1], version: m[2] };
    if ((m = rel.match(/^draw\/([^/]+)\.json$/))) return { key: 'draw', version: m[1] };
    if ((m = rel.match(/^people\/([^/]+)\.json$/))) return { key: m[1], version: '' };
    if (rel === 'draw.json') return { key: 'draw', version: '' };
    if (rel === 'pool.json') return { key: 'legacy', version: '' };
    return null;
  }

  // --- load / save --------------------------------------------------------

  async load() {
    const blobs = await this._list();
    this._urls = new Map(blobs.map((b) => [b.pathname, b.url]));

    // Group every blob by document, newest version first.
    const groups = new Map();
    for (const blob of blobs) {
      const info = this._classify(blob.pathname);
      if (!info) continue;
      if (!groups.has(info.key)) groups.set(info.key, []);
      groups.get(info.key).push({ ...info, pathname: blob.pathname, url: blob.url });
    }
    for (const versions of groups.values()) versions.sort((a, b) => (a.version < b.version ? 1 : -1));

    // The oldest layout: one blob for everything. Convert it and we are done.
    if (groups.has('legacy') && groups.size === 1) {
      await this._migrateLegacy(groups.get('legacy')[0]);
      return this.state;
    }
    groups.delete('legacy');

    const keys = [...groups.keys()];
    const texts = await Promise.all(keys.map((key) => this._read(groups.get(key)[0].url)));

    const state = emptyState();
    this._docs = new Map();
    const people = [];
    let needsRewrite = false;

    keys.forEach((key, i) => {
      const [current, ...older] = groups.get(key);
      const text = texts[i];
      // A document still in the older flat layout gets rewritten as a version.
      if (current.version === '') needsRewrite = true;
      this._docs.set(key, { text, pathname: current.pathname, stale: older.map((v) => v.pathname) });
      if (key === 'draw') {
        try { Object.assign(state, this._pickDraw(JSON.parse(text))); }
        catch { console.warn('ignoring unreadable draw document'); }
      } else {
        try {
          const person = JSON.parse(text);
          if (person && person.id) people.push(person);
        } catch { console.warn(`ignoring unreadable person document ${current.pathname}`); }
      }
    });

    people.sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));
    state.participants = people;
    this.state = state;

    if (needsRewrite) {
      // Force every flat-layout document to be written out as a version.
      for (const [key, doc] of this._docs) {
        if (!doc.pathname.includes(`/${key}/`) && !doc.pathname.includes('/draw/')) {
          doc.stale.push(doc.pathname);
          doc.text = null;
        }
      }
      await this.save();
    } else {
      // Tidy any older versions a previous save did not get round to deleting.
      await this._sweep();
    }
    return state;
  }

  _pickDraw(obj) {
    return {
      assignments: obj.assignments || null,
      drawnAt: obj.drawnAt || null,
      seenBy: obj.seenBy || {},
      settings: obj.settings || {},
    };
  }

  /** Writes a new version of every document that changed, then deletes the old. */
  async save() {
    const pending = [];
    const want = new Map();
    for (const person of this.state.participants) want.set(person.id, JSON.stringify(person));
    want.set('draw', JSON.stringify(this._pickDraw(this.state)));

    for (const [key, text] of want) {
      const doc = this._docs.get(key) || { text: null, pathname: null, stale: [] };
      if (doc.text === text) continue;
      const version = newVersion();
      const pathname = key === 'draw' ? this._drawPath(version) : this._personPath(key, version);
      pending.push(this._put(pathname, text).then(() => {
        if (doc.pathname) doc.stale.push(doc.pathname);
        doc.text = text;
        doc.pathname = pathname;
        this._docs.set(key, doc);
      }));
    }

    // People who were removed: every version of theirs goes.
    for (const [key, doc] of this._docs) {
      if (key !== 'draw' && !want.has(key)) {
        doc.stale.push(doc.pathname);
        doc.pathname = null;
        doc.text = null;
      }
    }

    await Promise.all(pending);
    await this._sweep();
  }

  /** Deletes superseded versions; a failure here just leaves them for next time. */
  async _sweep() {
    const stale = [];
    for (const [key, doc] of this._docs) {
      stale.push(...doc.stale.filter((p) => p !== doc.pathname));
      doc.stale = [];
      if (!doc.pathname) this._docs.delete(key);
    }
    if (!stale.length) return;
    try { await this._delete(stale); }
    catch (err) { console.warn('could not delete old blob versions:', err.message); }
  }

  /** Splits a single-blob pool into the per-document layout, then removes it. */
  async _migrateLegacy(blob) {
    let legacy;
    try {
      legacy = Object.assign(emptyState(), JSON.parse(await this._read(blob.url)));
    } catch {
      console.warn('legacy pool blob unreadable, starting empty');
      this.state = emptyState();
      return;
    }
    this.state = legacy;
    this._docs = new Map();
    await this.save();
    await this._delete([blob.pathname]);
    console.log(`migrated ${legacy.participants.length} people out of ${blob.pathname}`);
  }
}

// Share the read helpers and the mutators with the file store, so the API sees
// exactly one interface. Each mutator ends with this._done(), which saves.
for (const name of [
  'findByName', 'findById', 'authenticate', 'addParticipant', 'updateParticipant',
  'removeParticipant', 'newCode', 'findByCode', 'signIn', 'setAssignments',
  'clearAssignments', 'markSeen', 'setSetting', 'emptyPool', '_done',
]) {
  BlobStore.prototype[name] = Store.prototype[name];
}
Object.defineProperty(BlobStore.prototype, 'isDrawn', Object.getOwnPropertyDescriptor(Store.prototype, 'isDrawn'));

module.exports = { BlobStore };
