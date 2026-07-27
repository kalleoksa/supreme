import { clamp, clamp01 } from '../core/math.js';
import type { Vec2 } from '../core/vec3.js';
import type { Heightfield } from '../sim/Heightfield.js';
import { TerrainFlag } from '../sim/Terrain.js';

/**
 * A baked scalar field of "how far through the run am I", and the single most useful
 * artifact in the whole race system.
 *
 * ## Why not a centreline
 *
 * The obvious way to measure progress is to project the rider onto a spline down the
 * middle of the course. That directly contradicts the design pillar: this game is about
 * choosing your own line down a wide mountain, and a centreline produces nonsense the
 * moment a player takes a branch, cuts through a bowl, or rides a shoulder. Worse, it
 * makes "did they shortcut or did they cheat" an unanswerable question.
 *
 * Instead: flood the ridable corridor with geodesic distance to the finish line, and
 * normalize. Progress is then a bilinear lookup that works on *any* line.
 *
 * One artifact solves a surprising number of problems:
 *
 *  - **Progress on any route.** Branches, bowls and shortcuts all just work.
 *  - **Shortcut versus cheat stop being the same question.** The flood respects the
 *    corridor mask, so cutting across excluded terrain earns no progress at all -- it
 *    *is* out of bounds, by construction, with no special case.
 *  - **Splits without gates.** A checkpoint is a progress threshold, valid for every
 *    line, rather than a trigger volume a player can legitimately ride around.
 *  - **Comparing two different lines.** Time at equal progress is the only metric that
 *    makes "who is ahead" meaningful when two riders took different terrain.
 *  - **Direction of play, free.** The negative gradient points down-course, which gives
 *    the wrong-way arrow, the return-to-course arrow, and later the AI's racing line.
 *  - **A reachability check.** If the start has infinite distance, the course is broken,
 *    and the build knows it before anyone plays it.
 */

/** Metres per progress-grid cell. Coarse on purpose: this is a routing field. */
export const PROGRESS_CELL = 4;

const UNREACHABLE = Infinity;

export interface ProgressFieldOptions {
  /** World-space finish line, as two endpoints. */
  finish: readonly [Vec2, Vec2];
  /** Cell size in metres. Defaults to PROGRESS_CELL. */
  cell?: number;
  /**
   * Treat a post as ridable. Defaults to "inside the corridor and not a cliff".
   * Overridable so a track can widen or narrow what counts without touching flags.
   */
  isRidable?: (flags: number, normalY: number) => boolean;
}

function defaultRidable(flags: number, normalY: number): boolean {
  return (
    (flags & TerrainFlag.InCorridor) !== 0 && (flags & TerrainFlag.Cliff) === 0 && normalY > 0.45
  );
}

