// GET /api/sync — optional cron target (Vercel Pro: every minute) so the colony stays fresh even
// with no visitors. When CRON_SECRET is set, Vercel Cron sends it as a bearer token.
import { getApi, json } from '../server/vercel.js';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) return json({ error: 'unauthorized' }, { status: 401 });
  const snap = await (await getApi()).sync(45_000);
  return json({ ok: true, synced: !!snap, payouts: snap?.stats.payouts ?? null, backlog: snap?.stats.backlog ?? null });
}
