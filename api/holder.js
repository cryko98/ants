// GET /api/holder/:owner (rewritten to ?owner=) — lookup for wallets too small to be rendered.
import { getApi, json } from '../server/vercel.js';

export async function GET(request) {
  const owner = new URL(request.url).searchParams.get('owner') ?? '';
  const h = await (await getApi()).holder(owner).catch(() => null);
  return h ? json(h, { cdnSeconds: 15 }) : json({ error: 'not a holder' }, { status: 404 });
}
