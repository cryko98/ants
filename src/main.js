import './style.css';
import * as THREE from 'three';
import { createWorld } from './scene/world.js';
import { loadAntVAT } from './scene/antVAT.js';
import { createColony } from './scene/colony.js';
import { TIERS, tierOf } from './scene/tiers.js';
import { icons } from './icons.js';

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
// Reward amounts: SOL, or a pair token whose payouts can be tiny fractions.
const amt = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  if (n >= 10000) return compact(n);
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.0001) return n.toFixed(4);
  return n.toPrecision(2);
};
const R = () => state?.reward?.symbol ?? 'SOL';
const units = (raw) => Number(raw) / 10 ** (state?.reward?.decimals ?? 9);
const compact = (n) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const solscan = (kind, id) => `https://solscan.io/${kind}/${id}`;

const world = createWorld($('scene'));
const { renderer, scene, camera, controls, composer } = world;

let colony = null;
let state = null;
// Dev-only hooks for debugging and for scripting the promo video recording.
if (import.meta.env.DEV) {
  window.__ants = {
    camera,
    controls,
    get colony() {
      return colony;
    },
    get state() {
      return state;
    },
    handleEvent: (ev) => handleEvent(ev),
    flyTo: (...a) => flyTo(...a),
    selectAnt: (...a) => selectAnt(...a),
    enter: () => enterColony(),
    camHook: null, // (dt) => void, runs before the controls update each frame
  };
}
// Record mode (dev only): time advances in fixed steps driven by __ants.step(), so a slow
// machine can still capture a smooth 30 fps video frame by frame.
const RECORD = import.meta.env.DEV && !!window.__antsRecord;
let follow = false;
let flight = null;
let shake = 0;
let tab = 'feed';
let clockSkew = 0;
let introOpen = false;
let lastInteraction = performance.now();
let myWallet = '';
try {
  myWallet = localStorage.getItem('ants:wallet') || '';
} catch {}
$('finder-input').value = myWallet;
const popups = [];

// ---------- boot ----------
(async function boot() {
  try {
    const vat = await loadAntVAT('/models/ant.glb');
    colony = createColony(scene, vat);
    await poll(true);
    if (!RECORD) setInterval(() => poll(false), 4000);
    $('loader').classList.add('done');
    let seen = false;
    try {
      seen = !!localStorage.getItem('ants:entered');
    } catch {}
    if (seen) enterColony();
    else {
      // Hero over a slow, wide orbit of the colony.
      camera.position.set(0, 70, 120);
      $('intro').hidden = false;
      document.body.classList.add('intro-on');
      introOpen = true;
    }
  } catch (e) {
    console.error(e);
    $('loader-text').textContent = 'The colony failed to wake up. Refresh to try again.';
  }
})();

function enterColony() {
  introOpen = false;
  $('intro').classList.add('gone');
  document.body.classList.remove('intro-on');
  try {
    localStorage.setItem('ants:entered', '1');
  } catch {}
  flyTo(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 34, 58), 3.2);
}
$('intro-enter').addEventListener('click', enterColony);

// Numbers glide to their new value instead of jumping.
const tweens = new Map();
function tweenText(id, value, fmt) {
  const t = tweens.get(id);
  if (t) t.target = value;
  else {
    tweens.set(id, { el: $(id), cur: value, target: value, fmt });
    $(id).textContent = fmt(value);
  }
}
function stepTweens(dt) {
  for (const t of tweens.values()) {
    if (t.cur === t.target) continue;
    t.cur += (t.target - t.cur) * Math.min(1, dt * 3.5);
    if (Math.abs(t.target - t.cur) < Math.abs(t.target) * 1e-4 + 1e-6) t.cur = t.target;
    t.el.textContent = t.fmt(t.cur);
  }
}

async function poll(first) {
  let next;
  try {
    next = await (await fetch('/api/state', { cache: 'no-store' })).json();
  } catch {
    return;
  }
  state = next;
  clockSkew = state.now - Date.now(); // server clock vs ours, for "x ago" labels
  // Stash crystals scale against ~3x the average holder's share of the vault.
  const stashUnit = (state.pot.balance / Math.max(1, state.stats.eligibleCount)) * 3 || 0.001;
  const changed = colony.sync(state.holders, { potUsd: state.pot.usd ?? 0, stashUnit });
  if (changed) world.updatePaths(colony.paths());
  // Events are keyed, not timestamped: payouts can be indexed after newer holder events.
  const fresh = state.events.filter((ev) => !seenEvents.has(eventKey(ev)));
  for (const ev of fresh) seenEvents.add(eventKey(ev));
  if (first) renderStatic();
  else if (!RECORD) fresh.forEach(handleEvent);
  renderStats();
  renderList(!first);
  if (colony.selected) renderAntPanel(colony.selected);
}

