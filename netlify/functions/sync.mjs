// Scheduled every 2 minutes (UTC cron): indexes new holders and Holder Rewards payouts from the chain.
// Scheduled functions stop at 30 s, so work is capped at ~22 s; any backlog continues next run.
import { api } from '../lib/shared.mjs';

export default async () => {
  const snapshot = await api().sync(22000);
  if (snapshot) console.log(`[sync] ${snapshot.stats.holderCount} holders, ${snapshot.stats.payouts} payouts indexed, backlog ${snapshot.stats.backlog}`);
};

export const config = { schedule: '*/2 * * * *' };