export class ProgressField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly originX: number;
  readonly originZ: number;

  /** Geodesic distance to the finish, in metres. Infinity where unreachable. */
  readonly distance: Float32Array;
  /** Normalized 0..1 progress; 1 at the finish. Zero where unreachable. */
  readonly progress: Float32Array;
  /**
   * Signed distance to the corridor edge, in metres: positive inside, negative outside,
   * clamped to +-127. Drives the out-of-bounds warning and the return arrow.
   */
  readonly oobDistance: Float32Array;

  readonly maxDistance: number;
  /** True when the start of the course can actually reach the finish. */
  readonly reachable: boolean;

  constructor(field: Heightfield, options: ProgressFieldOptions) {
    this.cell = options.cell ?? PROGRESS_CELL;
    this.originX = field.originX;
    this.originZ = field.originZ;
    this.cols = Math.max(2, Math.ceil(field.widthMetres / this.cell) + 1);
    this.rows = Math.max(2, Math.ceil(field.depthMetres / this.cell) + 1);

    const count = this.cols * this.rows;
    this.distance = new Float32Array(count).fill(UNREACHABLE);
    this.progress = new Float32Array(count);
    this.oobDistance = new Float32Array(count);

    const ridable = options.isRidable ?? defaultRidable;
    const passable = new Uint8Array(count);

    // --- Sample ridability onto the coarse grid.
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const x = this.originX + i * this.cell;
        const z = this.originZ + j * this.cell;
        if (!field.contains(x, z)) continue;
        field.normal(x, z, tmpNormal);
        passable[j * this.cols + i] = ridable(field.flags(x, z), tmpNormal.y) ? 1 : 0;
      }
    }

    this.maxDistance = this.flood(passable, options.finish);
    this.reachable = Number.isFinite(this.maxDistance) && this.maxDistance > 0;

    // --- Normalize. Progress runs 0 at the furthest reachable point to 1 at the finish.
    for (let k = 0; k < count; k++) {
      const d = this.distance[k];
      this.progress[k] = Number.isFinite(d) ? clamp01(1 - d / this.maxDistance) : 0;
    }

    this.buildOobDistance(passable);
  }

  /**
   * Dijkstra from the finish line across passable cells.
   *
   * Dijkstra rather than a plain BFS because diagonal steps cost sqrt(2), and treating
   * them as equal would bend the field enough to distort split placement. A bucket queue
   * would be faster; at ~30k cells this runs in milliseconds and clarity wins.
   */
  private flood(passable: Uint8Array, finish: readonly [Vec2, Vec2]): number {
    const { cols, rows, cell } = this;
    const dist = this.distance;

    // Seed every passable cell the finish line passes through.
    const seeds: number[] = [];
    const [a, b] = finish;
    const lineLength = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.ceil(lineLength / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const i = Math.round((x - this.originX) / cell);
      const j = Math.round((z - this.originZ) / cell);
      if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
      const k = j * cols + i;
      if (!passable[k] || dist[k] === 0) continue;
      dist[k] = 0;
      seeds.push(k);
    }

    if (seeds.length === 0) return UNREACHABLE;

    const queue = new CellHeap();
    for (const k of seeds) queue.push(k, 0);

    const straight = cell;
    const diagonal = cell * Math.SQRT2;
    let furthest = 0;

    while (queue.size > 0) {
      const k = queue.pop();
      const d = queue.poppedKey;
      // Lazy deletion instead of decrease-key: a cell is re-queued when a shorter route
      // to it is found, and the older, longer entry is stale when it surfaces. Skipping
      // it here is what keeps the distances optimal.
      if (d > dist[k]) continue;
      const i = k % cols;
      const j = (k - i) / cols;
      if (d > furthest) furthest = d;

      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const nk = nj * cols + ni;
          if (!passable[nk]) continue;
          // Do not cut corners through impassable cells diagonally.
          if (di !== 0 && dj !== 0) {
            if (!passable[j * cols + ni] || !passable[nj * cols + i]) continue;
          }
          const step = di !== 0 && dj !== 0 ? diagonal : straight;
          const nd = d + step;
          if (nd < dist[nk]) {
            dist[nk] = nd;
            queue.push(nk, nd);
          }
        }
      }
    }

    return furthest > 0 ? furthest : UNREACHABLE;
  }

  /**
   * Signed distance to the corridor edge, by two-pass chamfer transform.
   *
   * Cheap and good enough: the value drives a warning countdown and an arrow, neither of
   * which needs sub-metre accuracy.
   */
  private buildOobDistance(passable: Uint8Array): void {
    const { cols, rows, cell } = this;
    const inside = new Float32Array(cols * rows).fill(1e6);
    const outside = new Float32Array(cols * rows).fill(1e6);

    // Edge cells seed both transforms.
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        let boundary = false;
        for (let dj = -1; dj <= 1 && !boundary; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
            if (passable[nj * cols + ni] !== passable[k]) {
              boundary = true;
              break;
            }
          }
        }
        if (boundary) {
          if (passable[k]) inside[k] = 0;
          else outside[k] = 0;
        }
      }
    }

    chamfer(inside, cols, rows, cell);
    chamfer(outside, cols, rows, cell);

    for (let k = 0; k < cols * rows; k++) {
      const signed = passable[k] ? inside[k] : -outside[k];
      this.oobDistance[k] = clamp(signed, -127, 127);
    }
  }

  private sampleBilinear(grid: Float32Array, x: number, z: number): number {
    const fx = clamp((x - this.originX) / this.cell, 0, this.cols - 1 - 1e-6);
    const fz = clamp((z - this.originZ) / this.cell, 0, this.rows - 1 - 1e-6);
    const i = fx | 0;
    const j = fz | 0;
    const u = fx - i;
    const v = fz - j;
    const b = j * this.cols + i;
    const h00 = grid[b];
    const h10 = grid[b + 1];
    const h01 = grid[b + this.cols];
    const h11 = grid[b + this.cols + 1];
    return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
  }

  /** Normalized progress 0..1 at a world position. */
  progressAt(x: number, z: number): number {
    return this.sampleBilinear(this.progress, x, z);
  }

  /** Signed metres to the corridor edge: positive inside, negative outside. */
  oobDistanceAt(x: number, z: number): number {
    return this.sampleBilinear(this.oobDistance, x, z);
  }

  isInCorridor(x: number, z: number): boolean {
    return this.oobDistanceAt(x, z) > 0;
  }

  /**
   * Trace the `progress == threshold` isoline across the field, west to east.
   *
   * This is the payoff of measuring splits as thresholds rather than gates: the
   * checkpoint exists as a number first, and the banner the player rides through is
   * *derived* from it. So the marker is guaranteed to sit exactly where the split
   * triggers, on every line, and no one has to place it by hand or keep it in sync.
   *
   * Assumes progress rises with +Z, which is the down-course direction for every track
   * in M1. It is a presentation query -- the split itself does not care -- so a track
   * that doubled back would get a misplaced banner rather than a wrong time.
   */
  isoline(threshold: number, stepMetres = 8): Vec2[] {
    const out: Vec2[] = [];
    if (!this.reachable) return out;

    const width = (this.cols - 1) * this.cell;
    const zLow = this.originZ;
    const zHigh = this.originZ + (this.rows - 1) * this.cell;

    for (let x = this.originX; x <= this.originX + width; x += stepMetres) {
      if (this.progressAt(x, zLow) > threshold) continue;
      if (this.progressAt(x, zHigh) < threshold) continue;

      let lo = zLow;
      let hi = zHigh;
      // 24 halvings takes a 1200 m field below a tenth of a millimetre; the cost is
      // dozens of bilinear taps, once, at load.
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) * 0.5;
        if (this.progressAt(x, mid) < threshold) lo = mid;
        else hi = mid;
      }
      const z = (lo + hi) * 0.5;
      // Off-course columns are flat zero, so the search converges on nothing meaningful
      // there. Dropping them is what keeps a banner from crossing a rock face.
      if (!this.isInCorridor(x, z)) continue;
      if (Math.abs(this.progressAt(x, z) - threshold) > 0.01) continue;
      out.push({ x, z });
    }
    return out;
  }

  /**
   * Unit direction toward the finish along ridable terrain, from the progress gradient.
   *
   * Same field, no extra data: this is the wrong-way arrow, the return-to-course arrow
   * and the camera's lookahead bias, all for free.
   */
  directionToFinish(x: number, z: number, out: Vec2): Vec2 {
    const h = this.cell;
    const gx = this.progressAt(x + h, z) - this.progressAt(x - h, z);
    const gz = this.progressAt(x, z + h) - this.progressAt(x, z - h);
    const len = Math.hypot(gx, gz);
    if (len < 1e-9) {
      out.x = 0;
      out.z = 0;
      return out;
    }
    out.x = gx / len;
    out.z = gz / len;
    return out;
  }
}

