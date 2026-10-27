// Read-only indexer for a pump.fun Holder Rewards coin.
//
// Each tick:
//   1. snapshot the holders (and diff them into join / leave / whale events)
//   2. read the holder-rewards vault balance and USD prices
//   3. walk new vault transactions oldest-first: every DistributeFeeToHolders is a real payout,
//      every other inflow is creator fees landing in the vault
//   4. publish a compact snapshot for the site
//
// Everything here is derived from the chain, so the stored index is only a cache.
import { createChain, holderRewardsVault } from './chain.js';

const LAMPORTS = 1e9;
const MAX_EVENTS = 250;
// pump.fun reserves ~US$0.01 per eligible holder for costs on SOL pairs, and pays only above ~US$20 on top.
const RESERVE_USD_PER_HOLDER = 0.01;
const MIN_POT_USD = 20;
const RENT_EXEMPT_MIN = 890_880; // lamports, 0-byte account

export function createIndexer({ cfg, storage }) {
  const chain = createChain(cfg);
  const vault = holderRewardsVault(cfg.token.mint);
  const excluded = new Set(cfg.excludeWallets);

  const emptyIndex = () => ({
    version: 1,
    cursor: null, // newest vault signature processed
    supply: null,
    decimals: 6,
    holders: {}, // owner -> raw amount (string) at the last tick
    received: {}, // owner -> lamports paid to it by pump.fun (string)
    totalDistributed: '0',
    totalInflow: '0',
    payouts: 0,
    lastPayoutAt: 0,
    events: [],
  });

  async function tick(budgetMs = 20000) {
    const t0 = Date.now();
    const index = (await storage.get('index')) ?? emptyIndex();
    const pushEvent = (ev) => {
      index.events.push(ev);
      if (index.events.length > MAX_EVENTS) index.events.splice(0, index.events.length - MAX_EVENTS);
    };

    if (!index.supply) {
      const { supply, decimals } = await chain.supply();
      index.supply = supply.toString();
      index.decimals = decimals;
    }

    // 1. holders
    const current = await chain.holders();
    const known = Object.keys(index.holders).length;
    if (known > 10 && current.size < known * 0.2) throw new Error(`holder scan returned ${current.size} of ~${known}; keeping the last snapshot`);
    const firstRun = known === 0;
    const whale = BigInt(index.supply) / 200n; // a jump of >= 0.5% of supply
    const now = Date.now();
    for (const [owner, amount] of current) {
      const prev = BigInt(index.holders[owner] ?? '0');
      if (!firstRun) {
        if (prev === 0n) pushEvent({ type: 'join', owner, t: now });
        else if (amount - prev >= whale) pushEvent({ type: 'whale', owner, amount: (amount - prev).toString(), t: now });
      }
    }
    if (!firstRun) for (const owner of Object.keys(index.holders)) if (!current.has(owner)) pushEvent({ type: 'leave', owner, t: now });
    index.holders = Object.fromEntries([...current].map(([o, a]) => [o, a.toString()]));

    // 2. vault + prices
    const [vaultLamports, prices] = await Promise.all([chain.balance(vault), chain.prices()]);

    // 3. payouts, oldest first, within the time budget
    const sigs = (await chain.signaturesSince(vault, index.cursor)).filter((s) => !s.err);
    for (let i = 0; i < sigs.length && Date.now() - t0 < budgetMs; i += 20) {
      const chunk = sigs.slice(i, i + 20);
      const txs = await chain.transactions(chunk.map((s) => s.signature));
      for (let k = 0; k < chunk.length; k++) {
        const tx = txs[k];
        if (!tx) {
          // not retrievable yet: stop here and retry from this point next tick
          i = sigs.length;
          break;
        }
        applyTransaction(index, tx, chunk[k], pushEvent);
        index.cursor = chunk[k].signature;
      }
    }

    // 4. publish
    const snapshot = buildSnapshot(index, { vaultLamports, prices, backlog: sigs.length });
    await storage.set('index', index);
    await storage.set('snapshot', snapshot);
    return snapshot;
  }

  function applyTransaction(index, tx, sigInfo, pushEvent) {
    if (tx.meta?.err) return;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const signers = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey));
    const vi = keys.indexOf(vault);
    if (vi < 0) return;
    const delta = (i) => BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    const t = (tx.blockTime ?? sigInfo.blockTime ?? Date.now() / 1000) * 1000;
    const isDistribution = (tx.meta.logMessages ?? []).some((l) => l.includes('Instruction: DistributeFeeToHolders'));

    if (isDistribution) {
      const to = [];
      let sum = 0n;
      keys.forEach((k, i) => {
        if (i === vi || signers.has(k)) return;
        const d = delta(i);
        if (d > 0n) {
          to.push([k, d.toString()]);
          sum += d;
          index.received[k] = (BigInt(index.received[k] ?? '0') + d).toString();
        }
      });
      if (!to.length) return;
      index.totalDistributed = (BigInt(index.totalDistributed) + sum).toString();
      index.payouts += 1;
      index.lastPayoutAt = Math.max(index.lastPayoutAt, t);
      pushEvent({ type: 'payout', sig: sigInfo.signature, lamports: sum.toString(), to, t });
    } else if (delta(vi) > 0n) {
      index.totalInflow = (BigInt(index.totalInflow) + delta(vi)).toString();
      pushEvent({ type: 'claim', sig: sigInfo.signature, lamports: delta(vi).toString(), t });
    }
  }

  function buildSnapshot(index, { vaultLamports, prices, backlog }) {
    const div = 10 ** index.decimals;
    const supply = Number(BigInt(index.supply)) / div;
    const holders = Object.entries(index.holders).map(([o, raw]) => {
      const a = Number(BigInt(raw)) / div;
      const eligible = !excluded.has(o) && (prices.token == null || a * prices.token >= cfg.minEligibleUsd);
      return { o, a, p: (a / supply) * 100, x: excluded.has(o) ? 1 : 0, e: eligible ? 1 : 0, recv: Number(BigInt(index.received[o] ?? '0')) / LAMPORTS };
    });
    holders.sort((a, b) => b.a - a.a);

    // Estimated share of the next payout for each eligible holder.
    const eligibleCount = holders.filter((h) => h.e).length;
    const eligibleTotal = holders.reduce((s, h) => s + (h.e ? h.a : 0), 0) || 1;
    // The vault is a plain system account: its rent-exempt minimum is never paid out.
    const vaultSol = Math.max(0, Number(vaultLamports) - RENT_EXEMPT_MIN) / LAMPORTS;
    const reserveSol = prices.sol ? (eligibleCount * RESERVE_USD_PER_HOLDER) / prices.sol : 0;
    const payable = Math.max(0, vaultSol - reserveSol);
    for (const h of holders) h.est = h.e ? (payable * h.a) / eligibleTotal : 0;

    const earners = Object.entries(index.received)
      .map(([o, l]) => ({ o, recv: Number(BigInt(l)) / LAMPORTS }))
      .sort((a, b) => b.recv - a.recv)
      .slice(0, 25)
      .map((e) => ({ ...e, a: (Number(BigInt(index.holders[e.o] ?? '0')) / div) || 0, p: ((Number(BigInt(index.holders[e.o] ?? '0')) / div) / supply) * 100, x: 0 }));

    return {
      mode: 'live',
      token: { ...cfg.token, supply, decimals: index.decimals, priceUsd: prices.token },
      vault,
      pot: {
        balance: vaultSol,
        solUsd: prices.sol,
        // pump.fun distributes once the vault covers the per-holder reserve plus ~US$20
        thresholdSol: prices.sol ? reserveSol + MIN_POT_USD / prices.sol : null,
      },
      stats: {
        totalDistributed: Number(BigInt(index.totalDistributed)) / LAMPORTS,
        totalInflow: Number(BigInt(index.totalInflow)) / LAMPORTS,
        payouts: index.payouts,
        paidHolders: Object.keys(index.received).length,
        lastPayoutAt: index.lastPayoutAt,
        holderCount: holders.length,
        eligibleCount,
        minEligibleUsd: cfg.minEligibleUsd,
        backlog,
      },
      holders: holders.slice(0, cfg.publicHolderLimit),
      earners,
      events: index.events.slice(-120),
      updatedAt: Date.now(),
    };
  }

  // Lookup for wallets beyond the rendered top N.
  async function holder(owner) {
    const index = await storage.get('index');
    if (!index || (!index.holders[owner] && !index.received[owner])) return null;
    const a = Number(BigInt(index.holders[owner] ?? '0')) / 10 ** index.decimals;
    return { o: owner, a, p: (a / (Number(BigInt(index.supply)) / 10 ** index.decimals)) * 100, recv: Number(BigInt(index.received[owner] ?? '0')) / LAMPORTS };
  }

  return { tick, holder, vault };
}
