import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Bakes the rigged CC0 ant's skeletal animations into a vertex animation texture (VAT)
// so thousands of ants can be drawn in one instanced draw call, each at its own animation phase.
//
// Texture layout: one column per vertex; rows [0, F) = positions per frame, rows [F, 2F) = normals.
export async function loadAntVAT(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  let skinned = null;
  root.traverse((o) => {
    if (o.isSkinnedMesh && !skinned) skinned = o;
  });
  if (!skinned) throw new Error('ant.glb has no skinned mesh');

  const clipBy = (re) => gltf.animations.find((a) => re.test(a.name)) ?? gltf.animations[0];
  const plan = [
    { name: 'walk', clip: clipBy(/walk/i), frames: 16 },
    { name: 'bite', clip: clipBy(/bite/i), frames: 8 },
  ];

  const geo = skinned.geometry;
  const count = geo.attributes.position.count;
  const mixer = new THREE.AnimationMixer(root);
  const v = new THREE.Vector3();
  const framesPos = [];

  for (const p of plan) {
    mixer.stopAllAction();
    mixer.clipAction(p.clip).reset().play();
    for (let f = 0; f < p.frames; f++) {
      mixer.setTime((f / p.frames) * p.clip.duration);
      root.updateMatrixWorld(true);
      const out = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(geo.attributes.position, i);
        skinned.applyBoneTransform(i, v);
        v.applyMatrix4(skinned.matrixWorld);
        out.set([v.x, v.y, v.z], i * 3);
      }
      framesPos.push(out);
    }
  }

  // Normalize: centered, feet on y=0, body length = 1, head pointing +Z.
  const rest = framesPos[0];
  const box = new THREE.Box3();
  for (let i = 0; i < count; i++) box.expandByPoint(v.fromArray(rest, i * 3));
  const center = box.getCenter(new THREE.Vector3());
  const length = box.max.z - box.min.z;
  const norm = new THREE.Matrix4()
    .makeScale(1 / length, 1 / length, 1 / length)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));

  const tmp = new THREE.BufferGeometry();
  if (geo.index) tmp.setIndex(geo.index);
  const totalFrames = framesPos.length;
  const data = new Float32Array(count * totalFrames * 2 * 4);
  framesPos.forEach((pos, f) => {
    for (let i = 0; i < count; i++) {
      v.fromArray(pos, i * 3).applyMatrix4(norm);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tmp.computeVertexNormals();
    const nrm = tmp.attributes.normal.array;
    for (let i = 0; i < count; i++) {
      const pi = (f * count + i) * 4;
      const ni = ((totalFrames + f) * count + i) * 4;
      data[pi] = pos[i * 3];
      data[pi + 1] = pos[i * 3 + 1];
      data[pi + 2] = pos[i * 3 + 2];
      data[ni] = nrm[i * 3];
      data[ni + 1] = nrm[i * 3 + 1];
      data[ni + 2] = nrm[i * 3 + 2];
    }
  });

  const texture = new THREE.DataTexture(data, count, totalFrames * 2, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  const base = new THREE.BufferGeometry();
  if (geo.index) base.setIndex(geo.index.clone());
  base.setAttribute('position', new THREE.BufferAttribute(framesPos[0].slice(), 3));
  base.computeVertexNormals();
  base.setAttribute('aVid', new THREE.BufferAttribute(Float32Array.from({ length: count }, (_, i) => i), 1));

  let row = 0;
  const clips = {};
  for (const p of plan) {
    clips[p.name] = { start: row, frames: p.frames };
    row += p.frames;
  }
  return { geometry: base, texture, totalFrames, clips };
}

const VAT_PARS = /* glsl */ `
uniform sampler2D uVAT;
uniform float uFrames;
attribute float aVid;
attribute vec3 aAnim;   // x: clip start row, y: clip frame count, z: phase 0..1
attribute float aGlow;
varying float vGlow;
vec3 vatFetch(float row) { return texelFetch(uVAT, ivec2(int(aVid), int(row)), 0).xyz; }
void vatFrame(out float f0, out float f1, out float fr) {
  float vf = fract(aAnim.z) * aAnim.y;
  f0 = floor(vf);
  fr = vf - f0;
  f1 = mod(f0 + 1.0, aAnim.y);
}
`;

function injectVAT(shader, vat, withNormals) {
  shader.uniforms.uVAT = { value: vat.texture };
  shader.uniforms.uFrames = { value: vat.totalFrames };
  shader.vertexShader = VAT_PARS + shader.vertexShader;
  if (withNormals) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `float nf0, nf1, nfr; vatFrame(nf0, nf1, nfr);
       vec3 objectNormal = normalize(mix(vatFetch(uFrames + aAnim.x + nf0), vatFetch(uFrames + aAnim.x + nf1), nfr));
       #ifdef USE_TANGENT
         vec3 objectTangent = vec3(tangent.xyz);
       #endif`,
    );
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `float pf0, pf1, pfr; vatFrame(pf0, pf1, pfr);
     vec3 transformed = mix(vatFetch(aAnim.x + pf0), vatFetch(aAnim.x + pf1), pfr);
     vGlow = aGlow;`,
  );
}

export function createAntMaterials(vat) {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.15 });
  material.onBeforeCompile = (shader) => {
    injectVAT(shader, vat, true);
    shader.fragmentShader = 'varying float vGlow;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       totalEmissiveRadiance += vGlow * vec3(1.0, 0.62, 0.18);`,
    );
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => injectVAT(shader, vat, false);
  return { material, depth };
}
