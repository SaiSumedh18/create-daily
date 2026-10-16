import * as THREE from 'three';

/**
 * A procedurally folded origami koi.
 *
 * Local space: the fish faces +x, +y is up, z is lateral. `s` runs from 0 at
 * the nose to 1 at the root of the tail; the tail fin continues past 1.
 * The geometry is non-indexed so every triangle owns its vertices and its
 * colour, which is what makes it read as folded paper under flat shading.
 */

export const KOI_LENGTH = 2.4;

const L = KOI_LENGTH;
const W_MAX = 0.3; // half-width at the shoulders
const H_MAX = 0.2; // height of the back ridge

const xAt = (s: number) => L * (0.45 - s);

function widthAt(s: number) {
  if (s <= 0.3) return W_MAX * Math.pow(Math.sin(((s + 0.012) / 0.312) * Math.PI * 0.5), 0.62);
  const t = (s - 0.3) / 0.7;
  return W_MAX * (1 - 0.84 * Math.pow(t, 1.45));
}

function heightAt(s: number) {
  if (s <= 0.34) return H_MAX * Math.pow(Math.sin(((s + 0.02) / 0.36) * Math.PI * 0.5), 0.7);
  const t = (s - 0.34) / 0.66;
  return H_MAX * (1 - 0.78 * Math.pow(t, 1.3));
}

const SIDE_Y = 0.03; // the lateral crease sits slightly above centre

// sRGB palette — THREE.Color converts these into the linear working space.
const C = {
  paper: new THREE.Color('#fffaf2'),
  paperShade: new THREE.Color('#f1e6d8'),
  belly: new THREE.Color('#f6ece0'),
  hi: new THREE.Color('#ff7a2e'),
  hiDeep: new THREE.Color('#f2541b'),
  sumi: new THREE.Color('#1d1412'),
  eye: new THREE.Color('#120c0b'),
  fin: new THREE.Color('#fff6ec'),
  finShade: new THREE.Color('#f7dccb'),
};

type Patch = { s: number; u: number; rs: number; ru: number; tone: 'hi' | 'sumi' };

// Kohaku patches with a few showa-style sumi spots, in (s, lateral u) space.
const PATCHES: Patch[] = [
  { s: 0.12, u: 0.05, rs: 0.075, ru: 0.62, tone: 'hi' },
  { s: 0.42, u: 0.38, rs: 0.13, ru: 0.72, tone: 'hi' },
  { s: 0.4, u: -0.6, rs: 0.06, ru: 0.42, tone: 'hi' },
  { s: 0.74, u: -0.3, rs: 0.09, ru: 0.66, tone: 'hi' },
  { s: 0.3, u: -0.62, rs: 0.035, ru: 0.3, tone: 'sumi' },
  { s: 0.6, u: 0.72, rs: 0.04, ru: 0.3, tone: 'sumi' },
  { s: 0.87, u: 0.25, rs: 0.03, ru: 0.36, tone: 'sumi' },
];

// Small deterministic hash so facets get stable shade jitter.
function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function bodyColor(s: number, u: number, top: boolean, id: number) {
  let tone: 'paper' | 'hi' | 'sumi' = 'paper';
  for (const p of PATCHES) {
    const ds = (s - p.s) / p.rs;
    const du = (u - p.u) / p.ru;
    // patches wrap a little way down the flanks, but not under the belly
    const reach = top ? 1 : 0.45;
    if (ds * ds + du * du < reach) {
      if (p.tone === 'sumi') {
        tone = 'sumi';
        break;
      }
      tone = 'hi';
    }
  }
  const j = hash(id);
  let c: THREE.Color;
  if (tone === 'hi') c = (j > 0.55 ? C.hiDeep : C.hi).clone();
  else if (tone === 'sumi') c = C.sumi.clone();
  else c = (top ? (j > 0.6 ? C.paperShade : C.paper) : C.belly).clone();
  return c.multiplyScalar(0.96 + j * 0.06);
}

export class Koi {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly rest: Float32Array;
  private readonly sAttr: Float32Array;
  private readonly flap: Float32Array;
  private readonly flapSide: Float32Array;

  constructor() {
    const pos: number[] = [];
    const col: number[] = [];
    const sArr: number[] = [];
    const flapArr: number[] = [];
    const flapSideArr: number[] = [];
    let faceId = 0;

    const tri = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      c: THREE.Vector3,
      color: THREE.Color,
      flap: [number, number, number] = [0, 0, 0],
      side = 0,
    ) => {
      for (const [i, v] of [a, b, c].entries()) {
        pos.push(v.x, v.y, v.z);
        col.push(color.r, color.g, color.b);
        sArr.push(0.45 - v.x / L);
        flapArr.push(flap[i]);
        flapSideArr.push(side);
      }
      faceId++;
    };