// ---------- events -> scene + toasts ----------
function handleEvent(ev) {
  if (ev.type === 'payout') {
    let i = 0;
    for (const [owner, lamports] of ev.to) {
      const amount = units(lamports);
      // stagger so a batch reads as a wave of deliveries
      setTimeout(() => {
        const ant = colony.payout(owner, amount);
        if (ant) popup(ant.home, `+${amt(amount)} ${R()}`);
      }, i++ * 140);
    }
  } else if (ev.type === 'claim') {
    colony.claim(units(ev.amount));
    toast(`Creator fees landed in the rewards vault: <b>+${amt(units(ev.amount))} ${R()}</b>`);
  } else if (ev.type === 'whale') {
    shake = 1;
    const tokens = Number(ev.amount) / 10 ** state.token.decimals;
    toast(`${icons.ant} Whale alert! <b>${short(ev.owner)}</b> just grew by <b>${compact(tokens)}</b>`);
  }
}

const seenEvents = new Set();
function eventKey(ev) {
  return ev.sig ? `${ev.type}:${ev.sig}` : `${ev.type}:${ev.owner}:${ev.t}`;
}

function toast(html) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  $('toasts').append(el);
  el.addEventListener('animationend', () => el.remove());
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
}

function popup(pos, text) {
  if (popups.length > 30) popups.shift().el.remove();
  const el = document.createElement('div');
  el.className = 'pop';
  el.textContent = text;
  $('labels').append(el);
  popups.push({ el, pos: pos.clone(), t: 0 });
}

// ---------- UI ----------
function renderStatic() {
  const { token, vault, mode } = state;
  document.querySelectorAll('[data-bind="name"]').forEach((e) => (e.textContent = token.name));
  document.querySelectorAll('[data-bind="symbol"]').forEach((e) => (e.textContent = `$${token.symbol}`));
  document.querySelectorAll('[data-bind="reward"]').forEach((e) => (e.textContent = R()));
  document.title = `${token.name} ($${token.symbol}) — every holder is an ant`;
  $('ca').querySelector('.ca-value').textContent = token.mint || 'demo mode — no token yet';
  $('link-buy').href = $('intro-buy').href = token.mint ? `https://pump.fun/coin/${token.mint}` : 'https://pump.fun';
  $('link-chart').href = token.mint ? `https://dexscreener.com/solana/${token.mint}` : 'https://dexscreener.com/solana';
  if (token.linkX) Object.assign($('link-x'), { href: token.linkX, hidden: false });
  if (token.linkTelegram) Object.assign($('link-tg'), { href: token.linkTelegram, hidden: false });
  const live = mode === 'live';
  $('how-wallet').textContent = live ? vault : 'available once the coin is live';
  if (live) $('how-wallet').href = solscan('account', vault);
  else $('how-wallet').removeAttribute('href');
  document.querySelectorAll('[data-bind="min-usd"]').forEach((e) => (e.textContent = state.stats.minEligibleUsd));
  const m = $('mode');
  m.textContent = live ? 'LIVE' : 'DEMO';
  m.classList.toggle('live', live);
}

function renderStats() {
  const { pot, stats } = state;
  const s4 = (v) => amt(v);
  const count = (v) => Math.round(v).toLocaleString('en');
  tweenText('pot-sol', pot.balance, s4);
  tweenText('paid-sol', stats.totalDistributed, s4);
  tweenText('paid-wallets', stats.paidHolders, count);
  tweenText('holders', stats.holderCount, count);
  tweenText('i-paid', stats.totalDistributed, s4);
  tweenText('i-ants', stats.holderCount, count);
  tweenText('i-pot', pot.balance, s4);
  const usd = pot.usd != null ? ` ≈ $${pot.usd.toFixed(2)} · ` : '';
  $('pot-sub').textContent = `${usd}paid out automatically by pump.fun`;
  // Fill toward the point where pump.fun runs the next distribution.
  const fill = pot.threshold ? Math.min(1, pot.balance / pot.threshold) : 0;
  $('cycle-bar').style.width = `${fill * 100}%`;
  $('vault-bar-wrap').title = pot.threshold
    ? `Next payout once the vault reaches ~${amt(pot.threshold)} ${R()} (${Math.round(fill * 100)}%)`
    : 'Next payout once the vault covers the minimum';
  tickLastPayout();
}