const tmpNormal = { x: 0, y: 1, z: 0 };

/**
 * Binary min-heap of (cell, distance) pairs.
 *
 * Keys are stored alongside the cell rather than read back out of the distance array,
 * because the flood lowers distances as it goes: a live-keyed heap would silently break
 * its own ordering invariant the moment a shorter route to a queued cell was found, and
 * the result is a field that is subtly wrong in exactly the places where two routes
 * meet -- which, on a course built around route choice, is everywhere interesting.
 *
 * A bucket queue would be faster still. At ~30k cells this runs in milliseconds once at
 * load, so clarity wins.
 */
class CellHeap {
  private readonly cells: number[] = [];
  private readonly keys: number[] = [];

  /** Distance of the most recently popped cell. Avoids allocating a pair per pop. */
  poppedKey = 0;

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, key: number): void {
    this.cells.push(cell);
    this.keys.push(key);
    let i = this.cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const cell = this.cells[0];
    this.poppedKey = this.keys[0];
    const lastCell = this.cells.pop() as number;
    const lastKey = this.keys.pop() as number;
    const n = this.cells.length;
    if (n > 0) {
      this.cells[0] = lastCell;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(smallest, i);
        i = smallest;
      }
    }
    return cell;
  }

  private swap(a: number, b: number): void {
    const cell = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = cell;
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
  }
}

/** Two-pass chamfer distance transform, in metres. */
function chamfer(grid: Float32Array, cols: number, rows: number, cell: number): void {
  const s = cell;
  const d = cell * Math.SQRT2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      let best = grid[k];
      if (i > 0) best = Math.min(best, grid[k - 1] + s);
      if (j > 0) best = Math.min(best, grid[k - cols] + s);
      if (i > 0 && j > 0) best = Math.min(best, grid[k - cols - 1] + d);
      if (i < cols - 1 && j > 0) best = Math.min(best, grid[k - cols + 1] + d);
      grid[k] = best;
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const k = j * cols + i;
      let best = grid[k];
      if (i < cols - 1) best = Math.min(best, grid[k + 1] + s);
      if (j < rows - 1) best = Math.min(best, grid[k + cols] + s);
      if (i < cols - 1 && j < rows - 1) best = Math.min(best, grid[k + cols + 1] + d);
      if (i > 0 && j < rows - 1) best = Math.min(best, grid[k + cols - 1] + d);
      grid[k] = best;
    }
  }
}
