'use strict';

/**
 * Vercel entry point: every /api/* request is rewritten here (see vercel.json)
 * and handled by the same code as server.js.
 *
 * With a Blob store connected to the project (BLOB_READ_WRITE_TOKEN set) the
 * pool persists. Without one it falls back to a file in /tmp, which only lives
 * as long as the function instance does: fine for a quick look, not for the
 * real thing.
 */

const { createApi } = require('../lib/api');
const { Store } = require('../lib/store');

let store;
if (process.env.BLOB_READ_WRITE_TOKEN) {
  const { BlobStore } = require('../lib/blobstore');
  store = new BlobStore();
} else {
  console.warn('No BLOB_READ_WRITE_TOKEN: the pool will not survive a cold start.');
  store = new Store('/tmp/secret-santa-pool.json');
}

module.exports = createApi({ store });
