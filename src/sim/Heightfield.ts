import { clamp } from '../core/math.js';
import type { Vec2, Vec3 } from '../core/vec3.js';
import { SURFACE_PROPS, type Contact, type SurfaceId, type TerrainSampler } from './Terrain.js';

export interface HeightfieldInit {
  /** Posts along +X. */
  readonly cols: number;
  /** Posts along +Z. */
  readonly rows: number;
  /** Metres between posts. 1.0 for M1: a 4 m kicker lip needs >2 cells to read. */
  readonly spacing: number;
  /** World position of post (0, 0). */
  readonly originX: number;
  readonly originZ: number;
  readonly heights: Float32Array;
  readonly surfaces: Uint8Array;
  readonly flags: Uint8Array;
}

/**
 * A single-resolution heightfield, and the only source of truth about the ground.
 *
 * Render meshes are derived from this and are disposable; the sampler is
 * authoritative. Every method is zero-allocation.
 *
 * ## The diagonal split
 *
 * Each cell is two triangles sharing the (i,j)-(i+1,j+1) diagonal. That choice is
 * global and is shared verbatim with the mesh builder in
 * `render/TerrainMesh.ts`. If the two ever disagree, the board floats or sinks by
 * up to ~0.12 m and it looks like a physics bug. `tests/unit/heightfield.test.ts`
 * asserts they agree by raycasting the generated mesh.
 */
export class Heightfield implements TerrainSampler {
  readonly cols: number;
  readonly rows: number;
  readonly spacing: number;
  readonly invSpacing: number;
  readonly originX: number;
  readonly originZ: number;
  readonly heights: Float32Array;
  readonly surfaces: Uint8Array;
  readonly flagBytes: Uint8Array;

  /** Per-post unit normals, 3 floats per post, from central differences. */
  readonly normals: Float32Array;

  readonly minHeight: number;
  readonly maxHeight: number;

  constructor(init: HeightfieldInit) {
    const { cols, rows, spacing } = init;
    if (cols < 2 || rows < 2) throw new Error('Heightfield needs at least 2x2 posts');
    const expected = cols * rows;
    if (init.heights.length !== expected) {
      throw new Error(`heights length ${init.heights.length} != ${expected}`);
    }
    if (init.surfaces.length !== expected) {
      throw new Error(`surfaces length ${init.surfaces.length} != ${expected}`);
    }
    if (init.flags.length !== expected) {
      throw new Error(`flags length ${init.flags.length} != ${expected}`);
    }

    this.cols = cols;
    this.rows = rows;
    this.spacing = spacing;
    this.invSpacing = 1 / spacing;
    this.originX = init.originX;
    this.originZ = init.originZ;
    this.heights = init.heights;
    this.surfaces = init.surfaces;
    this.flagBytes = init.flags;

    this.normals = new Float32Array(expected * 3);
    this.rebuildNormals();

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < expected; i++) {
      const h = this.heights[i];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    this.minHeight = lo;
    this.maxHeight = hi;
  }

  get widthMetres(): number {
    return (this.cols - 1) * this.spacing;
  }

  get depthMetres(): number {
    return (this.rows - 1) * this.spacing;
  }

