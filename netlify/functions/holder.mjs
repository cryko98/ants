// GET /api/holder/:owner — lookup for wallets that are too small to be rendered.
import { api, json } from '../lib/shared.mjs';

export default async (_req, context) => {
  const h = await api().holder(context.params.owner).catch(() => null);
  return h ? json(h, { cdnSeconds: 15 }) : json({ error: 'not a holder' }, { status: 404 });
};

export const config = { path: '/api/holder/:owner', method: 'GET' };
