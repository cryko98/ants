// Wiring for the Vercel functions in /api: config, Redis-backed cache, JSON responses.
import { loadConfig } from './config.js';
import { createApi } from './api.js';
import { createFileStorage, createRedisStorage } from './storage.js';

let apiPromise;

// One API instance per function instance (Fluid compute reuses them across requests).
export function getApi() {
  return (apiPromise ??= (async () => {
    const cfg = loadConfig();
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    let storage;
    if (url && token) storage = await createRedisStorage({ url, token, prefix: `ants:${cfg.token.mint || 'demo'}` });
    else {
      if (cfg.mode === 'live') console.warn('[ants] No Upstash Redis configured: payout history resets on every cold start.');
      storage = createFileStorage(null);
    }
    return createApi({ cfg, storage });
  })());
}

export const json = (body, { status = 200, cdnSeconds = 0 } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      // Every visitor polls every few seconds: let Vercel's CDN absorb it.
      ...(cdnSeconds ? { 'vercel-cdn-cache-control': `public, s-maxage=${cdnSeconds}, stale-while-revalidate=30` } : {}),
    },
  });