    // ---- body: rings with a faceted diamond cross-section ----
    const stations = [0.03, 0.075, 0.13, 0.2, 0.28, 0.37, 0.46, 0.55, 0.64, 0.73, 0.81, 0.88, 0.94, 1.0];
    const ANG = 8;
    const ring = (s: number) => {
      const w = widthAt(s);
      const hT = heightAt(s);
      const hB = hT * 0.8;
      const x = xAt(s);
      // 8 points: top, upper shoulder, side, lower shoulder, bottom, ... mirrored
      // The shoulders are pushed out a little past the straight diamond edge to crease the paper.
      const k = 0.62;
      return [
        new THREE.Vector3(x, hT + SIDE_Y, 0),
        new THREE.Vector3(x, SIDE_Y + hT * k, w * k),
        new THREE.Vector3(x, SIDE_Y, w),
        new THREE.Vector3(x, SIDE_Y - hB * k, w * k * 0.92),
        new THREE.Vector3(x, SIDE_Y - hB, 0),
        new THREE.Vector3(x, SIDE_Y - hB * k, -w * k * 0.92),
        new THREE.Vector3(x, SIDE_Y, -w),
        new THREE.Vector3(x, SIDE_Y + hT * k, -w * k),
      ];
    };
    const rings = stations.map(ring);
    // lateral coordinate of each ring point, for patterning (-1..1, top half = indices 7,0,1 + sides)
    const U = [0, 0.62, 1, 0.62, 0, -0.62, -1, -0.62];
    const TOP = [true, true, false, false, false, false, false, true]; // face j from point j to j+1

    // nose cap
    const nose = new THREE.Vector3(xAt(-0.012), SIDE_Y + 0.01, 0);
    for (let j = 0; j < ANG; j++) {
      const a = rings[0][j];
      const b = rings[0][(j + 1) % ANG];
      const u = (U[j] + U[(j + 1) % ANG]) / 2;
      tri(nose, b, a, bodyColor(0.01, u, TOP[j], faceId));
    }

    for (let i = 0; i < rings.length - 1; i++) {
      const r0 = rings[i];
      const r1 = rings[i + 1];
      const sMid = (stations[i] + stations[i + 1]) / 2;
      for (let j = 0; j < ANG; j++) {
        const jn = (j + 1) % ANG;
        const a = r0[j];
        const b = r0[jn];
        const c = r1[j];
        const d = r1[jn];
        const u0 = U[j];
        const u1 = U[jn];
        // alternate the diagonal so neighbouring quads fold in opposite directions
        if ((i + j) % 2 === 0) {
          tri(a, b, d, bodyColor(sMid - 0.01, (u0 * 1 + u1 * 2) / 3, TOP[j], faceId));
          tri(a, d, c, bodyColor(sMid + 0.01, (u0 * 2 + u1) / 3, TOP[j], faceId));
        } else {
          tri(a, b, c, bodyColor(sMid - 0.01, (u0 * 2 + u1) / 3, TOP[j], faceId));
          tri(b, d, c, bodyColor(sMid + 0.01, (u0 + u1 * 2) / 3, TOP[j], faceId));
        }
      }
    }

    // ---- eyes: small raised pyramids on the head ----
    for (const side of [1, -1]) {
      const s = 0.075;
      const w = widthAt(s);
      const cx = xAt(s);
      const cy = SIDE_Y + heightAt(s) * 0.38;
      const cz = side * w * 0.86;
      const r = 0.028;
      const tip = new THREE.Vector3(cx, cy + 0.012, cz + side * 0.03);
      const q = [
        new THREE.Vector3(cx + r, cy, cz),
        new THREE.Vector3(cx, cy + r, cz - side * 0.006),
        new THREE.Vector3(cx - r, cy, cz),
        new THREE.Vector3(cx, cy - r, cz + side * 0.006),
      ];
      for (let k = 0; k < 4; k++) tri(q[k], q[(k + 1) % 4], tip, k === 1 ? C.sumi : C.eye);
    }

    // ---- pectoral and pelvic fins: folded triangles with a raised crease ----
    const finPair = (s0: number, span: number, reach: number, back: number, drop: number, accent: boolean) => {
      for (const side of [1, -1]) {
        const w0 = widthAt(s0);
        const w1 = widthAt(s0 + span);
        const r1 = new THREE.Vector3(xAt(s0), SIDE_Y - 0.03, side * w0 * 0.96);
        const r2 = new THREE.Vector3(xAt(s0 + span), SIDE_Y - 0.03, side * w1 * 0.96);
        const tip = new THREE.Vector3(xAt(s0 + span * 0.5 + back), SIDE_Y - drop, side * (w0 + reach));
        const rootMid = r1.clone().lerp(r2, 0.45);
        const crease = rootMid.clone().lerp(tip, 0.5);
        crease.y += 0.045;
        const tail = new THREE.Vector3(xAt(s0 + span + back * 0.75), SIDE_Y - drop * 0.6, side * (w1 + reach * 0.45));
        const f = (v: THREE.Vector3) => Math.min(1, v.distanceTo(rootMid) / reach);
        tri(r1, crease, tip, C.fin, [0, f(crease), f(tip)], side);
        tri(crease, r2, tip, accent ? C.finShade : C.fin, [f(crease), 0, f(tip)], side);
        tri(r2, tail, tip, C.finShade, [0, f(tail), f(tip)], side);
        tri(r1, r2, crease, C.paperShade, [0, 0, f(crease)], side);
      }
    };
    finPair(0.2, 0.08, 0.5, 0.16, 0.06, true);
    finPair(0.56, 0.06, 0.24, 0.1, 0.05, false);

