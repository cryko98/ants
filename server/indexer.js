// Read-only indexer for a pump.fun Holder Rewards coin.
//
// Each sync:
//   1. snapshot the holders (and diff them into join / leave / whale events)
//   2. find the reward asset (SOL, or the pair token sitting in the vault) and read the vault balance
//   3. walk new vault transactions oldest-first: every DistributeFeeToHolders is a real payout,
//      any other increase is creator fees landing in the vault
//   4. publish a compact snapshot for the site
//
// Everything is derived from the chain; storage is only a cache of that work.
import { bondingCurveAddress, createChain, holderRewardsVault, WSOL } from './chain.js';

const MAX_EVENTS = 250;
// pump.fun reserves this much per eligible holder for distribution costs and pays only above
// ~US$20 on top (https://pump.fun/docs/fees).
const RESERVE_USD = { sol: 0.01, token: 0.2 };
const MIN_POT_USD = 20;
const RENT_EXEMPT_MIN = 890_880n; // lamports of a 0-byte account, never paid out

const big = (v) => BigInt(v ?? 0);

export function createIndexer({ cfg, storage }) {
  const chain = createChain(cfg);
  const vault = holderRewardsVault(cfg.token.mint);
  const bondingCurve = bondingCurveAddress(cfg.token.mint);
  const excluded = new Set(cfg.excludeWallets);

  const emptyMeta = () => ({
    version: 2,
    cursor: null, // newest vault signature processed
    supply: null,
    decimals: 6,
    reward: null, // { mint, symbol, decimals }
    totalDistributed: '0', // in reward base units
    totalInflow: '0',
    payouts: 0,
    lastPayoutAt: 0,
    events: [],
  });

  // Decide what the rewards are paid in (the coin's pair asset). REWARD_MINT wins; otherwise the
  // bonding curve tells us: a custom-pair curve holds a token account for its quote mint, a SOL-pair
  // curve holds only the coin. The vault is the fallback (it may be empty before the first fees).
  // A SOL answer is re-checked until the first payout, so an early wrong guess can't stick.
  async function resolveReward(meta) {
    const settled = meta.payouts > 0 || meta.totalInflow !== '0';
    if (meta.reward && (meta.reward.mint !== WSOL || settled)) return meta.reward;
    let mint = cfg.rewardMint;
    if (!mint) {
      const curveQuote = (await chain.tokenAccounts(bondingCurve)).find((a) => a.mint !== cfg.token.mint && a.mint !== WSOL);
      if (curveQuote) mint = curveQuote.mint;
      else if ((await chain.balance(vault)) === 0n) {
        mint = (await chain.tokenAccounts(vault)).find((a) => a.mint !== WSOL)?.mint;
      }
      mint ??= WSOL;
    }
    if (mint === WSOL) return (meta.reward = { mint: WSOL, symbol: 'SOL', decimals: 9 });
    const { decimals } = (await chain.rpc('getTokenSupply', [mint])).value;
    const symbol = cfg.rewardSymbol || (await chain.tokenSymbol(mint)) || mint.slice(0, 4);
    return (meta.reward = { mint, symbol, decimals });
  }

  async function vaultBalance(reward) {
    if (reward.mint === WSOL) {
      const lamports = await chain.balance(vault);
      return lamports > RENT_EXEMPT_MIN ? lamports - RENT_EXEMPT_MIN : 0n;
    }
    return (await chain.tokenAccounts(vault)).filter((a) => a.mint === reward.mint).reduce((s, a) => s + a.amount, 0n);
  }

  async function sync(budgetMs = 20000) {
    const t0 = Date.now();
    const meta = (await storage.getJSON('meta')) ?? emptyMeta();
    const pushEvent = (ev) => {
      meta.events.push(ev);
      if (meta.events.length > MAX_EVENTS) meta.events.splice(0, meta.events.length - MAX_EVENTS);
    };

    if (!meta.supply) {
      const { supply, decimals } = await chain.supply();
      meta.supply = supply.toString();
      meta.decimals = decimals;
    }

    // 1. holders
    const previous = (await storage.getMap('holders')) ?? {};
    const current = await chain.holders();
    const known = Object.keys(previous).length;
    if (known > 10 && current.size < known * 0.2) throw new Error(`holder scan returned ${current.size} of ~${known}; keeping the last snapshot`);
    const firstRun = known === 0;
    const whale = big(meta.supply) / 200n; // a jump of >= 0.5% of supply
    const now = Date.now();
    if (!firstRun) {
      for (const [owner, amount] of current) {
        const prev = big(previous[owner]);
        if (prev === 0n) pushEvent({ type: 'join', owner, t: now });
        else if (amount - prev >= whale) pushEvent({ type: 'whale', owner, amount: (amount - prev).toString(), t: now });
      }
      for (const owner of Object.keys(previous)) if (!current.has(owner)) pushEvent({ type: 'leave', owner, t: now });
    }
    const holders = Object.fromEntries([...current].map(([o, a]) => [o, a.toString()]));
    await storage.replaceMap('holders', holders);

    // 2. reward asset, vault, prices
    const reward = await resolveReward(meta);
    const [vaultRaw, prices] = await Promise.all([vaultBalance(reward), chain.prices(reward.mint)]);
    if (reward.mint === WSOL) prices.reward = prices.sol;

    // 3. payouts, oldest first, within the time budget
    const received = {}; // owner -> base units credited during this sync
    const sigs = (await chain.signaturesSince(vault, meta.cursor)).filter((s) => !s.err);
    let processed = 0;
    outer: for (let i = 0; i < sigs.length && Date.now() - t0 < budgetMs; i += 20) {
      const chunk = sigs.slice(i, i + 20);
      const txs = await chain.transactions(chunk.map((s) => s.signature));
      for (let k = 0; k < chunk.length; k++) {
        if (!txs[k]) break outer; // not retrievable yet: resume from here next sync
        applyTransaction(meta, reward, txs[k], chunk[k], pushEvent, received);
        meta.cursor = chunk[k].signature;
        processed++;
      }
    }

    // Credits and the cursor move together so a crash can't double count or skip.
    await storage.commit({ meta, incr: { received } });

    const totals = (await storage.getMap('received')) ?? {};
    const snapshot = buildSnapshot({ meta, reward, holders, totals, vaultRaw, prices, backlog: sigs.length - processed });
    await storage.setJSON('snapshot', snapshot);
    return snapshot;
  }

  // Balance changes for the reward asset in one transaction: [{ owner, delta }] (owner = wallet).
  function rewardDeltas(tx, reward) {
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    if (reward.mint === WSOL) {
      return keys.map((owner, i) => ({ owner, delta: big(tx.meta.postBalances[i]) - big(tx.meta.preBalances[i]) }));
    }
    const rows = new Map();
    for (const [list, sign] of [[tx.meta.preTokenBalances, -1n], [tx.meta.postTokenBalances, 1n]]) {
      for (const b of list ?? []) {
        if (b.mint !== reward.mint) continue;
        const r = rows.get(b.accountIndex) ?? { owner: b.owner, delta: 0n };
        r.delta += sign * big(b.uiTokenAmount.amount);
        rows.set(b.accountIndex, r);
      }
    }
    return [...rows.values()];
  }

  function applyTransaction(meta, reward, tx, sigInfo, pushEvent, received) {
    if (tx.meta?.err) return;
    const signers = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey));
    const deltas = rewardDeltas(tx, reward);
    const vaultDelta = deltas.filter((d) => d.owner === vault).reduce((s, d) => s + d.delta, 0n);
    const t = (tx.blockTime ?? sigInfo.blockTime ?? Date.now() / 1000) * 1000;
    const isDistribution = (tx.meta.logMessages ?? []).some((l) => l.includes('Instruction: DistributeFeeToHolders'));

    if (isDistribution) {
      // Holders are everyone credited except the vault and the signer (pump.fun's crank,
      // which is reimbursed for its costs from the same vault).
      const byOwner = new Map();
      for (const { owner, delta } of deltas) {
        if (!owner || owner === vault || signers.has(owner) || delta <= 0n) continue;
        byOwner.set(owner, (byOwner.get(owner) ?? 0n) + delta);
      }
      if (!byOwner.size) return;
      let sum = 0n;
      const to = [];
      for (const [owner, d] of byOwner) {
        to.push([owner, d.toString()]);
        received[owner] = (received[owner] ?? 0n) + d;
        sum += d;
      }
      meta.totalDistributed = (big(meta.totalDistributed) + sum).toString();
      meta.payouts += 1;
      meta.lastPayoutAt = Math.max(meta.lastPayoutAt, t);
      pushEvent({ type: 'payout', sig: sigInfo.signature, amount: sum.toString(), to, t });
    } else if (vaultDelta > 0n) {
      meta.totalInflow = (big(meta.totalInflow) + vaultDelta).toString();
      pushEvent({ type: 'claim', sig: sigInfo.signature, amount: vaultDelta.toString(), t });
    }
  }

  function buildSnapshot({ meta, reward, holders, totals, vaultRaw, prices, backlog }) {
    const div = 10 ** meta.decimals;
    const unit = 10 ** reward.decimals;
    const supply = Number(big(meta.supply)) / div;
    const rows = Object.entries(holders).map(([o, raw]) => {
      const a = Number(big(raw)) / div;
      const eligible = !excluded.has(o) && (prices.token == null || a * prices.token >= cfg.minEligibleUsd);
      return { o, a, p: (a / supply) * 100, x: excluded.has(o) ? 1 : 0, e: eligible ? 1 : 0, recv: Number(big(totals[o])) / unit };
    });
    rows.sort((a, b) => b.a - a.a);

    // Estimated share of the next payout for each eligible holder.
    const eligibleCount = rows.filter((h) => h.e).length;
    const eligibleTotal = rows.reduce((s, h) => s + (h.e ? h.a : 0), 0) || 1;
    const vaultAmount = Number(vaultRaw) / unit;
    const reserveUsd = eligibleCount * (reward.mint === WSOL ? RESERVE_USD.sol : RESERVE_USD.token);
    const reserve = prices.reward ? reserveUsd / prices.reward : 0;
    const payable = Math.max(0, vaultAmount - reserve);
    for (const h of rows) h.est = h.e ? (payable * h.a) / eligibleTotal : 0;

    const earners = Object.entries(totals)
      .map(([o, v]) => {
        const a = Number(big(holders[o])) / div;
        return { o, a, p: (a / supply) * 100, x: excluded.has(o) ? 1 : 0, recv: Number(big(v)) / unit };
      })
      .sort((a, b) => b.recv - a.recv)
      .slice(0, 25);

    return {
      mode: 'live',
      token: { ...cfg.token, supply, decimals: meta.decimals, priceUsd: prices.token },
      reward: { ...reward, priceUsd: prices.reward },
      vault,
      pot: {
        balance: vaultAmount,
        usd: prices.reward ? vaultAmount * prices.reward : null,
        // pump.fun distributes once the vault covers the per-holder reserve plus ~US$20
        threshold: prices.reward ? reserve + MIN_POT_USD / prices.reward : null,
      },
      stats: {
        totalDistributed: Number(big(meta.totalDistributed)) / unit,
        totalInflow: Number(big(meta.totalInflow)) / unit,
        payouts: meta.payouts,
        paidHolders: Object.keys(totals).length,
        lastPayoutAt: meta.lastPayoutAt,
        holderCount: rows.length,
        eligibleCount,
        minEligibleUsd: cfg.minEligibleUsd,
        backlog,
      },
      holders: rows.slice(0, cfg.publicHolderLimit),
      earners,
      events: meta.events.slice(-120),
      updatedAt: Date.now(),
    };
  }

  // Lookup for wallets beyond the rendered top N.
  async function holder(owner) {
    const [meta, holders, totals] = await Promise.all([storage.getJSON('meta'), storage.getMap('holders'), storage.getMap('received')]);
    if (!meta?.reward || (!holders?.[owner] && !totals?.[owner])) return null;
    const a = Number(big(holders?.[owner])) / 10 ** meta.decimals;
    return { o: owner, a, p: (a / (Number(big(meta.supply)) / 10 ** meta.decimals)) * 100, recv: Number(big(totals?.[owner])) / 10 ** meta.reward.decimals };
  }

  return { sync, holder, vault };
}
