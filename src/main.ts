import '@fontsource-variable/archivo/wdth.css';
import './style.css';
import * as THREE from 'three';
import { Koi, KOI_LENGTH } from './koi';

const stage = document.getElementById('stage')!;
const hero = document.getElementById('hero')!;
const feedButton = document.getElementById('feed') as HTMLButtonElement;
const hint = document.getElementById('hint')!;

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = reducedMotionQuery.matches;
reducedMotionQuery.addEventListener('change', (e) => (reducedMotion = e.matches));

if (window.matchMedia('(hover: none)').matches) hint.textContent = 'Drag to lead · Tap to feed';

// ---------- renderer & scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
const TILT = THREE.MathUtils.degToRad(40);

scene.add(new THREE.HemisphereLight(0xffffff, 0xf0b0a0, 1.9));
const sun = new THREE.DirectionalLight(0xfff4ea, 2.6);
sun.position.set(-3.5, 10, 4.5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.radius = 14;
sun.shadow.blurSamples = 20;
sun.shadow.bias = -0.0005;
const sc = sun.shadow.camera;
sc.left = -12;
sc.right = 12;
sc.top = 12;
sc.bottom = -12;
sc.near = 1;
sc.far = 30;
scene.add(sun);
// a weak fill from the opposite side keeps the shadowed facets from going grey
const fill = new THREE.DirectionalLight(0xffe2d6, 0.55);
fill.position.set(4, 3, -2);
scene.add(fill);

const FLOOR_Y = -0.85;
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.ShadowMaterial({ color: 0x7a0a04, opacity: 0.3 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
scene.add(floor);

// ---------- the koi ----------

const koi = new Koi();
const FISH_SCALE = 1.22;
koi.mesh.scale.setScalar(FISH_SCALE);
const fishYaw = new THREE.Group(); // heading
const fishBank = new THREE.Group(); // roll into turns
fishBank.add(koi.mesh);
fishYaw.add(fishBank);
scene.add(fishYaw);

const fish = {
  pos: new THREE.Vector2(-1.2, 0.4),
  heading: 0.35, // radians; 0 faces +x, positive turns toward -z (screen up)
  speed: 0.6,
  yawRate: 0,
  phase: 0,
  flutter: 0,
  bob: 0,
};

const forward = (h: number) => new THREE.Vector2(Math.cos(h), -Math.sin(h));

// ---------- bounds: where the plane y=0 is visible ----------

const bounds = { zTop: -3, zBottom: 3, halfTop: 5, halfBottom: 5 };
const raycaster = new THREE.Raycaster();
const swimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const tmpV3 = new THREE.Vector3();
const ndc = new THREE.Vector2();

function planeHit(nx: number, ny: number, out: THREE.Vector3) {
  ndc.set(nx, ny);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(swimPlane, out);
}

function resize() {
  const w = hero.clientWidth;
  const h = hero.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep a pond about 7.4 units wide on landscape screens, and ~4.9 on phones
  const wantWidth = camera.aspect >= 1 ? 7.4 : 4.9;
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = Math.max(wantWidth / 2 / Math.tan(hfov / 2), camera.aspect >= 1 ? 0 : 8);
  camera.position.set(0, Math.sin(TILT) * dist, Math.cos(TILT) * dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const tl = planeHit(-1, 1, new THREE.Vector3());
  const bl = planeHit(-1, -1, new THREE.Vector3());
  if (tl && bl) {
    bounds.zTop = tl.z;
    bounds.zBottom = bl.z;
    bounds.halfTop = Math.abs(tl.x);
    bounds.halfBottom = Math.abs(bl.x);
  }
}

function halfWidthAt(z: number) {
  const t = THREE.MathUtils.clamp((z - bounds.zTop) / (bounds.zBottom - bounds.zTop), 0, 1);
  return THREE.MathUtils.lerp(bounds.halfTop, bounds.halfBottom, t);
}

/** Clamp a point on the plane into the visible pond, inset by `margin`. */
function clampToPond(p: THREE.Vector2, margin: number) {
  p.y = THREE.MathUtils.clamp(p.y, bounds.zTop + margin, bounds.zBottom - margin);
  const hw = Math.max(0.5, halfWidthAt(p.y) - margin);
  p.x = THREE.MathUtils.clamp(p.x, -hw, hw);
  return p;
}

// ---------- pointer, food & ripples ----------

const pointer = { pos: new THREE.Vector2(), lastMove: -Infinity };
let clockTime = 0;

function eventToPlane(e: { clientX: number; clientY: number }, out: THREE.Vector2) {
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
  if (!planeHit(nx, ny, tmpV3)) return null;
  return out.set(tmpV3.x, tmpV3.z);
}

stage.addEventListener('pointermove', (e) => {
  if (eventToPlane(e, pointer.pos)) pointer.lastMove = clockTime;
});
stage.addEventListener('pointerleave', () => (pointer.lastMove = -Infinity));

type Pellet = { mesh: THREE.Mesh; pos: THREE.Vector2; born: number; landed: boolean; eaten: number };
const pellets: Pellet[] = [];
const pelletGeo = new THREE.IcosahedronGeometry(0.075, 0);
const pelletMat = new THREE.MeshStandardMaterial({ color: 0xff9a45, roughness: 0.6, flatShading: true });

type Ripple = { mesh: THREE.Mesh; born: number; life: number; size: number };
const ripples: Ripple[] = [];
const rippleGeo = new THREE.RingGeometry(0.92, 1, 64);
rippleGeo.rotateX(-Math.PI / 2);

function addRipple(p: THREE.Vector2, size = 1, life = 1.6) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const mesh = new THREE.Mesh(rippleGeo, mat);
  mesh.position.set(p.x, -0.12, p.y);
  mesh.renderOrder = -1;
  scene.add(mesh);
  ripples.push({ mesh, born: clockTime, life, size });
}

function dropFood(p: THREE.Vector2) {
  clampToPond(p, 0.35);
  if (pellets.length >= 6) return;
  const mesh = new THREE.Mesh(pelletGeo, pelletMat);
  mesh.castShadow = true;
  mesh.position.set(p.x, 2.2, p.y);
  scene.add(mesh);
  pellets.push({ mesh, pos: p.clone(), born: clockTime, landed: false, eaten: -1 });
  wake();
}

let downAt = { x: 0, y: 0, t: 0 };
stage.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (e.pointerType !== 'mouse' && eventToPlane(e, pointer.pos)) pointer.lastMove = clockTime;
});
stage.addEventListener('pointerup', (e) => {
  // treat it as a click/tap only if the pointer barely moved (so scrolling on phones doesn't feed)
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  if (moved > 10 || performance.now() - downAt.t > 600) return;
  const p = eventToPlane(e, new THREE.Vector2());
  if (p) dropFood(p);
});

feedButton.addEventListener('click', () => {
  // drop it a little ahead of the fish so the chase is visible
  const ahead = forward(fish.heading).multiplyScalar(2.2).add(fish.pos);
  ahead.x += (Math.random() - 0.5) * 1.5;
  ahead.y += (Math.random() - 0.5) * 1.0;
  dropFood(ahead);
});

// ---------- simulation ----------

const target = new THREE.Vector2();
const tmp2 = new THREE.Vector2();

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function step(dt: number, t: number) {
  const head = forward(fish.heading).multiplyScalar(KOI_LENGTH * 0.42 * FISH_SCALE).add(fish.pos);

  // pick a target: food first, then the pointer, then a slow lissajous wander
  let mode: 'food' | 'pointer' | 'wander' = 'wander';
  let food: Pellet | null = null;
  let best = Infinity;
  for (const p of pellets) {
    if (!p.landed || p.eaten >= 0) continue;
    const d = p.pos.distanceToSquared(head);
    if (d < best) {
      best = d;
      food = p;
    }
  }
  if (food) {
    mode = 'food';
    target.copy(food.pos);
  } else if (t - pointer.lastMove < 2.2) {
    mode = 'pointer';
    target.copy(pointer.pos);
    clampToPond(target, 1.45);
  } else {
    const hw = Math.min(bounds.halfTop, bounds.halfBottom);
    const hz = (bounds.zBottom - bounds.zTop) / 2;
    const cz = (bounds.zBottom + bounds.zTop) / 2;
    const ws = reducedMotion ? 0.35 : 1;
    target.set(Math.sin(t * 0.17 * ws) * hw * 0.62, cz + Math.sin(t * 0.29 * ws + 1.3) * hz * 0.55);
  }

  // steer toward the target from the head, not the body centre
  tmp2.subVectors(target, mode === 'food' ? head : fish.pos);
  const dist = tmp2.length();
  const desired = Math.atan2(-tmp2.y, tmp2.x);
  let diff = wrapAngle(desired - fish.heading);

  // soft walls: if we're drifting out of the pond, bias the heading back toward the centre
  const hw = halfWidthAt(fish.pos.y);
  const edge =
    Math.max(
      Math.abs(fish.pos.x) - (hw - 1.5),
      fish.pos.y - (bounds.zBottom - 1.4),
      bounds.zTop + 1.5 - fish.pos.y,
      0,
    ) / 1.2;
  if (edge > 0) {
    const toCentre = Math.atan2(fish.pos.y - (bounds.zTop + bounds.zBottom) / 2, -fish.pos.x);
    const back = wrapAngle(toCentre - fish.heading);
    diff = THREE.MathUtils.lerp(diff, back, Math.min(1, edge));
  }

  const maxSpeed = reducedMotion ? 0.45 : mode === 'food' ? 3.0 : mode === 'pointer' ? 2.6 : 0.95;
  const minSpeed = reducedMotion ? 0.12 : 0.32;
  let wantSpeed = THREE.MathUtils.clamp(dist * (mode === 'wander' ? 0.4 : 1.1), minSpeed, maxSpeed);
  // slow down when the turn is sharp so it arcs rather than skidding
  wantSpeed *= 1 - Math.min(0.55, Math.abs(diff) * 0.3);
  if (mode === 'pointer' && dist < 0.9) wantSpeed = Math.max(minSpeed, wantSpeed * 0.5);

  fish.speed = THREE.MathUtils.damp(fish.speed, wantSpeed, mode === 'wander' ? 1.2 : 2.6, dt);
  const turnGain = reducedMotion ? 0.8 : 2.4;
  const maxTurn = reducedMotion ? 0.5 : 1.2 + fish.speed * 0.9;
  const wantYaw = THREE.MathUtils.clamp(diff * turnGain, -maxTurn, maxTurn);
  fish.yawRate = THREE.MathUtils.damp(fish.yawRate, wantYaw, 5, dt);
  fish.heading = wrapAngle(fish.heading + fish.yawRate * dt);
  fish.pos.addScaledVector(forward(fish.heading), fish.speed * dt);
  clampToPond(fish.pos, 1.2);

  // eat
  if (food && food.pos.distanceTo(head) < 0.36) {
    food.eaten = t;
    addRipple(food.pos, 0.55, 1.1);
    fish.speed += 0.6;
  }

  // tail beat: frequency scales with speed
  const omega = 4.2 + fish.speed * 5.2;
  fish.phase += omega * dt;
  fish.flutter += (2.6 + fish.speed * 1.5) * dt;
  fish.bob += dt;
}

function updatePellets(t: number) {
  for (let i = pellets.length - 1; i >= 0; i--) {
    const p = pellets[i];
    const age = t - p.born;
    if (!p.landed) {
      const k = Math.min(1, age / 0.42);
      p.mesh.position.y = THREE.MathUtils.lerp(2.2, -0.04, k * k);
      if (k >= 1) {
        p.landed = true;
        addRipple(p.pos, 0.9, 1.7);
        setTimeout(() => addRipple(p.pos, 0.6, 1.4), 220);
      }
    } else if (p.eaten < 0) {
      p.mesh.position.y = -0.04 + Math.sin(age * 3) * 0.02;
      p.mesh.rotation.y = age * 0.6;
    } else {
      const k = (t - p.eaten) / 0.18;
      p.mesh.scale.setScalar(Math.max(0.001, 1 - k));
      if (k >= 1) {
        scene.remove(p.mesh);
        pellets.splice(i, 1);
      }
    }
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    const k = (t - r.born) / r.life;
    if (k >= 1) {
      scene.remove(r.mesh);
      (r.mesh.material as THREE.Material).dispose();
      ripples.splice(i, 1);
      continue;
    }
    const ease = 1 - Math.pow(1 - k, 3);
    r.mesh.scale.setScalar(0.08 + ease * r.size);
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - k) * Math.min(1, k * 8);
  }
}

