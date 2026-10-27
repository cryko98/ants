// Shared API used by the local dev server and the Netlify functions.
import { createIndexer } from './indexer.js';
import { demoHolder, demoSnapshot } from './demo.js';

export function createApi({ cfg, storage }) {
  const indexer = cfg.mode === 'live' ? createIndexer({ cfg, storage }) : null;

  return {
    async state() {
      if (!indexer) return { ...demoSnapshot(cfg), now: Date.now() };
      // First request before the scheduler has run: build the snapshot inline.
      const snap = (await storage.get('snapshot')) ?? (await indexer.tick(15000));
      return { ...snap, now: Date.now() };
    },

    async holder(owner) {
      if (!indexer) return demoHolder(cfg, owner);
      return indexer.holder(owner);
    },

    async sync(budgetMs) {
      return indexer ? indexer.tick(budgetMs) : null;
    },
  };
}

// In-memory storage with optional JSON file persistence (local dev).
export function createFileStorage(file) {
  const cache = new Map();
  return {
    async get(key) {
      if (cache.has(key)) return cache.get(key);
      if (!file) return null;
      const { default: fs } = await import('node:fs');
      try {
        const all = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(all)) cache.set(k, v);
      } catch {}
      return cache.get(key) ?? null;
    },
    async set(key, value) {
      cache.set(key, value);
      if (!file) return;
      const { default: fs } = await import('node:fs');
      const { default: path } = await import('node:path');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(cache)));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}