function tickLastPayout() {
  if (!state) return;
  const t = state.stats.lastPayoutAt;
  $('last-payout').textContent = t ? ago(t - clockSkew) : 'not yet';
}
if (!RECORD) setInterval(tickLastPayout, 1000);

function renderList(animate) {
  const list = $('list');
  const prevTop = list.dataset.top;
  let html = '';
  if (tab === 'feed') {
    const feed = [...state.events].sort((a, b) => b.t - a.t).slice(0, 40);
    for (const ev of feed) html += feedRow(ev);
    list.dataset.top = feed[0] ? String(feed[0].t) : '';
  } else {
    const rows = tab === 'earners' ? state.earners : state.holders.slice(0, 40);
    rows.forEach((h, i) => {
      const value = tab === 'earners' ? `${amt(h.recv)} ${R()}` : `${h.p.toFixed(2)}%`;
      const tier = colony.get(h.o)?.tier ?? tierOf(h.p, -1, h.x);
      const me = h.o === myWallet;
      html += `<li data-owner="${h.o}"${me ? ' class="me"' : ''}><span class="rank">${i + 1}</span><span class="dot" style="background:${TIERS[tier].color}" title="${TIERS[tier].name}"></span><span class="txt"><span class="mono">${short(h.o)}</span>${me ? '<span class="you">YOU</span>' : ''}<small>${compact(h.a)} tokens</small></span><span class="amt">${value}</span></li>`;
    });
    list.dataset.top = '';
  }
  list.innerHTML = html || '<li class="empty">Nothing here yet — the colony is just waking up.</li>';
  if (animate && tab === 'feed' && prevTop && list.dataset.top !== prevTop) list.firstElementChild?.classList.add('fresh');
}

function feedRow(ev) {
  const when = `<small>${ago(ev.t - clockSkew)}</small>`;
  const link = ev.sig && state.mode === 'live' ? ` · <a href="${solscan('tx', ev.sig)}" target="_blank" rel="noopener">tx</a>` : '';
  switch (ev.type) {
    case 'payout': {
      const n = ev.to.length;
      return `<li data-owner="${ev.to[0][0]}"><span class="ico pay">${icons.payout}</span><span class="txt">Paid to <b>${n}</b> ant${n > 1 ? 's' : ''}${link}${when}</span><span class="amt">${amt(units(ev.amount))} ${R()}</span></li>`;
    }
    case 'claim':
      return `<li><span class="ico claim">${icons.claim}</span><span class="txt">Fees into the vault${link}${when}</span><span class="amt">+${amt(units(ev.amount))}</span></li>`;
    case 'join':
      return `<li data-owner="${ev.owner}"><span class="ico join">${icons.join}</span><span class="txt"><span class="mono">${short(ev.owner)}</span> hatched${when}</span></li>`;
    case 'leave':
      return `<li><span class="ico leave">${icons.leave}</span><span class="txt"><span class="mono">${short(ev.owner)}</span> left the colony${when}</span></li>`;
    case 'whale':
      return `<li data-owner="${ev.owner}"><span class="ico whale">${icons.whale}</span><span class="txt"><span class="mono">${short(ev.owner)}</span> grew huge${when}</span><span class="amt">+${compact(Number(ev.amount) / 10 ** state.token.decimals)}</span></li>`;
    default:
      return '';
  }
}

document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    tab = b.dataset.tab;
    renderList(false);
  }),
);
$('list').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const owner = e.target.closest('li[data-owner]')?.dataset.owner;
  if (owner) findOwner(owner);
});
$('side-toggle').addEventListener('click', () => {
  const open = $('side').classList.toggle('open');
  $('side-toggle').textContent = open ? 'Close' : 'Feed';
});

$('ca').addEventListener('click', async () => {
  if (!state?.token.mint) return;
  await navigator.clipboard.writeText(state.token.mint).catch(() => {});
  $('ca').classList.add('copied');
  const v = $('ca').querySelector('.ca-value');
  v.textContent = 'Copied!';
  setTimeout(() => {
    $('ca').classList.remove('copied');
    v.textContent = state.token.mint;
  }, 1400);
});
$('how-open').addEventListener('click', () => $('how').showModal());

// ---------- find / select ----------
$('finder').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('finder-input').value.trim();
  if (!q) return;
  myWallet = q;
  try {
    localStorage.setItem('ants:wallet', q);
  } catch {}
  findOwner(q);
});

