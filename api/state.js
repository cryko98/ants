// GET /api/state — the colony snapshot the 3D scene renders. Refreshes from the chain in the
// background (after the response) whenever the cached snapshot is more than a minute old.
import { waitUntil } from '@vercel/functions';
import { getApi, json } from '../server/vercel.js';

export async function GET() {
  try {
    const api = await getApi();
    return json(await api.state({ background: waitUntil }), { cdnSeconds: 5 });
  } catch (e) {
    console.error('[state]', e);
    return json({ error: e.message }, { status: 503 });
  }
}
