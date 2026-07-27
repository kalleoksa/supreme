import { clamp01, smoothstep } from '../core/math.js';
import { fbm2s } from '../core/noise.js';
import type { Vec2 } from '../core/vec3.js';
import { Heightfield } from '../sim/Heightfield.js';
import { TerrainFlag, type SurfaceId } from '../sim/Terrain.js';
import { StampKind, type Stamp, type TrackSpec } from './TrackSpec.js';

/**
 * Compiles a `TrackSpec` into a heightfield. Pure, deterministic, no dependencies beyond
 * `core`.
 *
 * ## The arithmetic restriction
 *
 * Everything on this path is limited to `+ - * /` and `sqrt`. ECMA-262 leaves the
 * precision of `sin`, `cos`, `tan`, `pow`, `exp` and `log` implementation-defined, so a
 * generator that used them would produce subtly different terrain in different JS engines
 * and the golden height hash would only be meaningful on the engine that baked it.
 * `tests/unit/architecture.test.ts` enforces this by reading the source.
 *
 * The board physics is deliberately *not* held to this rule -- it uses `Math.exp` for
 * frame-rate-independent decay, which matters more -- and it can afford not to be, because
 * ghosts are recorded as transforms rather than replayed inputs.
 *
 * ## Runtime
 *
 * About 325 ms for a 400 x 1200 m field at 1 m posts, in Node. That is the dominant cost
 * of booting a track and it happens behind the loading screen. Sectored generation and
 * streaming are additive later; nothing here needs to change for them, which is the reason
 * the spec is compiled rather than the field being authored directly.
 */

/** Smooth radial bump: 1 at the centre, 0 at t >= 1, zero slope at both ends. */
function bump(t: number): number {
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

/** Weight of a stamp at a world position, in 0..1. */
function stampWeight(stamp: Stamp, x: number, z: number): number {
  const dx = (x - stamp.x) / stamp.radiusX;
  const dz = (z - stamp.z) / stamp.radiusZ;
  const t = Math.sqrt(dx * dx + dz * dz);
  switch (stamp.kind) {
    case StampKind.Bump:
      return bump(t);
    default:
      return 0;
  }
}

/**
 * Along-slope curvature at a stamp's crest, in 1/m.
 *
 * The charged ollie pays out on this number, so it is what decides whether a stamp is a
 * launch feature or scenery. For the bump profile the second derivative along Z at the
 * centre is `-4 * height / radiusZ^2`. Reported by the validator rather than left for
 * someone to wonder about when a jump feels dead.
 */
export function stampCurvature(stamp: Stamp): number {
  return (-4 * stamp.height) / (stamp.radiusZ * stamp.radiusZ);
}

/**
 * Grade at a distance along the course.
 *
 * Smoothstepped between control points, never linear. A grade that changes slope abruptly
 * is an invisible bump: the physics reacts to it and the player has no way to see it
 * coming.
 */
export function gradeAt(points: readonly { z: number; grade: number }[], z: number): number {
  if (points.length === 0) return 0;
  if (z <= points[0].z) return points[0].grade;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (z <= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      const s = t * t * (3 - 2 * t);
      return a.grade + (b.grade - a.grade) * s;
    }
  }
  return points[points.length - 1].grade;
}

/**
 * A generated launch feature, indexed for the ollie's forgiveness window and the HUD's
 * lip band.
 *
 * Emitted for every stamp with usable crest curvature. Pure convexity detection alone is
 * too twitchy to guarantee a designed hump feels great, so an authored lip widens the
 * timing window when the rider is travelling roughly along the approach direction. The
 * generic rule still applies everywhere else, which is what keeps the whole mountain
 * poppable rather than only its set pieces.
 */
export interface LaunchFeature {
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  /** Crest curvature in 1/m, negative for a convex lip. */
  curvature: number;
  /** 0..1 usefulness as a launch, normalized against a reference curvature. */
  quality: number;
  label: string | undefined;
}

/** Curvature that reads as a full-quality lip, in 1/m. */
const LAUNCH_REFERENCE_CURVATURE = 0.09;
/** Below this the stamp is scenery, not a launch. */
const LAUNCH_MIN_CURVATURE = 0.02;

