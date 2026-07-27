/**
 * Plain-object 3-vectors.
 *
 * The sim must not import THREE.Vector3 -- keeping sim state as plain data is
 * what makes it snapshot-able, hashable and testable in Node. These helpers are
 * all out-param or scalar-returning: no allocation in the hot path, because GC
 * pauses are fatal to a carving game.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function set3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy3(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function add3(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub3(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scale3(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s. The workhorse of an integrator. */
export function addScaled3(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function len3(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function lenSq3(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

/** Horizontal speed only -- what "how fast am I going" means on a mountain. */
export function lenXZ(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

/**
 * Normalize in place. Returns the original length so callers can branch on a
 * degenerate vector rather than silently producing NaN -- the single most common
 * source of "the rider vanished" bugs in code like this.
 */
export function normalize3(out: Vec3, a: Vec3): number {
  const l = len3(a);
  if (l < 1e-12) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return 0;
  }
  const inv = 1 / l;
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  return l;
}

export function lerp3(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Remove the component of `a` along unit vector `n`. */
export function projectOntoPlane3(out: Vec3, a: Vec3, n: Vec3): Vec3 {
  const d = dot3(a, n);
  out.x = a.x - n.x * d;
  out.y = a.y - n.y * d;
  out.z = a.z - n.z * d;
  return out;
}

export const WORLD_UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