async function findOwner(owner) {
  const ant = colony.get(owner);
  if (ant) return selectAnt(ant, true);
  const res = await fetch(`/api/holder/${encodeURIComponent(owner)}`).catch(() => null);
  const f = $('finder');
  if (res?.ok) {
    const h = await res.json();
    toast(h.a > 0
      ? `That wallet holds <b>${compact(h.a)}</b> — too small to render, but it has received <b>${amt(h.recv)} ${R()}</b>`
      : `That wallet left the colony after receiving <b>${amt(h.recv)} ${R()}</b>`);
  } else {
    toast('No ant found for that wallet. Buy a bag to hatch one!');
    f.classList.remove('shake');
    void f.offsetWidth;
    f.classList.add('shake');
  }
}

function selectAnt(ant, fly) {
  colony.select(ant);
  if (!ant) {
    $('antpanel').hidden = true;
    follow = false;
    return;
  }
  renderAntPanel(ant);
  $('antpanel').hidden = false;
  if (fly) {
    const dist = 6 + ant.scale * 5;
    const dir = ant.pos.clone().setY(0).normalize();
    if (!dir.lengthSq()) dir.set(0, 0, 1);
    flyTo(ant.pos.clone(), ant.pos.clone().add(dir.multiplyScalar(dist)).setY(dist * 0.75), 1.6);
    follow = true;
    $('ap-follow').textContent = 'Unfollow';
  }
}

function renderAntPanel(ant) {
  const h = ant.data;
  $('ap-tier').textContent = `${TIERS[ant.tier].name} · #${ant.rank + 1}`;
  $('ap-addr').textContent = short(h.o);
  $('ap-addr').href = solscan('account', h.o);
  $('ap-bag').textContent = compact(h.a);
  $('ap-pct').textContent = `${h.p < 0.01 ? h.p.toFixed(4) : h.p.toFixed(2)}%`;
  $('ap-owed').textContent = amt(h.est);
  $('ap-recv').textContent = amt(h.recv);
  // The meter shows how full the vault is before pump.fun's next distribution.
  const { pot, token, stats } = state;
  $('ap-meter').style.width = `${pot.threshold ? Math.min(100, (pot.balance / pot.threshold) * 100) : 0}%`;
  if (h.x) $('ap-hint').textContent = 'This wallet is marked as team / excluded.';
  else if (h.e) $('ap-hint').textContent = 'Eligible: pump.fun pays this wallet its share automatically at the next distribution.';
  else {
    const need = token.priceUsd ? ` (about ${compact(stats.minEligibleUsd / token.priceUsd)} tokens)` : '';
    $('ap-hint').textContent = `Not eligible yet: pump.fun pays wallets holding at least $${stats.minEligibleUsd} of the coin${need}.`;
  }

  // What it takes to evolve into the next caste.
  const supply = state.token.supply;
  const next = ant.tier === 'worker' ? ['Soldier', 0.1] : ant.tier === 'soldier' ? ['Major', 1] : null;
  let evolve = '';
  if (ant.tier === 'queen') evolve = `${icons.crown} Rules the colony. The biggest bag of them all.`;
  else if (next) evolve = `Hold <b>${compact((next[1] / 100) * supply - h.a)}</b> more to evolve into a <b>${next[0]}</b>.`;
  else if (ant.tier === 'major' && state.holders[0]) evolve = `<b>${compact(state.holders[0].a - h.a)}</b> more to dethrone the <b>Queen</b>.`;
  $('ap-evolve').innerHTML = h.x ? '' : evolve;

  const mine = h.o === myWallet;
  const text = mine
    ? `My ant is a ${TIERS[ant.tier].name} in the $${state.token.symbol} colony. It has received ${amt(h.recv)} ${R()} in holder rewards so far.`
    : `Look at this ${TIERS[ant.tier].name} in the $${state.token.symbol} ant colony: ${amt(h.recv)} ${R()} in holder rewards so far.`;
  $('ap-share').href = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin)}`;
}

$('antpanel-close').addEventListener('click', () => selectAnt(null));
$('ap-follow').addEventListener('click', () => {
  follow = !follow;
  $('ap-follow').textContent = follow ? 'Unfollow' : 'Follow';
});
$('ap-copy').addEventListener('click', async () => {
  const ant = colony.selected;
  if (!ant) return;
  await navigator.clipboard.writeText(ant.owner).catch(() => {});
  $('ap-copy').textContent = 'Copied!';
  setTimeout(() => ($('ap-copy').textContent = 'Copy address'), 1300);
});

// ---------- pointer picking ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down = null;
function pickAt(e) {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return colony?.pick(raycaster);
}
const canvas = $('scene');
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
  lastInteraction = performance.now();
  flight = null;
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  const ant = pickAt(e);
  selectAnt(ant ?? null, !!ant);
});
let hoverAnt = null;
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !colony) return;
  hoverAnt = pickAt(e);
  colony.hovered = hoverAnt;
  canvas.style.cursor = hoverAnt ? 'pointer' : '';
  const tip = $('tooltip');
  if (hoverAnt) {
    tip.hidden = false;
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY}px`;
    tip.innerHTML = `<span class="mono">${short(hoverAnt.owner)}</span> · ${TIERS[hoverAnt.tier].name} · <b>${hoverAnt.data.p.toFixed(3)}%</b>`;
  } else tip.hidden = true;
});
controls.addEventListener('start', () => {
  flight = null;
  lastInteraction = performance.now();
});
controls.autoRotateSpeed = 0.35;

