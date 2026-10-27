import * as THREE from 'three';
import { createAntMaterials } from './antVAT.js';
import { groundHeight } from './world.js';
import { antScale, tierOf, TIERS } from './tiers.js';

const MAX_ANTS = 2000;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const HOME_R0 = 17;
const HOME_K = 2.05;
const STRIDE = 0.42; // body lengths per walk cycle
const MOUND_Y = 0.8; // mound height / radius
const MOUTH = { y: 0.3, z: 0.31 }; // mandibles of the normalized ant model (body length = 1)
const CUBE = 0.11; // carried sugar cube edge, in body lengths
const antMatrix = new THREE.Matrix4();
const cubeMatrix = new THREE.Matrix4();

const rand = (a, b) => a + Math.random() * (b - a);
const smooth = THREE.MathUtils.smoothstep;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function slotPosition(i, out) {
  // Golden-angle spiral, jittered so the colony doesn't look machine-placed.
  const j1 = Math.sin(i * 12.9898) * 43758.5453, j2 = Math.sin(i * 78.233) * 12345.678;
  const a = i * GOLDEN + (j1 - Math.floor(j1) - 0.5) * 0.5 / Math.sqrt(i + 1);
  const r = HOME_R0 + HOME_K * Math.sqrt(i) + (j2 - Math.floor(j2) - 0.5) * 1.6;
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  return out.set(x, groundHeight(x, z), z);
}