    // ---- dorsal fin: a pleated strip along the ridge ----
    const dStations = [0.3, 0.37, 0.44, 0.51, 0.58, 0.64, 0.69];
    for (let i = 0; i < dStations.length - 1; i++) {
      const sa = dStations[i];
      const sb = dStations[i + 1];
      const lift = (s: number) => 0.2 * Math.sin(((s - 0.3) / 0.39) * Math.PI) ** 0.7 + 0.01;
      const baseA = new THREE.Vector3(xAt(sa), SIDE_Y + heightAt(sa) - 0.005, 0);
      const baseB = new THREE.Vector3(xAt(sb), SIDE_Y + heightAt(sb) - 0.005, 0);
      const zig = i % 2 === 0 ? 0.025 : -0.025;
      const topA = new THREE.Vector3(xAt(sa + 0.05), baseA.y + lift(sa), zig);
      const topB = new THREE.Vector3(xAt(sb + 0.05), baseB.y + lift(sb), -zig);
      tri(baseA, baseB, topA, i % 2 ? C.paper : C.fin);
      tri(baseB, topB, topA, i === 2 ? C.hi : C.paper);
    }

    // ---- forked tail: two splayed lobes, each folded along a crease ----
    {
      const s0 = 1.0;
      const w = widthAt(s0);
      const B = new THREE.Vector3(xAt(s0) + 0.02, SIDE_Y + 0.01, 0);
      const notch = new THREE.Vector3(xAt(1.24), SIDE_Y + 0.02, 0);
      for (const side of [1, -1]) {
        const base = new THREE.Vector3(xAt(s0) + 0.04, SIDE_Y, side * w * 1.15);
        const tip = new THREE.Vector3(xAt(1.4), SIDE_Y + 0.05, side * 0.44);
        const outer = new THREE.Vector3(xAt(1.16), SIDE_Y + 0.02, side * 0.34);
        const crease = new THREE.Vector3(xAt(1.25), SIDE_Y + 0.09, side * 0.21);
        tri(B, base, crease, C.fin, [0, 0, 0], side);
        tri(base, outer, crease, side > 0 ? C.hi : C.finShade, [0, 0, 0], side);
        tri(outer, tip, crease, C.fin, [0, 0, 0], side);
        tri(crease, tip, notch, C.finShade, [0, 0, 0], side);
        tri(B, crease, notch, side > 0 ? C.fin : C.hiDeep, [0, 0, 0], side);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    const posArray = new Float32Array(pos);
    this.rest = posArray.slice();
    this.sAttr = new Float32Array(sArr);
    this.flap = new Float32Array(flapArr);
    this.flapSide = new Float32Array(flapSideArr);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    // the deformed fish never leaves this sphere, so skip recomputing it per frame
    this.geometry.boundingSphere!.radius *= 1.3;

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
  }

  /**
   * Bend the body with a travelling wave.
   * @param phase   accumulated tail-beat phase (radians)
   * @param amp     lateral amplitude at the tail root, world units
   * @param bend    static curvature from turning (positive bends the tail toward +z)
   * @param flutter fin flutter phase
   */
  deform(phase: number, amp: number, bend: number, flutter: number, finAmp: number) {
    const p = this.geometry.attributes.position.array as Float32Array;
    const rest = this.rest;
    const k = 5.2; // spatial frequency: a bit under one wavelength on the body
    for (let i = 0, n = this.sAttr.length; i < n; i++) {
      const s = Math.min(this.sAttr[i], 1.5);
      const sp = Math.max(s, 0);
      // amplitude grows toward the tail; the head barely moves
      const envelope = 0.12 + 0.88 * sp * sp;
      const wave = Math.sin(k * sp - phase);
      const lateral = amp * envelope * wave + bend * sp * sp;
      const i3 = i * 3;
      p[i3] = rest[i3];
      p[i3 + 1] = rest[i3 + 1];
      p[i3 + 2] = rest[i3 + 2] + lateral;
      const fl = this.flap[i];
      if (fl > 0) {
        p[i3 + 1] += fl * finAmp * Math.sin(flutter + this.flapSide[i] * 0.9);
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
}
