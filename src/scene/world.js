import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';

export const GROUND_RADIUS = 240;
const PATH_EXTENT = 260; // world units covered by the trail canvas
const mobile = matchMedia('(max-width: 760px)').matches;

// Cheap value noise for terrain + textures.
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 4; i++) {
    s += amp * noise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}

// Gentle rolling terrain that stays flat where the colony lives.
export function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  const rim = THREE.MathUtils.smoothstep(r, 105, 220);
  return (fbm(x * 0.03, z * 0.03) - 0.5) * 1.2 + rim * (fbm(x * 0.02 + 9, z * 0.02) * 26 + 4);
}

function soilTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.04, y * 0.04) * 0.6 + hash(x, y) * 0.4;
      const i = (y * size + x) * 4;
      img.data[i] = 70 + n * 72;
      img.data[i + 1] = 47 + n * 50;
      img.data[i + 2] = 30 + n * 32;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // grit
  for (let k = 0; k < 2600; k++) {
    const l = 40 + Math.random() * 140;
    g.fillStyle = `rgba(${l + 30},${l + 10},${l - 10},${0.25 + Math.random() * 0.5})`;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, Math.random() * 1.8 + 0.3, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(36, 36);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const horizon = new THREE.Color('#e9b77a');
  scene.fog = new THREE.FogExp2(horizon, 0.0032);

  // Sky dome with a warm late-afternoon gradient.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color('#5d86b8') }, mid: { value: horizon }, bottom: { value: new THREE.Color('#7a4a2a') } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top, mid, bottom; varying vec3 vP;
        void main(){ float h = normalize(vP).y;
          vec3 c = h > 0.0 ? mix(mid, top, pow(clamp(h*1.6,0.0,1.0), 0.7)) : mix(mid, bottom, clamp(-h*4.0,0.0,1.0));
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 1500);
  camera.position.set(0, 120, 190);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = 1.38;
  controls.minDistance = 4;
  controls.maxDistance = 280;
  controls.target.set(0, 0, 0);
  controls.zoomToCursor = true;

  // Lights
  scene.add(new THREE.HemisphereLight('#ffe2b8', '#3a2416', 0.9));
  const sun = new THREE.DirectionalLight('#ffd29a', 3.1);
  sun.position.set(-70, 90, 45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -115;
  sc.right = sc.top = 115;
  sc.near = 10;
  sc.far = 320;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  const potLight = new THREE.PointLight('#ffc66b', 60, 40, 1.6);
  potLight.position.set(0, 6, 0);
  scene.add(potLight);

  // Ground
  const groundGeo = new THREE.PlaneGeometry(GROUND_RADIUS * 2, GROUND_RADIUS * 2, 280, 280);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, groundHeight(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  // Worn ant trails are painted into a canvas and darken the soil underneath.
  const pathCanvas = document.createElement('canvas');
  pathCanvas.width = pathCanvas.height = 1024;
  const pathTex = new THREE.CanvasTexture(pathCanvas);
  const groundMat = new THREE.MeshStandardMaterial({ map: soilTexture(), roughness: 1, metalness: 0 });
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.uPaths = { value: pathTex };
    shader.uniforms.uPathSize = { value: PATH_EXTENT };
    shader.vertexShader = 'varying vec2 vGroundXZ;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vGroundXZ = position.xz;`,
    );
    shader.fragmentShader = 'uniform sampler2D uPaths;\nuniform float uPathSize;\nvarying vec2 vGroundXZ;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       // large-scale damp/dry patches break up the texture tiling
       diffuseColor.rgb *= 0.86 + 0.34 * texture2D(map, vMapUv * 0.061).r;
       vec2 puv = vGroundXZ / uPathSize + 0.5;
       float worn = texture2D(uPaths, vec2(puv.x, 1.0 - puv.y)).a;
       diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.6, 0.52, 0.46), worn);`,
    );
  };
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  function updatePaths(list) {
    const g = pathCanvas.getContext('2d');
    const S = pathCanvas.width;
    const px = (v) => (v / PATH_EXTENT + 0.5) * S;
    const unit = S / PATH_EXTENT;
    g.clearRect(0, 0, S, S);
    g.filter = 'blur(2px)';
    const ring = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, 16 * unit);
    ring.addColorStop(0, 'rgba(0,0,0,0.5)');
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ring;
    g.fillRect(0, 0, S, S);
    g.lineCap = 'round';
    for (const p of list) {
      g.strokeStyle = 'rgba(0,0,0,0.08)';
      g.lineWidth = Math.max(1.5, p.w * unit * 0.5);
      g.beginPath();
      g.moveTo(px(p.x), px(p.z));
      g.lineTo(S / 2 + (px(p.x) - S / 2) * 0.12, S / 2 + (px(p.z) - S / 2) * 0.12);
      g.stroke();
      // trampled ring around each mound
      g.fillStyle = 'rgba(0,0,0,0.13)';
      g.beginPath();
      g.arc(px(p.x), px(p.z), p.w * unit * 1.1, 0, Math.PI * 2);
      g.fill();
    }
    pathTex.needsUpdate = true;
  }

  addDecor(scene);

  // Post-processing: bloom on sugar and gold, tilt-shift for a macro-lens feel, vignette.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.55, 0.9));
  const tiltH = new ShaderPass(HorizontalTiltShiftShader);
  const tiltV = new ShaderPass(VerticalTiltShiftShader);
  tiltH.uniforms.r.value = tiltV.uniforms.r.value = 0.52;
  const setTilt = () => {
    tiltH.uniforms.h.value = 1.5 / innerWidth;
    tiltV.uniforms.v.value = 1.5 / innerHeight;
  };
  setTilt();
  if (!mobile) {
    composer.addPass(tiltH);
    composer.addPass(tiltV);
  }
  const vignette = new ShaderPass(VignetteShader);
  vignette.uniforms.offset.value = 0.9;
  vignette.uniforms.darkness.value = 0.85;
  composer.addPass(vignette);
  composer.addPass(new OutputPass());

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    setTilt();
  });

  return { renderer, scene, camera, controls, composer, potLight, mobile, updatePaths };
}

function addDecor(scene) {
  const dummy = new THREE.Object3D();
  const rand = (a, b) => a + Math.random() * (b - a);

  // Pebbles: everywhere except the inner colony disc.
  const pebbleGeo = new THREE.DodecahedronGeometry(1, 1);
  const pebbles = new THREE.InstancedMesh(pebbleGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), 520);
  const col = new THREE.Color();
  for (let i = 0; i < pebbles.count; i++) {
    const r = Math.random() < 0.35 ? rand(8, 100) : rand(100, 200);
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = r < 100 ? rand(0.12, 0.45) : rand(0.3, 2.4);
    dummy.position.set(x, groundHeight(x, z) + s * 0.25, z);
    dummy.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    dummy.scale.set(s, s * rand(0.45, 0.8), s * rand(0.8, 1.2));
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);
    const l = rand(0.32, 0.6);
    pebbles.setColorAt(i, col.setRGB(l * 1.05, l * 0.95, l * 0.85));
  }
  pebbles.castShadow = pebbles.receiveShadow = true;
  scene.add(pebbles);

  // Grass blades around the outer ring (giant from an ant's point of view).
  const blade = new THREE.ConeGeometry(0.35, 1, 3, 4, true);
  blade.translate(0, 0.5, 0);
  const bp = blade.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const y = bp.getY(i);
    bp.setX(i, bp.getX(i) + y * y * 0.6); // bend
  }
  blade.computeVertexNormals();
  const grassMat = new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  const grassTime = { value: 0 };
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = grassTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `vec3 transformed = position;
       float sway = sin(uTime * 1.3 + instanceMatrix[3].x * 0.15 + instanceMatrix[3].z * 0.11) * 0.18;
       transformed.x += sway * position.y * position.y;`,
    );
  };
  const grass = new THREE.InstancedMesh(blade, grassMat, 4200);
  for (let i = 0; i < grass.count; i++) {
    const cluster = Math.random() < 0.7;
    const r = cluster ? rand(108, 210) : rand(98, 112);
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = rand(6, 18) * (r > 115 ? 1.3 : 0.7);
    dummy.position.set(x, groundHeight(x, z) - 0.2, z);
    dummy.rotation.set(0, rand(0, Math.PI * 2), rand(-0.12, 0.12));
    dummy.scale.set(rand(0.7, 1.4), h, rand(0.7, 1.4));
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
    grass.setColorAt(i, col.setHSL(rand(0.2, 0.28), rand(0.45, 0.6), rand(0.22, 0.38)));
  }
  grass.castShadow = true;
  grass.receiveShadow = true;
  scene.add(grass);

  // Twigs
  const twigGeo = new THREE.CylinderGeometry(0.18, 0.26, 1, 6);
  twigGeo.rotateZ(Math.PI / 2);
  const twigs = new THREE.InstancedMesh(twigGeo, new THREE.MeshStandardMaterial({ color: '#6b4a2f', roughness: 0.95 }), 46);
  for (let i = 0; i < twigs.count; i++) {
    const r = rand(100, 170);
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    dummy.position.set(x, groundHeight(x, z) + 0.15, z);
    dummy.rotation.set(0, rand(0, Math.PI * 2), 0);
    dummy.scale.set(rand(4, 13), rand(0.6, 1.4), rand(0.6, 1.4));
    dummy.updateMatrix();
    twigs.setMatrixAt(i, dummy.matrix);
  }
  twigs.castShadow = twigs.receiveShadow = true;
  scene.add(twigs);

  // Fallen leaves: huge at ant scale, they sell the macro feel.
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.5);
  shape.bezierCurveTo(0.42, -0.25, 0.4, 0.25, 0, 0.5);
  shape.bezierCurveTo(-0.4, 0.25, -0.42, -0.25, 0, -0.5);
  const leafGeo = new THREE.ShapeGeometry(shape, 10);
  leafGeo.rotateX(-Math.PI / 2);
  const lp = leafGeo.attributes.position;
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i), z = lp.getZ(i);
    lp.setY(i, x * x * 0.9 + z * z * 0.25 - Math.abs(x) * 0.08); // cupped and curled
  }
  leafGeo.computeVertexNormals();
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ roughness: 0.75, side: THREE.DoubleSide }), 90);
  const leafColors = ['#8a6a2a', '#a4572a', '#6f6a2c', '#b5832f', '#7b4423'];
  for (let i = 0; i < leaves.count; i++) {
    const r = rand(98, 185);
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = rand(6, 15);
    dummy.position.set(x, groundHeight(x, z) + 0.2, z);
    dummy.rotation.set(rand(-0.15, 0.15), rand(0, Math.PI * 2), rand(-0.15, 0.15));
    dummy.scale.set(s * rand(0.55, 0.75), s, s);
    dummy.updateMatrix();
    leaves.setMatrixAt(i, dummy.matrix);
    leaves.setColorAt(i, col.set(leafColors[i % leafColors.length]).offsetHSL(0, 0, rand(-0.05, 0.05)));
  }
  leaves.castShadow = leaves.receiveShadow = true;
  scene.add(leaves);

  scene.userData.tick = (t) => (grassTime.value = t);
}
