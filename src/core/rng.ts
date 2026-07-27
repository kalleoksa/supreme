/**
 * Seeded PRNG (mulberry32). Integer ops only, so it is bit-identical on every
 * engine. The sim never calls Math.random -- any randomness is passed in as one
 * of these, so a run can be reproduced.
 */
export interface Rng {
  (): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [lo, hi). */
export function range(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Integer in [0, n). */
export function int(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}
