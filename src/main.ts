import '@fontsource-variable/archivo/wdth.css';
import './style.css';
import * as THREE from 'three';
import { Koi, KOI_LENGTH, KOHAKU, SHOWA } from './koi';

const stage = document.getElementById('stage')!;
const hero = document.getElementById('hero')!;
const feedButton = document.getElementById('feed') as HTMLButtonElement;
const hint = document.getElementById('hint')!;
const fedCount = document.getElementById('fed-count')!;
const cursor = document.getElementById('cursor')!;

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = reducedMotionQuery.matches;
reducedMotionQuery.addEventListener('change', (e) => (reducedMotion = e.matches));

const touchFirst = window.matchMedia('(hover: none)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const small = window.innerWidth < 640;
if (touchFirst) hint.textContent = 'Drag to lead · Tap to feed';

const poster = new URLSearchParams(location.search).has('poster');

// ---------- headline: split into letters so they can rise in ----------

let charIndex = 0;
for (const line of document.querySelectorAll<HTMLElement>('.type__line')) {
  const text = line.textContent ?? '';
  line.textContent = '';
  for (const ch of text) {
    const span = document.createElement('span');
    span.className = 'type__char';
    span.textContent = ch;
    span.style.setProperty('--i', String(charIndex++));
    line.appendChild(span);
  }
}

// ---------- renderer & scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 1.75));
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
const shadowSize = small ? 512 : 1024;
sun.shadow.mapSize.set(shadowSize, shadowSize);
sun.shadow.radius = small ? 8 : 14;
sun.shadow.blurSamples = small ? 12 : 20;
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

const forward = (h: number) => new THREE.Vector2(Math.cos(h), -Math.sin(h));

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ---------- the koi ----------

class Swimmer {
  readonly koi: Koi;
  readonly yaw = new THREE.Group(); // heading
  readonly bank = new THREE.Group(); // roll into turns
  readonly pos: THREE.Vector2;
  heading: number;
  speed = 0.4;
  yawRate = 0;
  phase: number;
  flutter = 0;
  bob: number;
  lastWake = 0;
  fold = 1;
  /** still swimming in from off-screen, so don't clamp it to the pond yet */
  entering = false;
  /** the pellet it is currently chasing */
  target: Pellet | null = null;
  readonly scale: number;

  constructor(
    patches: typeof KOHAKU,
    scale: number,
    x: number,
    z: number,
    heading: number,
    seed: number,
  ) {
    this.scale = scale;
    this.koi = new Koi(patches);
    this.koi.mesh.scale.setScalar(scale);
    this.bank.add(this.koi.mesh);
    this.yaw.add(this.bank);
    scene.add(this.yaw);
    this.pos = new THREE.Vector2(x, z);
    this.heading = heading;
    this.phase = seed * 2.1;
    this.bob = seed * 3.7;
  }

  head() {
    return forward(this.heading).multiplyScalar(KOI_LENGTH * 0.42 * this.scale).add(this.pos);
  }

  tail() {
    return forward(this.heading).multiplyScalar(-KOI_LENGTH * 0.95 * this.scale).add(this.pos);
  }

  pose() {
    const lift = (1 - this.fold) * 0.55;
    this.yaw.position.set(this.pos.x, Math.sin(this.bob * 0.9) * 0.05 + lift, this.pos.y);
    this.yaw.rotation.y = this.heading;
    this.bank.rotation.x = THREE.MathUtils.clamp(-this.yawRate * 0.16, -0.32, 0.32);
    const formed = this.fold;
    const swim = reducedMotion ? 0 : (0.085 + 0.07 * Math.min(1, this.speed / 2.4)) * formed;
    const bend = THREE.MathUtils.clamp(this.yawRate * 0.22, -0.45, 0.45) * (reducedMotion ? 0.5 : 1);
    this.koi.deform(this.phase, swim, bend * formed, this.flutter, reducedMotion ? 0 : 0.06 * formed, this.fold);
  }
}

const lead = new Swimmer(KOHAKU, 1.22, 0.2, 0.15, 0.2, 0);
const mate = new Swimmer(SHOWA, small ? 0.82 : 0.92, -9, 1.2, 0.15, 1);
mate.entering = true;
const swimmers = [lead, mate];

// ---------- pointer, cursor, food & ripples ----------

const pointer = { pos: new THREE.Vector2(), lastMove: -Infinity };
let clockTime = 0;

function eventToPlane(e: { clientX: number; clientY: number }, out: THREE.Vector2) {
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
  if (!planeHit(nx, ny, tmpV3)) return null;
  return out.set(tmpV3.x, tmpV3.z);
}

if (finePointer) hero.classList.add('has-cursor');

stage.addEventListener('pointermove', (e) => {
  if (eventToPlane(e, pointer.pos)) pointer.lastMove = clockTime;
  if (finePointer) {
    const r = hero.getBoundingClientRect();
    cursor.style.transform = `translate3d(${e.clientX - r.left}px, ${e.clientY - r.top}px, 0)`;
    cursor.classList.add('is-on');
  }
});
stage.addEventListener('pointerleave', () => {
  pointer.lastMove = -Infinity;
  cursor.classList.remove('is-on');
});

type Pellet = { mesh: THREE.Mesh; pos: THREE.Vector2; born: number; landed: boolean; eaten: number };
const pellets: Pellet[] = [];
const pelletGeo = new THREE.IcosahedronGeometry(0.075, 0);
const pelletMat = new THREE.MeshStandardMaterial({ color: 0xff9a45, roughness: 0.6, flatShading: true });

type Ripple = { mesh: THREE.Mesh; born: number; life: number; size: number; strength: number };
const ripples: Ripple[] = [];
const rippleGeo = new THREE.RingGeometry(0.92, 1, 64);
rippleGeo.rotateX(-Math.PI / 2);

function addRipple(p: THREE.Vector2, size = 1, life = 1.6, strength = 0.75) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const mesh = new THREE.Mesh(rippleGeo, mat);
  mesh.position.set(p.x, -0.12, p.y);
  mesh.renderOrder = -1;
  scene.add(mesh);
  ripples.push({ mesh, born: clockTime, life, size, strength });
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
  cursor.classList.add('is-down');
});
window.addEventListener('pointerup', () => cursor.classList.remove('is-down'));
stage.addEventListener('pointerup', (e) => {
  // treat it as a click/tap only if the pointer barely moved (so scrolling on phones doesn't feed)
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  if (moved > 10 || performance.now() - downAt.t > 600) return;
  const p = eventToPlane(e, new THREE.Vector2());
  if (p) dropFood(p);
});

