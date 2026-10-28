// Pre-launch colony, shown while TOKEN_MINT is empty or a placeholder ("coming soon").
// The ants move and churn so the scene is alive, but nothing about rewards is invented:
// the vault, payouts and the live feed stay empty until a real CA is set.
// The snapshot is a pure function of the clock, so every request and every serverless
// instance sees the same colony.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ORIGIN = Date.UTC(2026, 9, 20);
const EPOCH_MS = 15_000; // holder churn step
const HOLDERS = 280;
const SUPPLY = 1e9;
// Rewards are planned in SOL (a SOL-paired coin); REWARD_MINT / REWARD_SYMBOL can override it.
const SOL = { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 };

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fakeAddress = (rand, len = 44) => Array.from({ length: len }, () => ALPHABET[Math.floor(rand() * 58)]).join('');

// Fixed cast of wallets with their own rhythm.
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
const pctAt = (c, e) => c.base * (1 + 0.3 * Math.sin(e * c.freq + c.phase));

export function demoSnapshot(cfg, now = Date.now()) {
  const epoch = Math.floor((now - ORIGIN) / EPOCH_MS);
  const rows = cast
    .filter((c) => present(c, epoch))
    .map((c) => {
      const p = pctAt(c, epoch);
      return { o: c.o, a: (p / 100) * SUPPLY, p, x: 0, e: 1, est: 0, recv: 0 };
    })
    .sort((a, b) => b.p - a.p);

  return {
    mode: 'demo',
    token: { ...cfg.token, supply: SUPPLY, decimals: 6, priceUsd: null },
    reward: {
      mint: cfg.rewardMint || SOL.mint,
      symbol: cfg.rewardSymbol || SOL.symbol,
      decimals: SOL.decimals,
      priceUsd: null,
    },
    vault: null,
    pot: { balance: 0, usd: null, threshold: null },
    stats: {
      totalDistributed: 0,
      totalInflow: 0,
      payouts: 0,
      paidHolders: 0,
      lastPayoutAt: 0,
      holderCount: rows.length,
      eligibleCount: rows.length,
      minEligibleUsd: cfg.minEligibleUsd,
      backlog: 0,
    },
    holders: rows.slice(0, cfg.publicHolderLimit),
    earners: [],
    events: [],
    updatedAt: now,
  };
}

export function demoHolder(cfg, owner, now = Date.now()) {
  return demoSnapshot(cfg, now).holders.find((h) => h.o === owner) ?? null;
}
