/**
 * Integer hashing, and FNV-1a over float data for golden tests.
 *
 * Deliberately integer-only arithmetic: these hashes are asserted against
 * committed digests, so they must be identical on every engine.
 */

/** 32-bit integer scramble. The basis of the value noise. */
export function hash2i(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** hash2i mapped to [0, 1). */
export function hash2f(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 4294967296;
}

/** hash2i mapped to [-1, 1). */
export function hash2s(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 2147483648 - 1;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the raw bytes of a float array. Used for golden hashes of the
 * heightfield and of sim state snapshots, so an accidental behaviour change
 * shows up as a failing test rather than as a mystery weeks later.
 */
export function fnv1aFloats(values: ArrayLike<number>): number {
  const scratch = new Float64Array(1);
  const bytes = new Uint8Array(scratch.buffer);
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < values.length; i++) {
    // Normalize -0 to 0 so a sign bit nobody can observe cannot change the hash.
    const v = values[i];
    scratch[0] = v === 0 ? 0 : v;
    for (let b = 0; b < 8; b++) {
      h = Math.imul(h ^ bytes[b], FNV_PRIME) >>> 0;
    }
  }
  return h >>> 0;
}

export function toHex(h: number): string {
  return (h >>> 0).toString(16).padStart(8, '0');
}