feedButton.addEventListener('click', () => {
  // drop it a little ahead of the lead fish so the chase is visible
  const ahead = forward(lead.heading).multiplyScalar(2.2).add(lead.pos);
  ahead.x += (Math.random() - 0.5) * 1.5;
  ahead.y += (Math.random() - 0.5) * 1.0;
  dropFood(ahead);
});

let fed = 0;
function countFeed() {
  fed++;
  fedCount.textContent = String(fed).padStart(2, '0');
  fedCount.classList.remove('is-bump');
  void fedCount.offsetWidth; // restart the bump animation
  fedCount.classList.add('is-bump');
}

// ---------- simulation ----------

const target = new THREE.Vector2();
const tmp2 = new THREE.Vector2();
let introStart = -1; // clock time when the fold-in begins
const INTRO_DELAY = 0.35;
const INTRO_FOLD = 1.7;

function nearestFood(head: THREE.Vector2, skip?: Pellet) {
  let food: Pellet | null = null;
  let best = Infinity;
  for (const p of pellets) {
    if (!p.landed || p.eaten >= 0 || p === skip) continue;
    const d = p.pos.distanceToSquared(head);
    if (d < best) {
      best = d;
      food = p;
    }
  }
  return food;
}

function steer(f: Swimmer, dt: number, t: number) {
  const head = f.head();
  const isLead = f === lead;

  // the lead unfolds in place before it starts swimming; the mate waits, then swims in
  const introAge = introStart < 0 ? 0 : t - introStart;
  const holding = isLead ? introAge < INTRO_DELAY + INTRO_FOLD * 0.75 : introAge < INTRO_DELAY + INTRO_FOLD * 0.6;

  // pick a target: food first, then the pointer (lead) or the lead (mate), then a lissajous wander
  let mode: 'food' | 'pointer' | 'follow' | 'wander' = 'wander';
  let food = holding ? null : nearestFood(head);
  // the mate leaves the lead's pellet alone unless it is clearly closer to it
  if (food && !isLead && lead.target === food && lead.head().distanceTo(food.pos) < head.distanceTo(food.pos) * 1.3) {
    food = nearestFood(head, food);
  }
  f.target = food;
  if (food) {
    mode = 'food';
    target.copy(food.pos);
  } else if (!isLead) {
    mode = 'follow';
    // trail behind and a little to one side of the lead, swaying slowly
    const back = forward(lead.heading).multiplyScalar(-2.1 * lead.scale);
    const sideways = forward(lead.heading + Math.PI / 2).multiplyScalar(0.95 * Math.sin(t * 0.23));
    target.copy(lead.pos).add(back).add(sideways);
    if (!f.entering) clampToPond(target, 1.3);
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

  // keep the pair from swimming through each other
  const other = isLead ? mate : lead;
  if (!other.entering) {
    tmp2.subVectors(f.pos, other.pos);
    const gap = tmp2.length();
    const minGap = 1.35 * (f.scale + other.scale) * 0.5;
    if (gap < minGap && gap > 1e-3) {
      tmp2.normalize();
      if (mode !== 'food') target.addScaledVector(tmp2, (minGap - gap) * 3);
      // and never let the bodies interpenetrate: nudge them apart directly
      if (gap < minGap * 0.8) f.pos.addScaledVector(tmp2, (minGap * 0.8 - gap) * Math.min(1, dt * 6));
    }
    if (mode !== 'food') clampToPond(target, 1.3);
  }

  // steer toward the target from the head, not the body centre
  tmp2.subVectors(target, mode === 'food' ? head : f.pos);
  const dist = tmp2.length();
  const desired = Math.atan2(-tmp2.y, tmp2.x);
  let diff = wrapAngle(desired - f.heading);

  // soft walls: if it's drifting out of the pond, bias the heading back toward the centre
  if (!f.entering) {
    const hw = halfWidthAt(f.pos.y);
    const edge =
      Math.max(
        Math.abs(f.pos.x) - (hw - 1.5),
        f.pos.y - (bounds.zBottom - 1.4),
        bounds.zTop + 1.5 - f.pos.y,
        0,
      ) / 1.2;
    if (edge > 0) {
      const toCentre = Math.atan2(f.pos.y - (bounds.zTop + bounds.zBottom) / 2, -f.pos.x);
      diff = THREE.MathUtils.lerp(diff, wrapAngle(toCentre - f.heading), Math.min(1, edge));
    }
  }

  const topSpeed = { food: 3.0, pointer: 2.6, follow: 2.2, wander: 0.95 }[mode];
  const maxSpeed = reducedMotion ? 0.45 : holding ? 0.15 : topSpeed * (isLead ? 1 : 0.94);
  const minSpeed = reducedMotion ? 0.12 : holding ? 0.05 : 0.32;
  let wantSpeed = THREE.MathUtils.clamp(dist * (mode === 'wander' ? 0.4 : 1.1), minSpeed, maxSpeed);
  // slow down when the turn is sharp so it arcs rather than skidding
  wantSpeed *= 1 - Math.min(0.55, Math.abs(diff) * 0.3);
  if ((mode === 'pointer' || mode === 'follow') && dist < 0.9) wantSpeed = Math.max(minSpeed, wantSpeed * 0.5);
  if (f.entering) wantSpeed = Math.max(wantSpeed, 1.6);

  f.speed = THREE.MathUtils.damp(f.speed, wantSpeed, mode === 'wander' ? 1.2 : 2.6, dt);
  const turnGain = reducedMotion ? 0.8 : 2.4;
  const maxTurn = reducedMotion ? 0.5 : (1.2 + f.speed * 0.9) * (holding ? 0.2 : 1);
  const wantYaw = THREE.MathUtils.clamp(diff * turnGain, -maxTurn, maxTurn);
  f.yawRate = THREE.MathUtils.damp(f.yawRate, wantYaw, 5, dt);
  f.heading = wrapAngle(f.heading + f.yawRate * dt);
  f.pos.addScaledVector(forward(f.heading), f.speed * dt);

  if (f.entering) {
    // once it's well inside the pond, hand it over to the normal bounds
    const hw = halfWidthAt(f.pos.y);
    if (Math.abs(f.pos.x) < hw - 1.6) f.entering = false;
  } else {
    clampToPond(f.pos, 1.2);
  }

  // eat
  if (food && food.pos.distanceTo(head) < 0.36 * f.scale + 0.06) {
    food.eaten = t;
    addRipple(food.pos, 0.55, 1.1);
    f.speed += 0.6;
    countFeed();
  }

  // a faint wake trails a fast-swimming fish
  if (!reducedMotion && f.speed > 1.15 && t - f.lastWake > 0.3) {
    f.lastWake = t;
    addRipple(f.tail(), 0.32 * f.scale, 1.0, 0.32);
  }

  // tail beat: frequency scales with speed
  const omega = 4.2 + f.speed * 5.2;
  f.phase += omega * dt;
  f.flutter += (2.6 + f.speed * 1.5) * dt;
  f.bob += dt;
}

function easeOutBack(x: number) {
  const c = 1.4;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
}

function updateFold(t: number) {
  if (introStart < 0) {
    for (const f of swimmers) f.fold = reducedMotion || poster ? 1 : 0;
    return;
  }
  const k = THREE.MathUtils.clamp((t - introStart - INTRO_DELAY) / INTRO_FOLD, 0, 1);
  lead.fold = reducedMotion ? 1 : easeOutBack(k);
  mate.fold = 1;
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
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.strength * (1 - k) * Math.min(1, k * 8);
  }
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
    updateFold(clockTime);
    for (const f of swimmers) steer(f, dt, clockTime);
    updatePellets(clockTime);
    for (const f of swimmers) f.pose();
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

// ---------- notes: ease in as they scroll into view ----------

const reveals = document.querySelectorAll<HTMLElement>('[data-reveal]');
const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      revealObserver.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -12% 0px' },
);
reveals.forEach((el) => revealObserver.observe(el));