function pose(t: number) {
  fishYaw.position.set(fish.pos.x, Math.sin(fish.bob * 0.9) * 0.05, fish.pos.y);
  fishYaw.rotation.y = fish.heading;
  // bank into the turn, and bend the body along it
  fishBank.rotation.x = THREE.MathUtils.clamp(-fish.yawRate * 0.16, -0.32, 0.32);
  const swim = reducedMotion ? 0 : 0.085 + 0.07 * Math.min(1, fish.speed / 2.4);
  const bend = THREE.MathUtils.clamp(fish.yawRate * 0.22, -0.45, 0.45) * (reducedMotion ? 0.5 : 1);
  koi.deform(fish.phase, swim, bend, fish.flutter, reducedMotion ? 0 : 0.06);
  void t;
}

// ---------- loop: paused when hidden or scrolled away ----------

let running = false;
let heroVisible = true;
let last = 0;
let raf = 0;
let frozen = false; // hold the current pose (poster mode / debugging)

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  raf = requestAnimationFrame(frame);
  if (!frozen) {
    clockTime += dt;
    step(dt, clockTime);
    updatePellets(clockTime);
    pose(clockTime);
  }
  renderer.render(scene, camera);
}

function wake() {
  const should = !document.hidden && heroVisible;
  if (should && !running) {
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  } else if (!should && running) {
    running = false;
    cancelAnimationFrame(raf);
  }
}

document.addEventListener('visibilitychange', wake);
new IntersectionObserver(([entry]) => {
  heroVisible = entry.isIntersecting;
  wake();
}).observe(hero);

new ResizeObserver(() => {
  resize();
  if (!running) renderer.render(scene, camera);
}).observe(hero);

resize();
clampToPond(fish.pos, 1);

// ?poster holds a fixed, composed pose (used for the preview thumbnail)
const poster = new URLSearchParams(location.search).has('poster');
if (poster) {
  Object.assign(fish, { heading: 0.24, yawRate: 0.45, speed: 1.4, phase: 1.1, flutter: 0.6 });
  fish.pos.set(0.45, 0.05);
  frozen = true;
}
pose(0);
renderer.render(scene, camera);
wake();

// handy for debugging in the console
Object.assign(window, {
  __koi: { fish, dropFood, camera, pause: () => (frozen = true), play: () => (frozen = false), render: () => (pose(0), renderer.render(scene, camera)) },
});
