/**
 * Static obstacles, in a uniform spatial grid.
 *
 * Pure and allocation-free on the query path: `stepBoard` calls `firstHit` every tick, and
 * a GC pause is fatal to a carving game.
 *
 * ## Why a grid and not a physics engine
 *
 * The whole obstacle set is a list of upright cylinders that never move. A broadphase from
 * a physics library would bring a dependency, a body per tree, and a solver whose contact
 * response is the opposite of what an arcade crash wants. A grid lookup plus a radius test
 * is a few lines, exact, and leaves the crash entirely under the game's control.
 *
 * Cell size is set to comfortably exceed the largest obstacle radius plus one tick of
 * travel, so a query only ever needs the 3x3 neighbourhood.
 */

export interface ObstacleSet {
  /** Interleaved x, z per obstacle. */
  readonly positions: Float32Array;
  /** Collision radius per obstacle, in metres. */
  readonly radii: Float32Array;
  /** Species index per obstacle, for rendering and for debug output. */
  readonly species: Uint8Array;
  readonly count: number;
}

/** Metres per grid cell. Larger than any trunk plus a tick of travel at full speed. */
const CELL = 8;

export class Obstacles {
  readonly count: number;
  readonly positions: Float32Array;
  readonly radii: Float32Array;
  readonly species: Uint8Array;

  private readonly cols: number;
  private readonly rows: number;
  private readonly minX: number;
  private readonly minZ: number;
  /** CSR-style buckets: `starts[c]` .. `starts[c + 1]` indexes into `items`. */
  private readonly starts: Int32Array;
  private readonly items: Int32Array;

  constructor(set: ObstacleSet) {
    this.count = set.count;
    this.positions = set.positions;
    this.radii = set.radii;
    this.species = set.species;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < set.count; i++) {
      const x = set.positions[i * 2];
      const z = set.positions[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (set.count === 0) {
      minX = 0;
      minZ = 0;
      maxX = 0;
      maxZ = 0;
    }

    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.max(1, Math.floor((maxX - minX) / CELL) + 1);
    this.rows = Math.max(1, Math.floor((maxZ - minZ) / CELL) + 1);

    // Counting sort into buckets: one pass to count, a prefix sum, one pass to fill. No
    // per-cell arrays, so the whole structure is three typed arrays.
    const cellCount = this.cols * this.rows;
    const counts = new Int32Array(cellCount + 1);
    for (let i = 0; i < set.count; i++) counts[this.cellOf(i) + 1]++;
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
    this.starts = counts;
    this.items = new Int32Array(set.count);
    const cursor = Int32Array.from(counts.subarray(0, cellCount));
    for (let i = 0; i < set.count; i++) this.items[cursor[this.cellOf(i)]++] = i;
  }

  private cellOf(index: number): number {
    const x = this.positions[index * 2];
    const z = this.positions[index * 2 + 1];
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
    const j = Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
    return j * this.cols + i;
  }

  /**
   * Index of an obstacle overlapping a disc at (x, z), or -1.
   *
   * Returns the deepest overlap rather than the first found, so a rider clipping two trunks
   * at once collides with the one they actually hit.
   */
  firstHit(x: number, z: number, bodyRadius: number): number {
    const ci = Math.floor((x - this.minX) / CELL);
    const cj = Math.floor((z - this.minZ) / CELL);

    let best = -1;
    let deepest = 0;
    for (let dj = -1; dj <= 1; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= this.rows) continue;
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        if (i < 0 || i >= this.cols) continue;
        const cell = j * this.cols + i;
        const end = this.starts[cell + 1];
        for (let k = this.starts[cell]; k < end; k++) {
          const idx = this.items[k];
          const dx = x - this.positions[idx * 2];
          const dz = z - this.positions[idx * 2 + 1];
          const reach = this.radii[idx] + bodyRadius;
          const overlap = reach * reach - (dx * dx + dz * dz);
          if (overlap > deepest) {
            deepest = overlap;
            best = idx;
          }
        }
      }
    }
    return best;
  }

  /** Whether anything overlaps a disc. Slightly cheaper than `firstHit` when the id is unused. */
  anyHit(x: number, z: number, bodyRadius: number): boolean {
    return this.firstHit(x, z, bodyRadius) >= 0;
  }

  positionOf(index: number, out: { x: number; z: number }): { x: number; z: number } {
    out.x = this.positions[index * 2];
    out.z = this.positions[index * 2 + 1];
    return out;
  }

  radiusOf(index: number): number {
    return this.radii[index];
  }
}

/** An empty set, so callers never need to branch on "no obstacles". */
export const NO_OBSTACLES = new Obstacles({
  positions: new Float32Array(0),
  radii: new Float32Array(0),
  species: new Uint8Array(0),
  count: 0,
});