// ---------- start ----------

resize();
// on tall screens the sheet unfolds on a diagonal so the whole fish fits
if (camera.aspect < 1) lead.heading = 1.0;
clampToPond(lead.pos, 1);
mate.pos.set(-halfWidthAt(1.2) - 2.2, 1.2);

if (poster) {
  // a fixed, composed pose for the preview thumbnail
  Object.assign(lead, { heading: 0.24, yawRate: 0.45, speed: 1.4, phase: 1.1, flutter: 0.6 });
  lead.pos.set(0.45, 0.05);
  Object.assign(mate, { heading: 3.0, yawRate: -0.4, speed: 1.1, phase: 2.6, flutter: 1.4, entering: false });
  mate.pos.set(1.7, 1.15);
  frozen = true;
  document.body.classList.add('is-still', 'is-ready');
}
updateFold(0);
for (const f of swimmers) f.pose();
renderer.render(scene, camera);

// start the choreography once the display face is ready, so the type and the fold land together
document.fonts.ready.then(() => {
  introStart = clockTime;
  document.body.classList.add('is-ready');
});
wake();

// handy for debugging in the console
Object.assign(window, {
  __koi: {
    lead,
    mate,
    dropFood,
    camera,
    pause: () => (frozen = true),
    play: () => (frozen = false),
    render: () => (swimmers.forEach((f) => f.pose()), renderer.render(scene, camera)),
  },
});
