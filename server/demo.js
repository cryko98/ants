// Stateless demo colony for running the site before the token exists (or without an RPC).
// The whole snapshot is a pure function of the clock, so every request and every server
// instance (including serverless functions) sees the same evolving colony.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ORIGIN = Date.UTC(2026, 9, 20); // "launch" of the demo coin
const EPOCH_MS = 15_000; // holder churn step
const PAYOUT_EVERY = 8; // epochs between distributions (2 min)
const BATCH = 14; // recipients per distribution transaction, like pump.fun
const HOLDERS = 280;
const SUPPLY = 1e9;

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fakeAddress = (rand, len = 44) => Array.from({ length: len }, () => ALPHABET[Math.floor(rand() * 58)]).join('');

// Fixed cast of wallets with their own trading rhythm.
const cast = (() => {
  const rand = mulberry32(42);
  return Array.from({ length: HOLDERS }, (_, i) => ({
    o: fakeAddress(rand),
    base: Math.min(4.5, 0.004 / Math.pow(rand(), 1.35)), // % of supply, pareto-ish
    freq: 0.01 + rand() * 0.05,
    phase: rand() * Math.PI * 2,
    period: 60 + Math.floor(rand() * 500), // lifecycle in epochs
    offset: Math.floor(rand() * 1000),
    core: i < 40 || rand() < 0.55, // core holders never leave
  }));
})();

const present = (c, e) => c.core || (e + c.offset) % c.period < c.period * 0.8;
const pctAt = (c, e) => {
  const whale = (e + c.offset) % 211 < 6 && c.base < 1 ? 3 : 1;
  return c.base * whale * (1 + 0.3 * Math.sin(e * c.freq + c.phase));
};
const payoutSol = (k) => 0.02 + mulberry32(k * 7919)() * 0.06;
const sigFor = (k, b) => fakeAddress(mulberry32(k * 131 + b * 17 + 5), 88);

export function demoSnapshot(cfg, now = Date.now()) {
  const epoch = Math.floor((now - ORIGIN) / EPOCH_MS);
  const lastPayoutEpoch = epoch - (epoch % PAYOUT_EVERY);
  const k = lastPayoutEpoch / PAYOUT_EVERY; // distributions so far

  const holders = cast
    .filter((c) => present(c, epoch))
    .map((c) => ({ c, p: pctAt(c, epoch) }))
    .sort((a, b) => b.p - a.p);
  const castShare = cast.reduce((s, c) => s + c.base, 0);

  // Cumulative payouts: grows quickly after "launch", then slows, like a young coin.
  const totalDistributed = 14 * Math.log1p(k / 300);
  const vault = payoutSol(k + 1) * ((epoch % PAYOUT_EVERY) / PAYOUT_EVERY);
  const eligibleTotal = holders.reduce((s, h) => s + h.p, 0) || 1;
  const rows = holders.map(({ c, p }) => ({
    o: c.o,
    a: (p / 100) * SUPPLY,
    p,
    x: 0,
    e: 1,
    est: (vault * p) / eligibleTotal,
    recv: totalDistributed * (c.base / castShare),
  }));

  // Events: the last few distributions (batched like on-chain) and recent holder churn.
  const events = [];
  for (let j = Math.max(1, k - 3); j <= k; j++) {
    const t = ORIGIN + j * PAYOUT_EVERY * EPOCH_MS;
    const e = j * PAYOUT_EVERY;
    const paid = cast.filter((c) => present(c, e)).map((c) => ({ c, p: pctAt(c, e) }));
    const sum = paid.reduce((s, h) => s + h.p, 0) || 1;
    const amount = payoutSol(j);
    events.push({ type: 'claim', sig: sigFor(j, 99), lamports: String(Math.round(amount * 1e9)), t: t - 4000 });
    for (let b = 0; b * BATCH < paid.length; b++) {
      const to = paid.slice(b * BATCH, (b + 1) * BATCH).map(({ c, p }) => [c.o, String(Math.round(((amount * p) / sum) * 1e9))]);
      events.push({ type: 'payout', sig: sigFor(j, b), lamports: String(to.reduce((s, [, l]) => s + Number(l), 0)), to, t: t + b * 400 });
    }
  }
  for (let e = epoch - 20; e <= epoch; e++) {
    const t = ORIGIN + e * EPOCH_MS;
    for (const c of cast) {
      const was = present(c, e - 1), is = present(c, e);
      if (!was && is) events.push({ type: 'join', owner: c.o, t });
      else if (was && !is) events.push({ type: 'leave', owner: c.o, t });
      else if (is && pctAt(c, e) - pctAt(c, e - 1) > 0.5) events.push({ type: 'whale', owner: c.o, amount: String(Math.round(((pctAt(c, e) - pctAt(c, e - 1)) / 100) * SUPPLY * 1e6)), t });
    }
  }
  events.sort((a, b) => a.t - b.t);

  const earners = [...rows].sort((a, b) => b.recv - a.recv).slice(0, 25);
  return {
    mode: 'demo',
    token: { ...cfg.token, supply: SUPPLY, decimals: 6, priceUsd: null },
    vault: 'demo',
    pot: { balance: vault, solUsd: 180, thresholdSol: payoutSol(k + 1) },
    stats: {
      totalDistributed,
      totalInflow: totalDistributed + vault,
      payouts: k,
      paidHolders: cast.length,
      lastPayoutAt: ORIGIN + lastPayoutEpoch * EPOCH_MS,
      holderCount: rows.length,
      eligibleCount: rows.length,
      minEligibleUsd: cfg.minEligibleUsd,
      backlog: 0,
    },
    holders: rows.slice(0, cfg.publicHolderLimit),
    earners,
    events: events.slice(-120),
    updatedAt: now,
  };
}

export function demoHolder(cfg, owner, now = Date.now()) {
  return demoSnapshot(cfg, now).holders.find((h) => h.o === owner) ?? null;
}
