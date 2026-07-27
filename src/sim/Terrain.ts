import type { Vec2, Vec3 } from '../core/vec3.js';

/**
 * Surface materials. Stored as one byte per heightfield post.
 *
 * `grip` scales lateral hold, `drag` is a constant deceleration in m/s^2, and
 * `landForgive` multiplies the landing grader's angle tolerances -- deep powder
 * saves a sketchy landing, ice and rock do not.
 */
// Plain enums, not `const enum`: esbuild cannot inline const enums across
// modules, so the erasable version would behave differently in the dev server
// than in tests. A real runtime object costs nothing and removes the footgun.
export enum SurfaceId {
  Powder = 0,
  Groomed = 1,
  Packed = 2,
  Ice = 3,
  Rock = 4,
}

export interface SurfaceProps {
  readonly grip: number;
  readonly drag: number;
  readonly landForgive: number;
}

export const SURFACE_PROPS: readonly SurfaceProps[] = [
  { grip: 0.55, drag: 0.055, landForgive: 1.0 }, // Powder
  { grip: 0.85, drag: 0.02, landForgive: 0.9 }, // Groomed
  { grip: 0.75, drag: 0.028, landForgive: 0.8 }, // Packed
  { grip: 0.35, drag: 0.01, landForgive: 0.5 }, // Ice
  { grip: 0.2, drag: 0.35, landForgive: 0.1 }, // Rock
];

export const SURFACE_COUNT = SURFACE_PROPS.length;

export enum TerrainFlag {
  InCorridor = 1 << 0,
  Cliff = 1 << 1,
  /** Terrain the ollie should refuse to pop from (e.g. inside a landing zone). */
  NoJump = 1 << 2,
}

/**
 * One resolved ground contact. Reused as an out-param -- never allocated in the
 * step loop.
 */
export interface Contact {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceId;
  grip: number;
  drag: number;
  landForgive: number;
  flags: number;
  /** 0 = the heightfield itself. Non-zero is reserved for platform proxies. */
  layer: number;
}

export function createContact(): Contact {
  return {
    y: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    surface: SurfaceId.Groomed,
    grip: SURFACE_PROPS[SurfaceId.Groomed].grip,
    drag: SURFACE_PROPS[SurfaceId.Groomed].drag,
    landForgive: SURFACE_PROPS[SurfaceId.Groomed].landForgive,
    flags: 0,
    layer: 0,
  };
}

/**
 * What the simulation is allowed to know about the world.
 *
 * Note that physics is expected to call `support()`, never `height()`. Today
 * `support()` just forwards to the ground, but that one discipline is the whole
 * difference between adding rooftops, bridges and ridable logs later versus
 * rewriting the physics to accommodate them.
 */
export interface TerrainSampler {
  /**
   * Height of the *rendered triangle* under (x, z), not of a bilinear patch.
   *
   * This distinction is the reason the board never visibly floats or sinks: a
   * bilinear patch and the mesh drawn from the same posts disagree by up to
   * ~0.12 m at the centre of a twisted 1 m cell. Sampling the actual triangle
   * plane is both exact against the geometry on screen and cheaper (3 taps).
   */
  height(x: number, z: number): number;

  /**
   * Smooth unit normal, from the four surrounding per-post normals.
   *
   * Deliberately not the bilinear patch's own derivative: that derivative is
   * discontinuous across cell boundaries and shows up as a tick in board
   * orientation every metre, which is very noticeable mid-carve.
   */
  normal(x: number, z: number, out: Vec3): Vec3;

  /** height + normal + material in one cell lookup. The hot path. */
  contact(x: number, z: number, out: Contact): Contact;

  /** Highest support at or below `yHint + tol`. All physics goes through this. */
  support(x: number, z: number, yHint: number, tol: number, out: Contact): Contact;

  surface(x: number, z: number): SurfaceId;

  flags(x: number, z: number): number;

  /** Downhill gradient magnitude; writes the unit downhill direction to `out`. */
  slope(x: number, z: number, out: Vec2): number;

  /**
   * Second directional derivative of height along (dirX, dirZ), in 1/m.
   *
   * Multiply by speed^2 to get the vertical acceleration the terrain imposes on
   * a rider following that heading, in m/s^2 -- which is what the ollie's lip
   * detection actually wants. Negative means convex: a crest.
   */
  convexity(x: number, z: number, dirX: number, dirZ: number): number;

  /** True if the segment from -> to crosses the surface; resolves the crossing. */
  sweep(from: Vec3, to: Vec3, out: Contact): boolean;

  contains(x: number, z: number): boolean;
}
