// Holding % of supply -> ant body scale (log scale so whales stay on screen).
export function antScale(pct, rank) {
  const lo = Math.log10(0.001), hi = Math.log10(5);
  const t = Math.min(1, Math.max(0, (Math.log10(Math.max(pct, 1e-6)) - lo) / (hi - lo)));
  return (0.9 + 4.1 * Math.pow(t, 1.15)) * (rank === 0 ? 1.15 : 1);
}

export const TIERS = {
  queen: { name: 'Queen', color: '#d79a2b' },
  major: { name: 'Major', color: '#8f2c12' },
  soldier: { name: 'Soldier', color: '#5c2416' },
  worker: { name: 'Worker', color: '#2b1c14' },
  ghost: { name: 'Excluded', color: '#5a5a5a' },
};

export function tierOf(pct, rank, excluded) {
  if (excluded) return 'ghost';
  if (rank === 0) return 'queen';
  if (pct >= 1) return 'major';
  if (pct >= 0.1) return 'soldier';
  return 'worker';
}