  /**
   * Per-post normals by central difference, one-sided at the borders.
   *
   * The render mesh uses these same values as its vertex normals, so the shaded
   * orientation and the simulated orientation agree by construction.
   */
  rebuildNormals(): void {
    const { cols, rows, heights, normals, spacing } = this;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = j * cols + i;

        const iL = i > 0 ? i - 1 : i;
        const iR = i < cols - 1 ? i + 1 : i;
        const jD = j > 0 ? j - 1 : j;
        const jU = j < rows - 1 ? j + 1 : j;

        const dx = (heights[j * cols + iR] - heights[j * cols + iL]) / ((iR - iL) * spacing);
        const dz = (heights[jU * cols + i] - heights[jD * cols + i]) / ((jU - jD) * spacing);

        // n = normalize(-dh/dx, 1, -dh/dz)
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        normals[c * 3] = -dx * inv;
        normals[c * 3 + 1] = inv;
        normals[c * 3 + 2] = -dz * inv;
      }
    }
  }

  contains(x: number, z: number): boolean {
    const fx = (x - this.originX) * this.invSpacing;
    const fz = (z - this.originZ) * this.invSpacing;
    return fx >= 0 && fz >= 0 && fx <= this.cols - 1 && fz <= this.rows - 1;
  }

  /** Clamped post index and fractional offset. The only place index math lives. */
  private cellX(x: number): number {
    const fx = (x - this.originX) * this.invSpacing;
    return clamp(fx, 0, this.cols - 1 - 1e-6);
  }

  private cellZ(z: number): number {
    const fz = (z - this.originZ) * this.invSpacing;
    return clamp(fz, 0, this.rows - 1 - 1e-6);
  }

  height(x: number, z: number): number {
    const fx = this.cellX(x);
    const fz = this.cellZ(z);
    const i = fx | 0;
    const j = fz | 0;
    const u = fx - i;
    const v = fz - j;

    const cols = this.cols;
    const b = j * cols + i;
    const h = this.heights;
    const h00 = h[b];
    const h10 = h[b + 1];
    const h01 = h[b + cols];
    const h11 = h[b + cols + 1];

    // Diagonal (0,0)-(1,1). Lower triangle is (h00, h10, h11); upper is
    // (h00, h11, h01). Both planes are exact, so the two agree on the diagonal.
    return u >= v
      ? h00 + u * (h10 - h00) + v * (h11 - h10)
      : h00 + u * (h11 - h01) + v * (h01 - h00);
  }

  normal(x: number, z: number, out: Vec3): Vec3 {
    const fx = this.cellX(x);
    const fz = this.cellZ(z);
    const i = fx | 0;
    const j = fz | 0;
    const u = fx - i;
    const v = fz - j;

    const cols = this.cols;
    const n = this.normals;
    const b = (j * cols + i) * 3;
    const bR = b + 3;
    const bU = b + cols * 3;
    const bUR = bU + 3;

    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;

    let nx = n[b] * w00 + n[bR] * w10 + n[bU] * w01 + n[bUR] * w11;
    let ny = n[b + 1] * w00 + n[bR + 1] * w10 + n[bU + 1] * w01 + n[bUR + 1] * w11;
    let nz = n[b + 2] * w00 + n[bR + 2] * w10 + n[bU + 2] * w01 + n[bUR + 2] * w11;

    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= inv;
    ny *= inv;
    nz *= inv;

    out.x = nx;
    out.y = ny;
    out.z = nz;
    return out;
  }

  contact(x: number, z: number, out: Contact): Contact {
    const fx = this.cellX(x);
    const fz = this.cellZ(z);
    const i = fx | 0;
    const j = fz | 0;
    const u = fx - i;
    const v = fz - j;

    const cols = this.cols;
    const b = j * cols + i;
    const bU = b + cols;

    // Height: the rendered triangle.
    const h = this.heights;
    const h00 = h[b];
    const h10 = h[b + 1];
    const h01 = h[bU];
    const h11 = h[bU + 1];
    out.y =
      u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + u * (h11 - h01) + v * (h01 - h00);

    // Normal: blended per-post normals.
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;

    const n = this.normals;
    const n0 = b * 3;
    const n1 = n0 + 3;
    const n2 = bU * 3;
    const n3 = n2 + 3;

    let nx = n[n0] * w00 + n[n1] * w10 + n[n2] * w01 + n[n3] * w11;
    let ny = n[n0 + 1] * w00 + n[n1 + 1] * w10 + n[n2 + 1] * w01 + n[n3 + 1] * w11;
    let nz = n[n0 + 2] * w00 + n[n1 + 2] * w10 + n[n2 + 2] * w01 + n[n3 + 2] * w11;
    const invN = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= invN;
    ny *= invN;
    nz *= invN;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;

    // Material: the *id* comes from the nearest post, because discrete choices
    // (spray colour, sfx bank) must not be smeared. The scalar properties are
    // blended, so crossing groomed -> ice is a grip ramp rather than a snap.
    const s = this.surfaces;
    const s00 = s[b];
    const s10 = s[b + 1];
    const s01 = s[bU];
    const s11 = s[bU + 1];

    out.surface = (u >= 0.5 ? (v >= 0.5 ? s11 : s10) : v >= 0.5 ? s01 : s00) as SurfaceId;

    const p = SURFACE_PROPS;
    const p00 = p[s00];
    const p10 = p[s10];
    const p01 = p[s01];
    const p11 = p[s11];
    out.grip = p00.grip * w00 + p10.grip * w10 + p01.grip * w01 + p11.grip * w11;
    out.drag = p00.drag * w00 + p10.drag * w10 + p01.drag * w01 + p11.drag * w11;
    out.landForgive =
      p00.landForgive * w00 + p10.landForgive * w10 + p01.landForgive * w01 + p11.landForgive * w11;

    // Flags are a bitfield: union them, so being partly on a cliff post counts.
    const f = this.flagBytes;
    out.flags = f[b] | f[b + 1] | f[bU] | f[bU + 1];
    out.layer = 0;

    return out;
  }

  support(x: number, z: number, _yHint: number, _tol: number, out: Contact): Contact {
    // M1: the ground is the only support layer. Platform proxies (rooftops,
    // bridges, ridable logs) will resolve here without touching call sites.
    return this.contact(x, z, out);
  }

  surface(x: number, z: number): SurfaceId {
    const fx = this.cellX(x);
    const fz = this.cellZ(z);
    const i = Math.round(fx);
    const j = Math.round(fz);
    return this.surfaces[j * this.cols + i] as SurfaceId;
  }

  flags(x: number, z: number): number {
    const fx = this.cellX(x);
    const fz = this.cellZ(z);
    const i = Math.round(fx);
    const j = Math.round(fz);
    return this.flagBytes[j * this.cols + i];
  }

  slope(x: number, z: number, out: Vec2): number {
    const fx = this.cellX(x);
    const fz = this.cellZ(z);
    const i = fx | 0;
    const j = fz | 0;
    const u = fx - i;
    const v = fz - j;

    const cols = this.cols;
    const n = this.normals;
    const b = (j * cols + i) * 3;
    const bR = b + 3;
    const bU = b + cols * 3;
    const bUR = bU + 3;

    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;

    // The horizontal part of the surface normal already points downhill.
    const nx = n[b] * w00 + n[bR] * w10 + n[bU] * w01 + n[bUR] * w11;
    const ny = n[b + 1] * w00 + n[bR + 1] * w10 + n[bU + 1] * w01 + n[bUR + 1] * w11;
    const nz = n[b + 2] * w00 + n[bR + 2] * w10 + n[bU + 2] * w01 + n[bUR + 2] * w11;

    const horiz = Math.sqrt(nx * nx + nz * nz);
    if (horiz < 1e-9 || ny <= 1e-9) {
      out.x = 0;
      out.z = 0;
      return 0;
    }
    out.x = nx / horiz;
    out.z = nz / horiz;
    // |grad h| = tan(slope) = horiz / ny.
    return horiz / ny;
  }

  /**
   * Second directional derivative along (dirX, dirZ), by central difference on
   * the height function itself.
   *
   * Stateless and frame-rate independent, which is why the ollie uses this rather
   * than differencing terrain height across ticks: the lip window should not move
   * when the display rate changes.
   */
  convexity(x: number, z: number, dirX: number, dirZ: number, step = 1.5): number {
    const l = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (l < 1e-9) return 0;
    const sx = (dirX / l) * step;
    const sz = (dirZ / l) * step;
    const hm = this.height(x - sx, z - sz);
    const h0 = this.height(x, z);
    const hp = this.height(x + sx, z + sz);
    return (hp - 2 * h0 + hm) / (step * step);
  }

  /**
   * Segment sweep against the surface, by marching in sub-cell increments and
   * bisecting the first sign change of (y - groundY).
   *
   * At 42 m/s and dt = 1/120 the board covers 0.35 m per step against 1 m cells,
   * so terrain tunnelling is not a real risk -- this exists for fast landings and
   * for teleport/reset validation.
   */
  sweep(from: Vec3, to: Vec3, out: Contact): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);

    const steps = Math.max(1, Math.ceil(horiz / (this.spacing * 0.5)));
    let prevT = 0;
    if (from.y - this.height(from.x, from.z) <= 0) {
      this.contact(from.x, from.z, out);
      return true;
    }

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const px = from.x + dx * t;
      const pz = from.z + dz * t;
      const py = from.y + dy * t;
      const diff = py - this.height(px, pz);
      if (diff <= 0) {
        // Bisect for the crossing so the resolved contact is not quantized to
        // the march increment.
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = from.x + dx * mid;
          const mz = from.z + dz * mid;
          const my = from.y + dy * mid;
          if (my - this.height(mx, mz) > 0) lo = mid;
          else hi = mid;
        }
        const cx = from.x + dx * hi;
        const cz = from.z + dz * hi;
        this.contact(cx, cz, out);
        return true;
      }
      prevT = t;
    }
    return false;
  }
}
