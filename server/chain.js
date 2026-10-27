// Read-only Solana access over plain JSON-RPC (handles v0 and v1 transactions).
import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pump.fun Holder Rewards: fees for a coin accumulate in this system-owned PDA and are paid out from it.
export function holderRewardsVault(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('holder-rewards'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58();
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
        if (!PublicKey.isOnCurve(new PublicKey(owner).toBytes())) byOwner.delete(owner);
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

    // USD prices for the coin and SOL (Jupiter, falling back to DexScreener for the coin).
    async prices() {
      const out = { token: null, sol: null };
      try {
        const r = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${cfg.token.mint},${WSOL}`)).json();
        out.token = r?.[cfg.token.mint]?.usdPrice ?? null;
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