function moundGeometry() {
  // Upper hemisphere reshaped into a crater-topped dirt mound (keeps outward normals).
  const g = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position;
  const colors = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.min(1, Math.hypot(x, z));
    const a = Math.atan2(z, x);
    const rim = Math.exp(-((r - 0.34) ** 2) / 0.05);
    p.setY(i, r < 0.2 ? 0.04 + r * 0.6 : 0.46 * rim + (r > 0.34 ? 0.16 * (1 - r) : 0));
    const lumpy = 1 + 0.08 * Math.sin(a * 5) + 0.05 * Math.sin(a * 11 + 1);
    p.setX(i, x * lumpy);
    p.setZ(i, z * lumpy);
    const l = r < 0.2 ? 0.12 : (0.75 + rim * 0.35) * (0.95 + 0.08 * Math.sin(a * 7));
    colors.push(l, l, l);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

// Soft round sprite for particles.
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,230,170,0.8)');
  grd.addColorStop(1, 'rgba(255,200,90,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function createParticles(scene, max = 4000) {
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const vel = new Float32Array(max * 3);
  const life = new Float32Array(max);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const pts = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 0.9, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  pts.frustumCulled = false;
  scene.add(pts);
  let cursor = 0;
  return {
    emit(x, y, z, vx, vy, vz, r, g, b, l) {
      const i = cursor;
      cursor = (cursor + 1) % max;
      pos.set([x, y, z], i * 3);
      vel.set([vx, vy, vz], i * 3);
      col.set([r, g, b], i * 3);
      life[i] = l;
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        const k = i * 3;
        vel[k + 1] -= 9 * dt;
        pos[k] += vel[k] * dt;
        pos[k + 1] = Math.max(0.05, pos[k + 1] + vel[k + 1] * dt);
        pos[k + 2] += vel[k + 2] * dt;
        if (life[i] <= 0) pos[k + 1] = -100;
        else if (life[i] < 0.4) {
          col[k] *= 0.9;
          col[k + 1] *= 0.9;
          col[k + 2] *= 0.9;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}

export function createColony(scene, vat) {
  // --- Ants (one instanced, VAT-animated mesh) ---
  const { material, depth } = createAntMaterials(vat);
  const geo = vat.geometry;
  const animAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ANTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ANTS), 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAnim', animAttr);
  geo.setAttribute('aGlow', glowAttr);
  const antMesh = new THREE.InstancedMesh(geo, material, MAX_ANTS);
  antMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  antMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ANTS * 3), 3);
  antMesh.customDepthMaterial = depth;
  antMesh.castShadow = true;
  antMesh.frustumCulled = false;
  antMesh.count = 0;
  scene.add(antMesh);

  const mk = (g, m, n = MAX_ANTS, shadow = true) => {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.count = 0;
    scene.add(im);
    return im;
  };
  const sugarMat = new THREE.MeshStandardMaterial({ color: '#fff7e8', emissive: '#ffcf7a', emissiveIntensity: 0.08, roughness: 0.22, metalness: 0 });
  const homes = mk(moundGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), MAX_ANTS, false);
  homes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ANTS * 3), 3);
  const crumbs = mk(new THREE.BoxGeometry(1, 1, 1), sugarMat);
  const stash = mk(new THREE.OctahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: '#ffc94a', emissive: '#ff9a1f', emissiveIntensity: 0.75, roughness: 0.25, metalness: 0.35 }));
  const eggs = mk(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial({ color: '#f4efe2', roughness: 0.4, emissive: '#3a2f20' }));

  // --- Reward pot: a heap of sugar cubes ---
  const pot = new THREE.Group();
  scene.add(pot);
  const cubeCount = 520;
  const cubes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.62, 0.62), sugarMat, cubeCount);
  cubes.castShadow = cubes.receiveShadow = true;
  const d = new THREE.Object3D();
  for (let i = 0; i < cubeCount; i++) {
    const h = Math.pow(Math.random(), 1.6);
    const r = 4.4 * (1 - h) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    d.position.set(Math.cos(a) * r, h * 3.6 + 0.25, Math.sin(a) * r);
    d.rotation.set(rand(-0.5, 0.5), rand(0, 3), rand(-0.5, 0.5));
    d.scale.setScalar(rand(0.7, 1.15));
    d.updateMatrix();
    cubes.setMatrixAt(i, d.matrix);
  }
  pot.add(cubes);
  // Spilled sugar grains around the heap.
  const grains = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), sugarMat, 360);
  for (let i = 0; i < grains.count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 4 + Math.pow(Math.random(), 1.8) * 7;
    d.position.set(Math.cos(a) * r, 0.08, Math.sin(a) * r);
    d.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    d.scale.setScalar(rand(0.5, 1.3));
    d.updateMatrix();
    grains.setMatrixAt(i, d.matrix);
  }
  grains.receiveShadow = true;
  scene.add(grains);
  let potScale = 1;
  let potTarget = 1;
  const potRadius = () => 4.4 * potScale;

  // --- Selection marker + pheromone trail ---
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.75, 0.95, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffc451', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.visible = false;
  scene.add(ring);
  const trailGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const trail = new THREE.Line(trailGeo, new THREE.LineDashedMaterial({ color: '#ffcf6b', dashSize: 0.6, gapSize: 0.5, transparent: true, opacity: 0.85 }));
  trail.visible = false;
  scene.add(trail);

  const particles = createParticles(scene);

  // --- State ---
  const ants = new Map(); // owner -> ant
  const order = []; // instance index -> ant
  const freeSlots = new Set();
  let nextSlot = 0;
  let selected = null;
  let hovered = null;
  let stashUnit = 0.002;
  const rain = [];
  const tmpV = new THREE.Vector3();
  const color = new THREE.Color();

  function takeSlot(rank) {
    let best = -1;
    for (const s of freeSlots) if (best < 0 || Math.abs(s - rank) < Math.abs(best - rank)) best = s;
    if (best >= 0 && Math.abs(best - rank) < Math.max(8, nextSlot - rank)) {
      freeSlots.delete(best);
      return best;
    }
    return nextSlot++;
  }

  function potPoint(ant) {
    const a = Math.atan2(ant.home.z, ant.home.x) + rand(-0.9, 0.9);
    const r = potRadius() * 0.92 + ant.scale * 0.35;
    return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  }

  // --- Terrain the ants walk on: ground + every dirt mound (must match moundGeometry) ---
  const CELL = 8;
  let grid = new Map();
  const moundRadius = (ant) => 0.75 * ant.targetScale;
  function moundProfile(r) {
    if (r < 0.2) return 0.04 + r * 0.6;
    return 0.46 * Math.exp(-((r - 0.34) ** 2) / 0.05) + (r > 0.34 ? 0.16 * (1 - r) : 0);
  }
  function rebuildGrid() {
    grid = new Map();
    for (const ant of ants.values()) {
      if (ant.state === 'leaving') continue;
      const k = `${Math.floor(ant.home.x / CELL)},${Math.floor(ant.home.z / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(ant);
    }
  }
  function surfaceHeight(x, z) {
    let h = groundHeight(x, z);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = grid.get(`${cx + i},${cz + j}`);
        if (!list) continue;
        for (const m of list) {
          const hs = moundRadius(m);
          const dist = Math.hypot(x - m.home.x, z - m.home.z);
          if (dist >= hs) continue;
          const y = m.home.y + hs * MOUND_Y * moundProfile(dist / hs);
          if (y > h) h = y;
        }
      }
    }
    return h;
  }
  // Where an ant stops at home: on the crater rim facing the pot, head over the hole.
  function door(ant) {
    const len = Math.hypot(ant.home.x, ant.home.z) || 1;
    const r = moundRadius(ant) * 0.3 + ant.targetScale * 0.32;
    return (ant.doorPt ??= new THREE.Vector3()).set(ant.home.x - (ant.home.x / len) * r, 0, ant.home.z - (ant.home.z / len) * r);
  }

  function spawn(h, rank, initial) {
    const slot = takeSlot(rank);
    const home = slotPosition(slot, new THREE.Vector3());
    const scale = antScale(h.p, rank);
    const ant = {
      owner: h.o,
      data: h,
      rank,
      slot,
      home,
      scale: initial ? scale : 0.01,
      targetScale: scale,
      pos: home.clone(),
      heading: Math.atan2(-home.x, -home.z),
      state: 'rest',
      timer: rand(0, 2),
      phase: Math.random(),
      carry: false,
      hatch: initial ? 1 : 0,
      glow: 0,
      fade: 1,
      seed: Math.random() * 100,
      target: null,
      tier: tierOf(h.p, rank, h.x),
      pitch: 0,
      roll: 0,
      slope: 0,
    };
    if (initial) {
      // Scatter the colony along its routes so the first frame already looks busy.
      const pp = potPoint(ant);
      const t = Math.random();
      ant.pos.lerpVectors(door(ant), pp, t);
      ant.state = Math.random() < 0.5 ? 'out' : 'back';
      ant.carry = ant.state === 'back';
      ant.target = ant.state === 'out' ? pp : door(ant);
      ant.heading = Math.atan2(ant.target.x - ant.pos.x, ant.target.z - ant.pos.z);
    }
    ants.set(h.o, ant);
  }

  function sync(holders, meta) {
    stashUnit = meta.stashUnit || stashUnit;
    potTarget = 0.75 + 1.9 * (1 - Math.exp(-(meta.potUsd || 0) / 25)); // pile grows with the vault value in US$
    const initial = ants.size === 0;
    const seen = new Set();
    let changed = initial;
    holders.forEach((h, rank) => {
      seen.add(h.o);
      const ant = ants.get(h.o);
      if (!ant) {
        changed = true;
        return spawn(h, rank, initial);
      }
      if (Math.abs(antScale(h.p, rank) - ant.targetScale) > 0.15) changed = true;
      ant.data = h;
      ant.rank = rank;
      ant.targetScale = antScale(h.p, rank);
      ant.tier = tierOf(h.p, rank, h.x);
      if (ant.state === 'leaving') {
        ant.state = 'out';
        ant.target = potPoint(ant);
      }
    });
    for (const ant of ants.values()) {
      if (!seen.has(ant.owner) && ant.state !== 'leaving') {
        changed = true;
        ant.state = 'leaving';
        ant.carry = false;
        const a = Math.atan2(ant.pos.z, ant.pos.x) + rand(-0.3, 0.3);
        ant.target = new THREE.Vector3(Math.cos(a) * 175, 0, Math.sin(a) * 175);
      }
    }
    if (changed) rebuildGrid();
    return changed;
  }

  // Mound positions + widths for painting the worn trails.
  function paths() {
    const out = [];
    for (const ant of ants.values()) if (ant.state !== 'leaving') out.push({ x: ant.home.x, z: ant.home.z, w: ant.targetScale });
    return out;
  }

  function steer(ant, dt, speed) {
    const dx = ant.target.x - ant.pos.x;
    const dz = ant.target.z - ant.pos.z;
    const dist = Math.hypot(dx, dz);
    let want = Math.atan2(dx, dz) + Math.sin(simTime * 2.1 + ant.seed) * 0.35 * Math.min(1, dist / 6);
    let diff = ((want - ant.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    ant.heading += THREE.MathUtils.clamp(diff, -4 * dt, 4 * dt);
    const step = Math.min(dist, speed * dt);
    ant.pos.x += Math.sin(ant.heading) * step;
    ant.pos.z += Math.cos(ant.heading) * step;
    ant.phase += step / (STRIDE * ant.scale);
    return dist;
  }

  let simTime = 0;
  function update(dt, t) {
    simTime = t;
    potScale += (potTarget - potScale) * Math.min(1, dt * 1.5);
    pot.scale.setScalar(potScale);

    let n = 0;
    for (const ant of ants.values()) {
      ant.scale += (ant.targetScale - ant.scale) * Math.min(1, dt * (ant.hatch < 1 ? 0 : 2));
      // slower uphill, a little quicker downhill
      const speed = 1.5 * (0.75 + 0.5 * ant.scale) * THREE.MathUtils.clamp(1 - ant.slope * 0.7, 0.5, 1.2);
      let clip = vat.clips.walk;

      if (ant.hatch < 1) {
        ant.hatch = Math.min(1, ant.hatch + dt / 2.2);
        if (ant.hatch >= 0.72) ant.scale = ant.targetScale * smooth(ant.hatch, 0.72, 1);
        if (ant.hatch >= 1) {
          ant.state = 'out';
          ant.target = potPoint(ant);
        }
      } else if (ant.state === 'out') {
        if (steer(ant, dt, speed) < 0.25 + ant.scale * 0.2) {
          ant.state = 'bite';
          ant.timer = rand(0.8, 1.8);
        }
      } else if (ant.state === 'bite') {
        clip = vat.clips.bite;
        ant.phase += dt * 2.2;
        if ((ant.timer -= dt) <= 0) {
          ant.state = 'back';
          ant.carry = true;
          ant.target = door(ant);
        }
      } else if (ant.state === 'back') {
        ant.target = door(ant);
        if (steer(ant, dt, speed) < 0.2 + ant.scale * 0.05) {
          ant.state = 'rest';
          ant.carry = false;
          ant.timer = rand(0.6, 2.4);
        }
      } else if (ant.state === 'rest') {
        if ((ant.timer -= dt) <= 0) {
          ant.state = 'out';
          ant.target = potPoint(ant);
        }
      } else if (ant.state === 'leaving') {
        steer(ant, dt, speed * 1.3);
        const r = Math.hypot(ant.pos.x, ant.pos.z);
        ant.fade = 1 - smooth(r, 125, 170);
        if (ant.fade <= 0.001) {
          ants.delete(ant.owner);
          freeSlots.add(ant.slot);
          if (selected === ant) select(null);
          continue;
        }
      }
      if (n >= MAX_ANTS) continue;

      const s = ant.scale * ant.fade;

      // Follow the terrain: sample under the head, tail and both sides, then pitch/roll the body.
      const fx = Math.sin(ant.heading), fz = Math.cos(ant.heading);
      const L = 0.32 * s, W = 0.2 * s;
      const { x, z } = ant.pos;
      const hC = surfaceHeight(x, z);
      const hF = surfaceHeight(x + fx * L, z + fz * L);
      const hB = surfaceHeight(x - fx * L, z - fz * L);
      const hL = surfaceHeight(x + fz * W, z - fx * W); // model +X side
      const hR = surfaceHeight(x - fz * W, z + fx * W);
      const k = Math.min(1, dt * 12);
      ant.slope = (hF - hB) / (2 * L || 1);
      ant.pitch += (Math.atan2(hF - hB, 2 * L) - ant.pitch) * k;
      ant.roll += (Math.atan2(hL - hR, 2 * W) - ant.roll) * k;
      const targetY = Math.max(hC, (hF + hB) / 2, (hL + hR) / 2);
      ant.pos.y = ant.pos.y ? ant.pos.y + (targetY - ant.pos.y) * Math.min(1, dt * 18) : targetY;

      d.position.copy(ant.pos);
      d.rotation.set(-ant.pitch, ant.heading, ant.roll, 'YXZ');
      d.scale.setScalar(Math.max(s, 0.0001));
      d.updateMatrix();
      antMesh.setMatrixAt(n, d.matrix);
      antMatrix.copy(d.matrix);
      animAttr.setXYZ(n, clip.start, clip.frames, ant.phase);
      ant.glow = Math.max(0, ant.glow - dt * 0.6);
      const g = ant === selected ? 0.08 + Math.sin(t * 5) * 0.05 : ant === hovered ? 0.1 : 0;
      glowAttr.setX(n, Math.max(g, ant.glow, ant.tier === 'queen' ? 0.12 : 0));
      antMesh.setColorAt(n, color.set(TIERS[ant.tier].color).offsetHSL(0, 0, ((ant.seed * 7.3) % 1 - 0.5) * 0.05));

      // sugar cube held in the mandibles (offsets are in body-length units, so it follows tilt and scale)
      if (ant.carry) {
        const bob = Math.sin(ant.phase * Math.PI * 4) * 0.006;
        d.position.set(0, MOUTH.y + bob, MOUTH.z + CUBE * 0.45);
        d.rotation.set(0.15, ant.seed, 0.1, 'XYZ');
        d.scale.setScalar(CUBE);
        d.updateMatrix();
        crumbs.setMatrixAt(n, cubeMatrix.multiplyMatrices(antMatrix, d.matrix));
      } else crumbs.setMatrixAt(n, HIDDEN);

      // home mound
      const hs = moundRadius(ant) * (ant.state === 'leaving' ? ant.fade : 1);
      d.position.copy(ant.home);
      d.rotation.set(0, ant.seed, 0);
      d.scale.set(hs, hs * MOUND_Y, hs);
      d.updateMatrix();
      homes.setMatrixAt(n, d.matrix);
      homes.setColorAt(n, color.set('#6a4630').multiplyScalar(ant.tier === 'queen' ? 1.25 : 1));

      // stash: this holder's estimated share of the vault, waiting for the next payout
      const owedFrac = Math.min(1.5, (ant.data.est || 0) / stashUnit);
      if (owedFrac > 0.02 && ant.state !== 'leaving') {
        const ss = (0.07 + 0.2 * Math.sqrt(owedFrac)) * Math.sqrt(ant.targetScale);
        const sx = ant.home.x + 0.55 * hs, sz = ant.home.z + 0.3 * hs;
        d.position.set(sx, surfaceHeight(sx, sz) + ss * 0.5, sz);
        d.rotation.set(0.3, ant.seed + t * 0.3, 0.2);
        d.scale.setScalar(ss);
        d.updateMatrix();
        stash.setMatrixAt(n, d.matrix);
      } else stash.setMatrixAt(n, HIDDEN);

      // egg while hatching
      if (ant.hatch < 1) {
        const es = ant.targetScale * 0.22 * (1 - smooth(ant.hatch, 0.8, 1)) * (1 + Math.sin(t * 22) * 0.04 * smooth(ant.hatch, 0.4, 0.8));
        d.position.set(ant.home.x, ant.home.y + hs * MOUND_Y * moundProfile(0) + es * 1.1, ant.home.z);
        d.rotation.set(0, 0, Math.sin(t * 18) * 0.15 * smooth(ant.hatch, 0.5, 0.8));
        d.scale.set(es, es * 1.35, es);
        d.updateMatrix();
        eggs.setMatrixAt(n, d.matrix);
      } else eggs.setMatrixAt(n, HIDDEN);

      order[n] = ant;
      n++;
    }
    order.length = n;
    for (const im of [antMesh, crumbs, homes, stash, eggs]) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    animAttr.needsUpdate = true;
    glowAttr.needsUpdate = true;

    // sugar rain into the pot after a fee claim
    for (let i = rain.length - 1; i >= 0; i--) {
      const r = rain[i];
      r.v -= 9 * dt;
      r.p.y += r.v * dt;
      if (r.p.y < 2.5 * potScale) {
        particles.emit(r.p.x, r.p.y, r.p.z, rand(-2, 2), rand(2, 5), rand(-2, 2), 1, 0.9, 0.6, 0.8);
        rain.splice(i, 1);
      }
    }
    if (Math.random() < dt * 6) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * potRadius();
      particles.emit(Math.cos(a) * r, rand(1, 4) * potScale, Math.sin(a) * r, 0, rand(2, 4), 0, 0.9, 0.7, 0.35, 1.2);
    }
    particles.update(dt);

    if (selected) {
      const s = selected.scale;
      ring.position.set(selected.pos.x, selected.pos.y + 0.05, selected.pos.z);
      ring.scale.setScalar(s * (1 + Math.sin(t * 4) * 0.06));
      const pp = potPoint({ home: selected.home, scale: 0 });
      trailGeo.setFromPoints([tmpV.set(selected.home.x, selected.home.y + 0.1, selected.home.z), new THREE.Vector3(pp.x * 0.85, 0.1, pp.z * 0.85)]);
      trail.computeLineDistances();
    }
  }

  function select(ant) {
    selected = ant;
    ring.visible = trail.visible = !!ant;
  }

  function pick(raycaster) {
    const p = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!p) return null;
    let best = null, bestD = Infinity;
    for (const ant of ants.values()) {
      const dd = Math.hypot(ant.pos.x - p.x, ant.pos.z - p.z);
      if (dd < 0.5 + ant.scale * 0.55 && dd < bestD) {
        best = ant;
        bestD = dd;
      }
    }
    return best;
  }

  function payout(owner, sol) {
    const ant = ants.get(owner);
    if (!ant) return null;
    ant.glow = 0.8;
    const { x, y, z } = ant.home;
    const n = Math.min(60, 14 + Math.floor(sol * 600));
    for (let i = 0; i < n; i++) particles.emit(x, y + 0.6, z, rand(-2.5, 2.5), rand(5, 10), rand(-2.5, 2.5), 1, 0.75, 0.2, rand(0.9, 1.6));
    return ant;
  }

  function claim(sol) {
    const n = Math.min(160, 30 + Math.floor(sol * 120));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * potRadius() * 0.8;
      const h = rand(18, 42), v = rand(-12, -4);
      rain.push({ p: new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r), v });
      particles.emit(Math.cos(a) * r, h, Math.sin(a) * r, 0, v, 0, 1, 0.95, 0.8, 4);
    }
  }

  return {
    sync,
    update,
    pick,
    select,
    payout,
    claim,
    get: (owner) => ants.get(owner),
    get selected() {
      return selected;
    },
    set hovered(a) {
      hovered = a;
    },
    potTop: () => new THREE.Vector3(0, 4.2 * potScale + 1.5, 0),
    paths,
    queen: () => {
      for (const ant of ants.values()) if (ant.tier === 'queen' && ant.state !== 'leaving') return ant;
      return null;
    },
  };
}
