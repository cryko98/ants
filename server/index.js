// Local server: serves the site (Vite in dev) and the same /api the Vercel functions expose.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createApi } from './api.js';
import { createFileStorage } from './storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 8787);
const cfg = loadConfig();
const api = createApi({ cfg, storage: createFileStorage(path.join(root, 'data', `${cfg.token.mint || 'demo'}.json`)) });

const app = express();
app.get('/api/state', async (_req, res) => {
  try {
    res.json(await api.state());
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});
app.get('/api/holder/:owner', async (req, res) => {
  const h = await api.holder(req.params.owner).catch(() => null);
  if (!h) return res.status(404).json({ error: 'not a holder' });
  res.json(h);
});

if (dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve(root, 'dist');
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, () => console.log(`[ants] ${cfg.mode.toUpperCase()} — http://localhost:${port}`));
