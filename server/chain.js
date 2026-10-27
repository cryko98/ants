// Read-only Solana access over plain JSON-RPC (handles v0 and v1 transactions).
import { decodeAddress, findProgramAddress, isOnCurve } from './pubkey.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pump.fun Holder Rewards: fees for a coin accumulate in this system-owned PDA and are paid out from it.
export function holderRewardsVault(mint) {
  return findProgramAddress([new TextEncoder().encode('holder-rewards'), decodeAddress(mint)], PUMP_PROGRAM)[0];
}

// The coin's pump.fun bonding curve. For custom-pair coins it holds a token account of the quote mint.
export function bondingCurveAddress(mint) {
  return findProgramAddress([new TextEncoder().encode('bonding-curve'), decodeAddress(mint)], PUMP_PROGRAM)[0];
}

export function createChain(cfg) {
  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 429 && attempt < 6) {
        await sleep(500 * 2 ** attempt); // 0.5s .. 16s
        continue;
      }
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      return res.json();
    }
  }

  async function rpc(method, params) {
    const json = await post({ jsonrpc: '2.0', id: 1, method, params });
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }

  // Several calls in one HTTP request; results come back in request order (null on per-call error).
  async function rpcBatch(method, paramsList) {
    if (!paramsList.length) return [];
    const json = await post(paramsList.map((params, id) => ({ jsonrpc: '2.0', id, method, params })));
    const byId = new Map((Array.isArray(json) ? json : [json]).map((r) => [r.id, r.error ? null : r.result]));
    return paramsList.map((_, id) => byId.get(id) ?? null);
  }

  async function holdersViaDas() {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const r = await rpc('getTokenAccounts', { mint: cfg.token.mint, page, limit: 1000, options: { showZeroBalance: false } });
      const accounts = r.token_accounts ?? [];
      for (const a of accounts) out.push([a.owner, BigInt(a.amount)]);
      if (accounts.length < 1000) break;
    }
    return out;
  }

  async function holdersViaGpa() {
    const out = [];
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const filters = [{ memcmp: { offset: 0, bytes: cfg.token.mint } }];
      if (programId === TOKEN_PROGRAM) filters.push({ dataSize: 165 });
      const accounts = await rpc('getProgramAccounts', [programId, { encoding: 'jsonParsed', filters }]);
      for (const { account } of accounts) {
        const info = account.data?.parsed?.info;
        if (info) out.push([info.owner, BigInt(info.tokenAmount.amount)]);
      }
    }
    return out;
  }

  return {
    rpc,

    async supply() {
      const { value } = await rpc('getTokenSupply', [cfg.token.mint]);
      return { supply: BigInt(value.amount), decimals: value.decimals };
    },

    // Map(owner -> raw amount), per wallet. Off-curve owners (bonding curve, AMM pools) are dropped.
    async holders() {
      let rows;
      if (cfg.holderSource === 'das') rows = await holdersViaDas();
      else if (cfg.holderSource === 'gpa') rows = await holdersViaGpa();
      else rows = await holdersViaDas().catch(() => holdersViaGpa());
      const byOwner = new Map();
      for (const [owner, amount] of rows) if (amount > 0n) byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
      for (const owner of byOwner.keys()) {
        if (!isOnCurve(owner)) byOwner.delete(owner);
      }
      return byOwner;
    },

    async balance(address) {
      return BigInt((await rpc('getBalance', [address, { commitment: 'confirmed' }])).value);
    },

    // Signatures touching `address` newer than `until`, oldest first.
    async signaturesSince(address, until, maxPages = 20) {
      const all = [];
      let before;
      for (let page = 0; page < maxPages; page++) {
        const opts = { limit: 1000, commitment: 'confirmed' };
        if (until) opts.until = until;
        if (before) opts.before = before;
        const batch = await rpc('getSignaturesForAddress', [address, opts]);
        all.push(...batch);
        if (batch.length < 1000) break;
        before = batch.at(-1).signature;
      }
      return all.reverse();
    },

    async transactions(signatures) {
      const opts = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
      const out = await rpcBatch('getTransaction', signatures.map((s) => [s, opts])).catch(() => signatures.map(() => null));
      // Some RPCs (incl. the public one) reject or throttle batches: fill the gaps one by one.
      for (let i = 0; i < out.length; i++) {
        if (out[i] == null) out[i] = await rpc('getTransaction', [signatures[i], opts]).catch(() => null);
      }
      return out;
    },

    // Token accounts held by `owner` (both token programs): [{ address, mint, amount, decimals }].
    async tokenAccounts(owner) {
      const out = [];
      for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
        const r = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
        for (const a of r.value) {
          const info = a.account.data.parsed.info;
          out.push({ address: a.pubkey, mint: info.mint, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals });
        }
      }
      return out;
    },

    // Best-effort symbol for a token: Token-2022 metadata, then Helius DAS, then null.
    async tokenSymbol(mint) {
      try {
        const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
        const meta = acc?.value?.data?.parsed?.info?.extensions?.find((e) => e.extension === 'tokenMetadata');
        if (meta?.state?.symbol) return meta.state.symbol;
      } catch {}
      try {
        const asset = await rpc('getAsset', { id: mint });
        if (asset?.content?.metadata?.symbol) return asset.content.metadata.symbol;
      } catch {}
      return null;
    },

    // USD prices for the coin, the reward token and SOL (Jupiter, DexScreener fallback for the coin).
    async prices(rewardMint) {
      const out = { token: null, reward: null, sol: null };
      const ids = [...new Set([cfg.token.mint, rewardMint, WSOL])].join(',');
      try {
        const r = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`)).json();
        out.token = r?.[cfg.token.mint]?.usdPrice ?? null;
        out.reward = r?.[rewardMint]?.usdPrice ?? null;
        out.sol = r?.[WSOL]?.usdPrice ?? null;
      } catch {}
      if (out.token == null) {
        try {
          const r = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cfg.token.mint}`)).json();
          const p = Number(r?.pairs?.[0]?.priceUsd);
          if (p > 0) out.token = p;
        } catch {}
      }
      return out;
    },
  };
}

export { WSOL };