export interface GeneratedTrack {
  spec: TrackSpec;
  field: Heightfield;
  /** Per-post stamp coverage in 0..1. Kept for the validator and for debug views. */
  featureMask: Float32Array;
  launches: LaunchFeature[];
  startX: number;
  startZ: number;
  startYaw: number;
  finish: [Vec2, Vec2];
}

export function generateTrack(spec: TrackSpec): GeneratedTrack {
  const { spacing, lengthMetres, widthMetres, seed, cross } = spec;

  const cols = Math.round(widthMetres / spacing) + 1;
  const rows = Math.round(lengthMetres / spacing) + 1;
  const count = cols * rows;

  const heights = new Float32Array(count);
  const surfaces = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const featureMask = new Float32Array(count);

  // Centred on X, starting at Z = 0.
  const originX = -widthMetres / 2;
  const originZ = 0;

  // --- 1. Integrate the grade profile into a centreline elevation.
  //
  // Authoring grades rather than absolute heights means editing one section leaves
  // everything downhill of it consistent automatically, which is the difference between
  // a track you can tune and one where every change is a cascade of manual fixes.
  const centreY = new Float64Array(rows);
  let y = spec.grade.summit;
  centreY[0] = y;
  for (let j = 1; j < rows; j++) {
    const z = j * spacing;
    y -= gradeAt(spec.grade.points, z - spacing * 0.5) * spacing;
    centreY[j] = y;
  }

  // --- 2 and 3. Cross-section, then stamps.
  for (let j = 0; j < rows; j++) {
    const z = originZ + j * spacing;
    const base = centreY[j];

    for (let i = 0; i < cols; i++) {
      const x = originX + i * spacing;
      const idx = j * cols + i;

      const ax = Math.abs(x);
      const inner = clamp01(ax / cross.corridorHalfWidth);
      let h = base + inner * inner * cross.corridorRise;

      const beyond = Math.max(0, ax - cross.corridorHalfWidth);
      h += beyond * beyond * cross.shoulderQuadratic + beyond * cross.shoulderLinear;

      // Each stamp writes its falloff into the mask so the noise below leaves it alone.
      let mask = 0;
      for (let s = 0; s < spec.stamps.length; s++) {
        const stamp = spec.stamps[s];
        const w = stampWeight(stamp, x, z);
        if (w > 0) {
          h += stamp.height * w;
          if (w > mask) mask = w;
        }
      }
      featureMask[idx] = mask;

      heights[idx] = h;
    }
  }

  // --- 4. Masked detail noise. The critical layer.
  //
  //   amplitude * (1 - featureMask) * offPisteWeight
  //
  // Suppressed inside authored features, and weighted per band by distance from the
  // centreline so one band can supply the corridor's continuous poppability while another
  // stays out on the wild shoulders. Without the mask every deliberately-placed lip drowns
  // in bumps and the mountain reads as noise.
  const rampStart = cross.corridorHalfWidth * spec.offPisteRamp[0];
  const rampEnd = cross.corridorHalfWidth * spec.offPisteRamp[1];
  for (let j = 0; j < rows; j++) {
    const z = originZ + j * spacing;
    for (let i = 0; i < cols; i++) {
      const x = originX + i * spacing;
      const idx = j * cols + i;

      const featureFade = 1 - clamp01(featureMask[idx]);
      const offPiste = smoothstep(rampStart, rampEnd, Math.abs(x));

      let sum = 0;
      for (let b = 0; b < spec.noise.length; b++) {
        const band = spec.noise[b];
        const n = fbm2s(x, z, {
          scale: band.scale,
          octaves: band.octaves,
          gain: band.gain,
          lacunarity: band.lacunarity,
          seed: seed ^ band.seedOffset,
        });
        const weight =
          band.offPisteBias[0] + (band.offPisteBias[1] - band.offPisteBias[0]) * offPiste;
        sum += n * band.amplitude * weight;
      }
      heights[idx] += featureFade * sum;
    }
  }

  // --- 5. Constrained smoothing.
  smoothConstrained(heights, featureMask, cols, rows, spec.smoothingPasses);

  const field = new Heightfield({
    cols,
    rows,
    spacing,
    originX,
    originZ,
    heights,
    surfaces,
    flags,
  });

  // --- 6. Materials and flags, from the finished heights.
  assignSurfaces(field, spec);

  const launches: LaunchFeature[] = [];
  for (const stamp of spec.stamps) {
    const curvature = stampCurvature(stamp);
    if (-curvature < LAUNCH_MIN_CURVATURE) continue;
    launches.push({
      x: stamp.x,
      z: stamp.z,
      radiusX: stamp.radiusX,
      radiusZ: stamp.radiusZ,
      curvature,
      quality: clamp01(-curvature / LAUNCH_REFERENCE_CURVATURE),
      label: stamp.label,
    });
  }

  const finishZ = lengthMetres - spec.finishInset;

  return {
    spec,
    field,
    featureMask,
    launches,
    startX: spec.start.x,
    startZ: spec.start.z,
    startYaw: spec.start.yaw,
    finish: [
      { x: -cross.boundsHalfWidth, z: finishZ },
      { x: cross.boundsHalfWidth, z: finishZ },
    ],
  };
}

