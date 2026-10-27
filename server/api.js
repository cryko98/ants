// Shared API used by the local dev server and the Vercel functions.
import { createIndexer } from './indexer.js';
import { demoHolder, demoSnapshot } from './demo.js';

const STALE_MS = 60_000; // refresh from the chain at most about once a minute
const LOCK_SECONDS = 70;

export function createApi({ cfg, storage }) {
  const indexer = cfg.mode === 'live' ? createIndexer({ cfg, storage }) : null;

  // One sync at a time across all instances; returns null if another one is running.
  async function sync(budgetMs) {
    if (!indexer || !(await storage.lock(LOCK_SECONDS))) return null;
    try {
      return await indexer.sync(budgetMs);
    } finally {
      await storage.unlock();
    }
  }

  return {
    sync,

    // `background(promise)` lets the host keep the refresh running after the response is sent.
    async state({ background = (p) => p.catch(() => {}) } = {}) {
      if (!indexer) return { ...demoSnapshot(cfg), now: Date.now() };
      let snap = await storage.getJSON('snapshot');
      if (!snap) {
        // Very first visit: build it now (or wait for the instance that already is).
        snap = await sync(40_000);
        for (let i = 0; !snap && i < 20; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          snap = await storage.getJSON('snapshot');
        }
        if (!snap) throw new Error('colony is still syncing');
      } else if (Date.now() - snap.updatedAt > STALE_MS) {
        background(sync(40_000).catch((e) => console.error('[sync]', e.message)));
      }
      return { ...snap, now: Date.now() };
    },

    async holder(owner) {
      if (!indexer) return demoHolder(cfg, owner);
      return indexer.holder(owner);
    },
  };
}
