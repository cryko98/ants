// GET /api/state — the colony snapshot the 3D scene renders.
import { api, json } from '../lib/shared.mjs';

export default async () => {
  try {
    return json(await api().state(), { cdnSeconds: 5 });
  } catch (e) {
    console.error('[state]', e);
    return json({ error: 'colony unavailable' }, { status: 502 });
  }
};

export const config = { path: '/api/state', method: 'GET' };