/**
 * Laplacian smoothing weighted by `1 - featureMask`.
 *
 * Stamp interiors keep their authored shape while the noisy shoulders lose their harshest
 * single-post spikes. Smoothing everything equally would round off exactly the lips the
 * stamps exist to create.
 */
function smoothConstrained(
  heights: Float32Array,
  featureMask: Float32Array,
  cols: number,
  rows: number,
  iterations: number,
): void {
  const tmp = new Float32Array(heights.length);
  for (let it = 0; it < iterations; it++) {
    tmp.set(heights);
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const idx = j * cols + i;
        const avg = (tmp[idx - 1] + tmp[idx + 1] + tmp[idx - cols] + tmp[idx + cols]) * 0.25;
        const w = (1 - clamp01(featureMask[idx])) * 0.5;
        heights[idx] = tmp[idx] + (avg - tmp[idx]) * w;
      }
    }
  }
}

/**
 * Materials from slope, position and a little noise.
 *
 * Rule-based rather than painted: it costs nothing, it stays correct when the heights
 * change, and it means the corridor is always groomed no matter how the grade profile is
 * edited.
 */
function assignSurfaces(field: Heightfield, spec: TrackSpec): void {
  const { cols, rows, spacing, originX, originZ, surfaces, flagBytes, normals } = field;
  const rules = spec.surfaces;
  const { corridorHalfWidth, boundsHalfWidth } = spec.cross;
  const shoulderEdge = corridorHalfWidth * rules.shoulderSurfaceExtent;

  for (let j = 0; j < rows; j++) {
    const z = originZ + j * spacing;
    for (let i = 0; i < cols; i++) {
      const x = originX + i * spacing;
      const idx = j * cols + i;
      const ny = normals[idx * 3 + 1];

      const ax = Math.abs(x);
      const inCorridor = ax <= corridorHalfWidth;
      const inBounds = ax <= boundsHalfWidth;

      let surface: SurfaceId;
      if (ny < rules.rockNormalY) {
        surface = rules.rock;
      } else if (inCorridor) {
        const ice = rules.ice;
        if (ice) {
          const v = fbm2s(x, z, {
            scale: ice.scale,
            octaves: ice.octaves,
            gain: ice.gain,
            lacunarity: ice.lacunarity,
            seed: spec.seed ^ ice.seedOffset,
          });
          surface = v > ice.threshold ? ice.surface : rules.corridor;
        } else {
          surface = rules.corridor;
        }
      } else if (ax < shoulderEdge) {
        surface = rules.shoulder;
      } else {
        surface = rules.outer;
      }

      surfaces[idx] = surface;

      let f = 0;
      if (inBounds) f |= TerrainFlag.InCorridor;
      if (ny < rules.cliffNormalY) f |= TerrainFlag.Cliff;
      flagBytes[idx] = f;
    }
  }
}