// ---------- camera ----------
function flyTo(target, position, duration) {
  flight = { t: 0, duration, fromT: controls.target.clone(), toT: target, fromP: camera.position.clone(), toP: position };
}

// ---------- labels ----------
const potLabel = document.createElement('div');
potLabel.className = 'pot-label';
const selLabel = document.createElement('div');
selLabel.className = 'sel-label';
selLabel.textContent = 'YOUR ANT';
const crown = document.createElement('div');
crown.className = 'crown';
crown.innerHTML = `${icons.crown}QUEEN`;
$('labels').append(potLabel, selLabel, crown);
const proj = new THREE.Vector3();
function place(el, pos) {
  proj.copy(pos).project(camera);
  const visible = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
  el.style.display = visible ? '' : 'none';
  if (visible) el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * innerWidth}px, ${(-proj.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -100%)`;
}
potLabel.style.left = potLabel.style.top = selLabel.style.left = selLabel.style.top = '0';

// ---------- loop ----------
let vClock = 0; // record-mode video time, seconds
function frame(dt, t) {
  scene.userData.tick?.(t);

  if (colony) {
    colony.update(dt, t);
    const sel = colony.selected;

    if (flight) {
      flight.t += dt / flight.duration;
      const k = THREE.MathUtils.smootherstep(Math.min(1, flight.t), 0, 1);
      if (follow && sel) flight.toT.copy(sel.pos);
      controls.target.lerpVectors(flight.fromT, flight.toT, k);
      camera.position.lerpVectors(flight.fromP, flight.toP, k);
      if (flight.t >= 1) flight = null;
    } else if (follow && sel) {
      const delta = sel.pos.clone().sub(controls.target);
      controls.target.add(delta);
      camera.position.add(delta);
    }

    if (state) {
      potLabel.innerHTML = `REWARDS VAULT<span>${amt(state.pot.balance)} ${R()}</span>`;
      place(potLabel, colony.potTop());
    }
    if (sel) {
      selLabel.style.display = '';
      selLabel.textContent = sel.owner === myWallet ? 'YOUR ANT' : short(sel.owner);
      place(selLabel, sel.pos.clone().setY(sel.pos.y + sel.scale * 0.7 + 0.4));
    } else selLabel.style.display = 'none';

    const queen = colony.queen();
    if (queen && queen !== sel && !introOpen) place(crown, queen.pos.clone().setY(queen.pos.y + queen.scale * 0.75 + 0.5));
    else crown.style.display = 'none';

    // Slow cinematic orbit behind the intro, and again after the visitor goes idle.
    const idle = !RECORD && performance.now() - lastInteraction > 15000 && !sel && !flight;
    controls.autoRotate = introOpen || idle;
    controls.autoRotateSpeed = introOpen ? 0.6 : 0.3;

    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.t += dt;
      place(p.el, p.pos.clone().setY(p.pos.y + 1.2 + p.t * 2.2));
      p.el.style.opacity = String(1 - Math.max(0, p.t - 1.6) / 0.8);
      if (p.t > 2.4) {
        p.el.remove();
        popups.splice(i, 1);
      }
    }
  }

  stepTweens(dt);
  if (RECORD) window.__ants.camHook?.(dt);
  controls.update(dt);
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 1.4);
    const a = shake * shake * 0.9;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
  }
  composer.render();
}

if (RECORD) {
  let lastPoll = 0;
  window.__ants.step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      vClock += 1 / 30;
      frame(1 / 30, vClock);
    }
    tickLastPayout();
    if (vClock - lastPoll > 4) {
      lastPoll = vClock;
      poll(false);
    }
  };
} else {
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05), clock.elapsedTime));
}
