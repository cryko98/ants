// Reads configuration from environment variables (works in Node and in Netlify Functions).
// No secrets are needed: the site only reads public on-chain data.
const str = (k, d = '') => String(process.env[k] ?? d).trim();
const num = (k, d) => {
  const v = Number(str(k, String(d)));
  return Number.isFinite(v) ? v : d;
};

export function loadConfig() {
  const mint = str('TOKEN_MINT');
  return {
    mode: mint ? 'live' : 'demo',
    token: {
      mint,
      name: str('TOKEN_NAME', 'Ant Colony'),
      symbol: str('TOKEN_SYMBOL', 'ANTS'),
      linkX: str('LINK_X'),
      linkTelegram: str('LINK_TELEGRAM'),
    },
    rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
    holderSource: str('HOLDER_SOURCE', 'auto'),
    // Optional: the asset rewards are paid in (the coin's pair). Detected from the vault when empty.
    rewardMint: str('REWARD_MINT') || null,
    rewardSymbol: str('REWARD_SYMBOL'),
    // Shown as ghost ants and left out of the reward estimates (dev, team, CEX...).
    excludeWallets: str('EXCLUDE_WALLETS').split(',').map((s) => s.trim()).filter(Boolean),
    // pump.fun only pays wallets holding at least this much (US$) of the coin.
    minEligibleUsd: num('MIN_ELIGIBLE_USD', 20),
    publicHolderLimit: num('PUBLIC_HOLDER_LIMIT', 1500),
  };
}
