import { clamp01, smoothstep } from '../core/math.js';
import { fbm2s } from '../core/noise.js';
import type { Vec2 } from '../core/vec3.js';
import { Heightfield } from '../sim/Heightfield.js';
import { SurfaceId, TerrainFlag } from '../sim/Terrain.js';

/**
 * A test slope for Phases 1-5.
 *
 * This is scaffolding for tuning the ride, not content -- Phase 6 replaces it with
 * a spec-driven generator and an authored track. It is written in the shape that
 * generator will take, though, because the composition order is the part worth
 * getting right early:
 *
 *   base grade -> cross profile -> feature stamps -> MASKED detail noise -> smooth
 *
 * The masked noise step is the one that matters. Detail noise multiplied by
 * `1 - featureMask` is suppressed inside authored features and along the groomed
 * corridor, and amplified out on the wild shoulders. Without that mask, every
 * deliberately-placed launch lip drowns in bumps and the mountain reads as noise.
 *
 * Restricted to + - * / and sqrt: no Math.sin/cos/pow/exp anywhere in here, so the
 * golden height hash in the test suite holds across JS engines.
 */

/** Smooth radial bump, 1 at the centre, 0 at t >= 1, zero slope at both ends. */
function bump(t: number): number {
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

interface Roller {
  /** Metres down the slope. */
  z: number;
  /** Metres from the corridor centreline; positive is +X. */
  x: number;
  radiusX: number;
  radiusZ: number;
  height: number;
}

/**
 * Rollers are the whole point of the test slope: the charged ollie rewards
 * releasing at a crest, so tuning it needs a supply of crests at varied sizes and
 * spacings, some on the racing line and some off it.
 *
 * A roller's usefulness as a launch feature is set by its along-slope curvature,
 * which for this bump profile is about `-4 * height / radiusZ^2` at the crest. The
 * ollie pays out on that number, so a broad low mound is scenery and a tight tall
 * one is a pop. Every entry here is kept past ~0.02 1/m so it actually registers;
 * `terrainGeneration.test.ts` asserts it, which is how a mellowed-out roller gets
 * caught before anyone wonders why the jump feels dead there.
 */
const ROLLERS: Roller[] = [
  { z: 120, x: 0, radiusX: 26, radiusZ: 16, height: 2.2 }, // -0.034
  { z: 210, x: -34, radiusX: 20, radiusZ: 12, height: 3.1 }, // -0.086, snappy
  { z: 300, x: 18, radiusX: 30, radiusZ: 14, height: 2.4 }, // -0.049
  { z: 395, x: 0, radiusX: 44, radiusZ: 22, height: 4.0 }, // -0.033
  { z: 500, x: 40, radiusX: 24, radiusZ: 14, height: 2.6 }, // -0.053
  { z: 585, x: -22, radiusX: 34, radiusZ: 17, height: 2.8 }, // -0.039
  { z: 700, x: 6, radiusX: 52, radiusZ: 30, height: 5.2 }, // -0.023, big mellow booter
  { z: 820, x: -46, radiusX: 22, radiusZ: 13, height: 2.9 }, // -0.069
  { z: 905, x: 24, radiusX: 28, radiusZ: 18, height: 2.3 }, // -0.028
  { z: 1010, x: 0, radiusX: 40, radiusZ: 24, height: 3.4 }, // -0.024
];

/** Grade profile down the hill: [metres along Z, grade as dy/dz]. */
const GRADE: { z: number; grade: number }[] = [
  { z: 0, grade: 0.5 }, // drop-in
  { z: 70, grade: 0.22 },
  { z: 260, grade: 0.19 },
  { z: 430, grade: 0.34 }, // steeper: the "gas" section
  { z: 560, grade: 0.2 },
  { z: 760, grade: 0.42 }, // chute
  { z: 880, grade: 0.21 },
  { z: 1080, grade: 0.11 }, // runout, never flat enough to stall
  { z: 1200, grade: 0.1 },
];

export interface TestSlopeOptions {
  lengthMetres?: number;
  widthMetres?: number;
  spacing?: number;
  seed?: number;
  /** Half-width of the groomed corridor in metres. */
  corridorHalfWidth?: number;
  /**
   * Half-width of the *in-bounds* area in metres, defaulting to 1.35x the groomed
   * corridor.
   *
   * Grooming and bounds are deliberately different numbers. The cross profile makes
   * the shoulders genuinely ridable -- drifting wide is supposed to cost speed rather
   * than end the run -- so treating the groomed edge as the boundary would penalise a
   * line the terrain invites. Bounds sit out where the shoulder stops being a choice.
   */
  boundsHalfWidth?: number;
}

export interface TestSlope {
  field: Heightfield;
  /** Suggested spawn, on the centreline just below the top edge. */
  startX: number;
  startZ: number;
  /** Heading in radians: 0 = +X, so +Z (downhill) is PI/2. */
  startYaw: number;
  /** Finish line as two world-space endpoints, spanning the in-bounds width. */
  finish: [Vec2, Vec2];
}

function gradeAt(z: number): number {
  if (z <= GRADE[0].z) return GRADE[0].grade;
  for (let i = 1; i < GRADE.length; i++) {
    const a = GRADE[i - 1];
    const b = GRADE[i];
    if (z <= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      // Smoothstep between control grades so there are no slope discontinuities,
      // which would read as an invisible bump the physics reacts to.
      const s = t * t * (3 - 2 * t);
      return a.grade + (b.grade - a.grade) * s;
    }
  }
  return GRADE[GRADE.length - 1].grade;
}

export function buildTestSlope(options: TestSlopeOptions = {}): TestSlope {
  const spacing = options.spacing ?? 1;
  const lengthMetres = options.lengthMetres ?? 1200;
  const widthMetres = options.widthMetres ?? 400;
  const seed = options.seed ?? 0x5eed1a;
  const corridorHalfWidth = options.corridorHalfWidth ?? 90;
  const boundsHalfWidth = options.boundsHalfWidth ?? corridorHalfWidth * 1.35;

  const cols = Math.round(widthMetres / spacing) + 1;
  const rows = Math.round(lengthMetres / spacing) + 1;
  const count = cols * rows;

  const heights = new Float32Array(count);
  const surfaces = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const featureMask = new Float32Array(count);

  // Centre the field on X, start at Z = 0.
  const originX = -widthMetres / 2;
  const originZ = 0;

  // Integrate the grade profile once to get the centreline elevation, rather than
  // authoring absolute heights. Editing a grade then leaves everything downhill
  // of it consistent automatically.
  const centreY = new Float64Array(rows);
  let y = lengthMetres * 0.28; // arbitrary summit height; only relative matters
  centreY[0] = y;
  for (let j = 1; j < rows; j++) {
    const z = j * spacing;
    y -= gradeAt(z - spacing * 0.5) * spacing;
    centreY[j] = y;
  }

  for (let j = 0; j < rows; j++) {
    const z = originZ + j * spacing;
    const base = centreY[j];

    for (let i = 0; i < cols; i++) {
      const x = originX + i * spacing;
      const idx = j * cols + i;

      // --- Cross profile: a wide shallow valley with high but ridable shoulders.
      // Quadratic in the middle so the racing line is genuinely flat-ish, then
      // rising hard past the corridor to contain the player with geometry rather
      // than an invisible wall.
      const ax = Math.abs(x);
      const inner = clamp01(ax / corridorHalfWidth);
      let h = base + inner * inner * 7.5;

      // Shoulders climb to turn back a wandering rider. Deliberately kept around
      // 40-45 degrees rather than steeper: a near-vertical wall stops being terrain
      // the player reads and becomes an invisible boundary wearing a texture, which
      // is exactly what the freedom-of-line pillar rules out. At this grade the
      // lower shoulder is still ridable, so drifting wide costs speed instead of
      // ending the run.
      const beyond = Math.max(0, ax - corridorHalfWidth);
      h += beyond * beyond * 0.004 + beyond * 0.12;

      // --- Feature stamps. Each writes its falloff into featureMask so the noise
      // below leaves it alone.
      let mask = 0;
      for (let r = 0; r < ROLLERS.length; r++) {
        const roller = ROLLERS[r];
        const dx = (x - roller.x) / roller.radiusX;
        const dz = (z - roller.z) / roller.radiusZ;
        const t = Math.sqrt(dx * dx + dz * dz);
        const b = bump(t);
        if (b > 0) {
          h += roller.height * b;
          if (b > mask) mask = b;
        }
      }
      featureMask[idx] = mask;

      heights[idx] = h;
    }
  }

  // --- Masked detail noise.
  //
  // Three bands, each with a distinct job, because a single "detail noise" term
  // cannot serve all three at once.
  //
  //  - ROLLING is the important one and the corridor's whole character. Ten
  //    authored rollers over 1200 m is one feature every five seconds at speed --
  //    far too sparse to feel like a snowboarding run -- so this band is what makes
  //    the terrain *continuously* poppable, and the authored rollers become the big
  //    set pieces on top of it.
  //
  //    The parameters were measured, not guessed, and the two numbers in tension
  //    are crest spacing and rideability. Raising amplitude barely helps spacing:
  //    going 1.05 -> 1.6 m at a 30 m scale moved the median crest gap only 170 ->
  //    94 m, because value noise only has a local maximum along a given line about
  //    every other lattice cell. Wavelength is the lever. At scale 22 / amp 1.15
  //    the median gap is 22 m -- a pop opportunity a bit under once a second at
  //    25 m/s -- while the fall-line grade stays at a 23% median with only 0.7% of
  //    the corridor running uphill. Pushing amplitude further buys chatter and
  //    uphill ripples, not better spacing. `terrainGeneration.test.ts` pins both
  //    ends of that trade.
  //
  //  - BROAD is large-scale terrain shape, kept mostly off-piste so it does not
  //    fight the authored grade profile.
  //
  //  - FINE is surface texture, so the snow does not read as a CAD model. Below the
  //    scale the physics cares about.
  //
  // All three fade inside authored features, so a designed lip never drowns in
  // noise. ROLLING keeps a high floor in the corridor; BROAD does not.
  for (let j = 0; j < rows; j++) {
    const z = originZ + j * spacing;
    for (let i = 0; i < cols; i++) {
      const x = originX + i * spacing;
      const idx = j * cols + i;

      const ax = Math.abs(x);
      const featureFade = 1 - clamp01(featureMask[idx]);
      const offPiste = smoothstep(corridorHalfWidth * 0.35, corridorHalfWidth * 1.4, ax);

      const rolling = fbm2s(x, z, { scale: 22, octaves: 2, gain: 0.5, lacunarity: 2, seed });
      const broad = fbm2s(x, z, {
        scale: 95,
        octaves: 2,
        gain: 0.5,
        lacunarity: 2,
        seed: seed ^ 0x77,
      });
      const fine = fbm2s(x, z, {
        scale: 9,
        octaves: 2,
        gain: 0.5,
        lacunarity: 2,
        seed: seed ^ 0x1234,
      });

      heights[idx] +=
        featureFade *
        (rolling * 1.15 * (0.9 + 0.3 * offPiste) +
          broad * 2.6 * (0.15 + 0.85 * offPiste) +
          fine * 0.22 * (0.5 + 0.5 * offPiste));
    }
  }

  // --- Constrained smoothing. Weighted by (1 - featureMask) so stamp interiors
  // keep their authored shape while the noisy shoulders lose their harshest
  // single-post spikes.
  smoothConstrained(heights, featureMask, cols, rows, 2);

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

  assignSurfaces(field, corridorHalfWidth, boundsHalfWidth, seed);

  // The finish sits short of the far edge, so there is runout to coast through rather
  // than a wall to stop against -- and so the progress flood has passable cells on
  // both sides of the line.
  const finishZ = lengthMetres - 30;

  // Surface bytes changed after construction; nothing derived from them is cached,
  // but normals are, so leave them alone. (assignSurfaces does not touch heights.)
  return {
    field,
    startX: 0,
    startZ: 6,
    startYaw: Math.PI / 2,
    finish: [
      { x: -boundsHalfWidth, z: finishZ },
      { x: boundsHalfWidth, z: finishZ },
    ],
  };
}

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
 * Rule-based rather than painted: it costs nothing, it stays correct when the
 * heights change, and it means the corridor is always groomed no matter how the
 * grade profile is edited.
 */
function assignSurfaces(
  field: Heightfield,
  corridorHalfWidth: number,
  boundsHalfWidth: number,
  seed: number,
): void {
  const { cols, rows, spacing, originX, originZ, surfaces, flagBytes, normals } = field;

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
      if (ny < 0.5) {
        // Past ~60 degrees snow does not hold. Keeping the threshold this high
        // means only genuinely unridable faces read as rock -- at a lower
        // threshold the whole containment shoulder turns to stone, which both
        // looks wrong and lies to the player about where they can go.
        surface = SurfaceId.Rock;
      } else if (inCorridor) {
        // Occasional scoured ice patches on the fast line, so the groomed route
        // is not a free ride. Kept sparse: frequent large patches stop reading as
        // a hazard to avoid and start reading as the surface.
        const icy = fbm2s(x, z, {
          scale: 26,
          octaves: 2,
          gain: 0.5,
          lacunarity: 2,
          seed: seed ^ 0x99,
        });
        surface = icy > 0.74 ? SurfaceId.Ice : SurfaceId.Groomed;
      } else if (ax < corridorHalfWidth * 1.35) {
        surface = SurfaceId.Packed;
      } else {
        surface = SurfaceId.Powder;
      }

      surfaces[idx] = surface;

      let f = 0;
      if (inBounds) f |= TerrainFlag.InCorridor;
      if (ny < 0.45) f |= TerrainFlag.Cliff;
      flagBytes[idx] = f;
    }
  }
}
