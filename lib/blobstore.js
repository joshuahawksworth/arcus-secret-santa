'use strict';

/**
 * The pool kept in Vercel Blob, for when the app runs as serverless functions
 * and has no disk of its own.
 *
 * Layout:
 *   secret-santa/people/<id>.json   one blob per person
 *   secret-santa/draw.json          the assignments, when drawn, who has looked,
 *                                   and any dev-tool settings
 *
 * Each person is their own blob, so two people joining or editing at the same
 * moment write to different files and cannot overwrite each other. The draw
 * document is written once, at the draw, so it has no such race. The cost is
 * one list call plus one fetch per blob on every request, run in parallel; for
 * a team-sized pool that is a few hundred milliseconds.
 *
 * save() writes only what changed since load(), by comparing each document to
 * the copy that was read. Talks to the Blob REST API directly, so the app
 * stays dependency-free.
 *
 * A pool written by the earlier single-blob layout (secret-santa/pool.json) is
 * split into this layout the first time it is read.
 */

const { emptyState, Store } = require('./store');

const API = process.env.BLOB_API_URL || 'https://blob.vercel-storage.com';
const API_VERSION = '7';

class BlobStore {
  constructor({ token = process.env.BLOB_READ_WRITE_TOKEN, prefix = 'secret-santa' } = {}) {
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
    this.token = token;
    this.prefix = prefix.replace(/\/+$/, '');
    this.state = emptyState();
    this._people = new Map();   // id -> JSON as last read or written
    this._draw = '';            // the draw document as last read or written
    this._urls = new Map();     // pathname -> blob url, for deletes
  }

  get peoplePrefix() { return `${this.prefix}/people/`; }
  get drawPath() { return `${this.prefix}/draw.json`; }
  get legacyPath() { return `${this.prefix}/pool.json`; }

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

  /** Reads a blob's JSON, skipping the CDN cache. */
  async _read(url) {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
    return response.text();
  }

  async _put(pathname, text) {
    const response = await this._request(`${API}/${pathname}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        'x-cache-control-max-age': '60',
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

  // --- load / save --------------------------------------------------------

  async load() {
    const blobs = await this._list();
    this._urls = new Map(blobs.map((b) => [b.pathname, b.url]));

    const peopleBlobs = blobs.filter((b) => b.pathname.startsWith(this.peoplePrefix) && b.pathname.endsWith('.json'));
    const drawBlob = blobs.find((b) => b.pathname === this.drawPath);
    const legacyBlob = blobs.find((b) => b.pathname === this.legacyPath);

    if (!peopleBlobs.length && !drawBlob && legacyBlob) {
      await this._migrate(legacyBlob);
      return this.state;
    }

    const [drawText, ...peopleTexts] = await Promise.all([
      drawBlob ? this._read(drawBlob.url) : Promise.resolve(''),
      ...peopleBlobs.map((b) => this._read(b.url)),
    ]);

    const state = emptyState();
    this._people = new Map();
    const people = [];
    peopleTexts.forEach((text, i) => {
      try {
        const person = JSON.parse(text);
        if (person && person.id) {
          people.push(person);
          this._people.set(person.id, JSON.stringify(person));
        }
      } catch {
        console.warn(`ignoring unreadable person blob ${peopleBlobs[i].pathname}`);
      }
    });
    people.sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));
    state.participants = people;

    if (drawText) {
      try {
        Object.assign(state, this._pickDraw(JSON.parse(drawText)));
      } catch {
        console.warn('ignoring unreadable draw blob');
      }
    }
    this._draw = JSON.stringify(this._pickDraw(state));
    this.state = state;
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

  /** Writes whichever documents differ from what was last read or written. */
  async save() {
    const writes = [];

    const seen = new Set();
    for (const person of this.state.participants) {
      const text = JSON.stringify(person);
      seen.add(person.id);
      if (this._people.get(person.id) !== text) {
        writes.push(this._put(`${this.peoplePrefix}${person.id}.json`, text).then(() => this._people.set(person.id, text)));
      }
    }
    const gone = [...this._people.keys()].filter((id) => !seen.has(id));
    if (gone.length) {
      writes.push(this._delete(gone.map((id) => `${this.peoplePrefix}${id}.json`)).then(() => {
        for (const id of gone) this._people.delete(id);
      }));
    }

    const drawText = JSON.stringify(this._pickDraw(this.state));
    if (drawText !== this._draw) {
      writes.push(this._put(this.drawPath, JSON.stringify(this._pickDraw(this.state), null, 2)).then(() => { this._draw = drawText; }));
    }

    await Promise.all(writes);
  }

  /** Splits a single-blob pool into the per-person layout, then removes it. */
  async _migrate(legacyBlob) {
    let legacy;
    try {
      legacy = Object.assign(emptyState(), JSON.parse(await this._read(legacyBlob.url)));
    } catch {
      console.warn('legacy pool blob unreadable, starting empty');
      this.state = emptyState();
      return;
    }
    this.state = legacy;
    this._people = new Map();
    this._draw = '';
    await this.save();
    await this._delete([this.legacyPath]);
    console.log(`migrated ${legacy.participants.length} people out of ${this.legacyPath}`);
  }

}

// Share the read helpers and the mutators with the file store, so the API sees
// exactly one interface. Each mutator ends with this.save(), which here writes
// only the documents it touched.
for (const name of [
  'findByName', 'findById', 'authenticate', 'addParticipant', 'updateParticipant',
  'removeParticipant', 'newCode', 'findByCode', 'signIn', 'setAssignments',
  'clearAssignments', 'markSeen', 'setSetting', 'emptyPool', '_done',
]) {
  BlobStore.prototype[name] = Store.prototype[name];
}
Object.defineProperty(BlobStore.prototype, 'isDrawn', Object.getOwnPropertyDescriptor(Store.prototype, 'isDrawn'));

module.exports = { BlobStore };
