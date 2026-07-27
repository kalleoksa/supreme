export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, clamped to 0..1. Useful for turning a speed into a 0..1 knob. */
export function invLerp01(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = invLerp01(edge0, edge1, v);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential decay factor for `v *= expDecay(k, dt)`.
 *
 * This is why 30 fps and 120 fps agree exactly: the decay is analytic in dt
 * rather than a per-step multiply.
 *
 * On Math.exp and determinism: ECMA-262 leaves the precision of exp/sin/cos/pow
 * implementation-defined, so results can differ between JS engines. That is fine
 * *here* -- ghosts are recorded as transforms, not replayed inputs, and the test
 * suite runs on one engine. It is NOT fine in terrain generation, whose golden
 * hash is meant to be portable; that path is restricted to +-*\/ and sqrt.
 */
export function expDecay(ratePerSecond: number, dt: number): number {
  return Math.exp(-ratePerSecond * dt);
}

/** Move `from` toward `to` by at most `maxDelta`. */
export function approach(from: number, to: number, maxDelta: number): number {
  const d = to - from;
  if (d > maxDelta) return from + maxDelta;
  if (d < -maxDelta) return from - maxDelta;
  return to;
}

/**
 * Critically-damped smoothing toward a target with a time constant, evaluated
 * analytically so it is frame-rate independent.
 */
export function smoothTowards(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const a = 1 - Math.exp(-dt / tau);
  return current + (target - current) * a;
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Shortest signed angular difference from `a` to `b`, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
