// Shared wiring for the Netlify functions: config + a Blobs-backed cache of the on-chain index.
import { getStore } from '@netlify/blobs';
import { loadConfig } from '../../server/config.js';
import { createApi } from '../../server/api.js';

export function api() {
  const cfg = loadConfig();
  // Site-wide store, opened lazily (demo mode never touches it). The data is re-derivable
  // from the chain and only the scheduled sync writes it.
  let store;
  const blobs = () => (store ??= getStore({ name: 'colony', consistency: 'strong' }));
  const storage = {
    get: (key) => blobs().get(key, { type: 'json' }),
    set: (key, value) => blobs().setJSON(key, value),
  };
  return createApi({ cfg, storage });
}

export const json = (body, { status = 200, cdnSeconds = 0 } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      // Many visitors poll every few seconds: let the CDN absorb it.
      ...(cdnSeconds ? { 'netlify-cdn-cache-control': `public, s-maxage=${cdnSeconds}, stale-while-revalidate=30` } : {}),
    },
  });
