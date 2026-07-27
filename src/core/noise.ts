/**
 * Seeded value noise.
 *
 * Restricted to +-*\/ and integer hashing -- no Math.sin/cos/pow/exp -- because
 * terrain generation feeds a golden hash that is meant to hold across JS engines,
 * and those functions are only implementation-defined in precision.
 *
 * Value noise rather than gradient/simplex noise: it is a handful of lines, has
 * no lookup tables to keep in sync, and the mountain's *shape* comes from
 * authored stamps anyway. Noise here is only ever surface detail.
 */
import { hash2f } from './hash.js';

/** Quintic smoothstep. C2 continuous, so derived normals stay smooth. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Single-octave value noise in [0, 1). Period 1 in each axis. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const h00 = hash2f(xi, yi, seed);
  const h10 = hash2f(xi + 1, yi, seed);
  const h01 = hash2f(xi, yi + 1, seed);
  const h11 = hash2f(xi + 1, yi + 1, seed);

  const u = fade(xf);
  const v = fade(yf);

  const a = h00 + (h10 - h00) * u;
  const b = h01 + (h11 - h01) * u;
  return a + (b - a) * v;
}

/** Signed single-octave value noise in [-1, 1). */
export function valueNoise2s(x: number, y: number, seed: number): number {
  return valueNoise2(x, y, seed) * 2 - 1;
}

export interface FbmParams {
  /** World metres per unit of the first octave. Larger = broader features. */
  scale: number;
  octaves: number;
  /** Amplitude multiplier per octave. 0.5 is the usual choice. */
  gain: number;
  /** Frequency multiplier per octave. 2.0 is the usual choice. */
  lacunarity: number;
  seed: number;
}

/**
 * Fractal sum of value noise, normalized to roughly [-1, 1].
 *
 * Kept to 2-3 octaves in practice: the readable, authored relief comes from
 * feature stamps, and every extra octave here is relief that fights them.
 */
export function fbm2s(x: number, z: number, p: FbmParams): number {
  let freq = 1 / p.scale;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < p.octaves; o++) {
    sum += valueNoise2s(x * freq, z * freq, (p.seed + o * 0x9e3779b9) | 0) * amp;
    norm += amp;
    amp *= p.gain;
    freq *= p.lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
