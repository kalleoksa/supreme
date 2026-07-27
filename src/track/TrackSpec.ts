import type { SurfaceId } from '../sim/Terrain.js';

/**
 * The authoring format for a track.
 *
 * A track is data, and the heightfield is compiled from it by a pure function in
 * `generate.ts`. That split buys three things:
 *
 *  - **Iteration costs nothing.** The generator is called from a module Vite already hot
 *    reloads, so editing a track re-bakes the terrain in the browser. The loop that
 *    decides whether a track is fun needs no build step and no baker script.
 *  - **The whole thing is testable in Node.** A validator can walk the grade profile and
 *    flag a section that would stall a rider before anybody rides it.
 *  - **It is the future editor's data model.** Not because an editor is planned for M1,
 *    but because a format that only a hand-written TS file can produce is a format an
 *    editor would have to replace rather than target.
 *
 * ## Why TypeScript and not JSON
 *
 * A spec is a typechecked module, so a mistyped field name is a compile error and every
 * number can carry its unit in a doc comment. JSON would need a schema validator
 * (`zod` was considered and rejected) to get back what `strict` gives for free. When a
 * mod or editor path needs JSON, the types here are what it will validate against.
 *
 * ## The composition order is the format
 *
 * Layers apply in a fixed order, and the order is the thing that makes an authored
 * mountain rather than noise mush:
 *
 *   1. `grade` -- integrate a grade profile into a centreline elevation.
 *   2. `cross` -- sweep a cross-section along it: a ridable corridor, then shoulders.
 *   3. `stamps` -- analytic features, each writing its falloff into a feature mask.
 *   4. `noise` -- detail bands *multiplied by* `1 - featureMask`.
 *   5. `smoothing` -- weighted by `1 - featureMask` so stamp interiors survive.
 *   6. `surfaces` -- materials and flags from slope, position and noise.
 *
 * Step 4 is the one that matters. Detail noise suppressed inside authored features and
 * amplified out on the wild shoulders is the difference between a mountain a player can
 * read and a field of bumps that drowns every deliberately-placed lip.
 */

/** A control point on the descent: grade as dy/dz at a distance along the course. */
export interface GradePoint {
  /** Metres along +Z from the top of the field. */
  z: number;
  /** Fall as a fraction of run. 0.2 is a 20% grade; 0.5 is a steep drop-in. */
  grade: number;
}

export interface GradeProfile {
  /**
   * Elevation of the centreline at z = 0, in metres.
   *
   * Only relative height matters to anything; this exists so a track's numbers are
   * plausible rather than starting at zero and going negative.
   */
  summit: number;
  /**
   * Control grades, ascending in `z`. Smoothstepped between, never linearly: a slope
   * discontinuity is an invisible bump the physics reacts to and the player cannot see.
   */
  points: readonly GradePoint[];
}

/**
 * The swept cross-section.
 *
 * Containment is geometry, never an invisible wall -- that is what the freedom-of-line
 * pillar rules out. The corridor is close to flat so the racing line is genuinely fast,
 * then the shoulders climb to turn back a wandering rider while staying ridable enough
 * that drifting wide costs speed instead of ending a run.
 */
export interface CrossSection {
  /** Half-width of the groomed corridor, in metres. */
  corridorHalfWidth: number;
  /**
   * Half-width of the in-bounds area, in metres.
   *
   * Deliberately larger than the groomed corridor. The shoulders are ridable on purpose,
   * so treating the groomed edge as the boundary would penalise a line the terrain
   * invites.
   */
  boundsHalfWidth: number;
  /** Metres the corridor rises from centre to its edge, quadratically. */
  corridorRise: number;
  /** Quadratic term of the shoulder climb past the corridor, in metres per metre squared. */
  shoulderQuadratic: number;
  /** Linear term of the shoulder climb past the corridor, dimensionless. */
  shoulderLinear: number;
}

export const enum StampKind {
  /**
   * A smooth elliptical mound. `(1 - t^2)^2` in normalized radius, so both the height and
   * the slope reach zero at the boundary -- a stamp with a slope discontinuity at its
   * edge is a feature the board pops off invisibly.
   */
  Bump = 0,
}

/**
 * One analytic terrain feature.
 *
 * Rollers are the supply of crests the charged ollie pays out on. A roller's usefulness as
 * a launch is set by its along-slope curvature, about `-4 * height / radiusZ^2` at the
 * crest for the bump profile, so a broad low mound is scenery and a tight tall one is a
 * pop. `validate.ts` reports that number per stamp.
 */
export interface Stamp {
  kind: StampKind;
  /** Metres along +Z. */
  z: number;
  /** Metres from the centreline; positive is +X. */
  x: number;
  radiusX: number;
  radiusZ: number;
  /** Peak height added at the centre, in metres. */
  height: number;
  /** Optional label, for validator output and future editor display. */
  label?: string;
}

/**
 * A band of detail noise.
 *
 * Every band is multiplied by `1 - featureMask`, so all of them fade inside authored
 * features. `offPisteBias` is what lets one band stay strong on the racing line while
 * another is pushed out to the shoulders.
 */
export interface NoiseBand {
  /** World metres per unit of the first octave. This is the lever on crest spacing. */
  scale: number;
  octaves: number;
  gain: number;
  lacunarity: number;
  /** XORed into the track seed, so bands stay independent but the track stays seeded. */
  seedOffset: number;
  /** Peak amplitude in metres. */
  amplitude: number;
  /**
   * Weight on the corridor and weight off-piste, blended by distance from the centreline.
   * `[0.9, 1.2]` is a band that is everywhere; `[0.15, 1.0]` is one that stays wild.
   */
  offPisteBias: readonly [onPiste: number, offPiste: number];
  label?: string;
}

/** Rule-based material assignment. Cheap, and it stays correct when the heights change. */
export interface SurfaceRules {
  /**
   * Below this normal Y, snow does not hold and the surface becomes `rock`.
   *
   * Kept high on purpose (about 60 degrees). At a lower threshold the whole containment
   * shoulder turns to stone, which both looks wrong and lies to the player about where
   * they are allowed to go.
   */
  rockNormalY: number;
  /** Surface on faces too steep to hold snow. */
  rock: SurfaceId;
  /** Below this normal Y, terrain is flagged unridable. */
  cliffNormalY: number;
  /** Surface on the groomed corridor. */
  corridor: SurfaceId;
  /** Surface on the shoulders, out to `boundsHalfWidth * shoulderSurfaceExtent`. */
  shoulder: SurfaceId;
  /** Surface beyond that. */
  outer: SurfaceId;
  /** Multiple of `corridorHalfWidth` the shoulder surface extends to. */
  shoulderSurfaceExtent: number;
  /**
   * Scoured ice on the fast line: a noise band, and the threshold above which it bites.
   *
   * Kept sparse deliberately. Frequent large patches stop reading as a hazard to avoid
   * and start reading as the surface.
   */
  ice?: {
    scale: number;
    octaves: number;
    gain: number;
    lacunarity: number;
    seedOffset: number;
    threshold: number;
    surface: SurfaceId;
  };
}

export interface TrackSpec {
  /** Stable identifier. Keys the stored best time, so changing it retires old times. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Integer seed for every noise band on this track. */
  seed: number;

  lengthMetres: number;
  widthMetres: number;
  /** Metres between posts. 1 m for M1: a 4 m kicker lip needs more than two cells to read. */
  spacing: number;

  grade: GradeProfile;
  cross: CrossSection;
  stamps: readonly Stamp[];
  noise: readonly NoiseBand[];
  /**
   * Distances from the centreline, as multiples of `corridorHalfWidth`, over which the
   * off-piste weight ramps from 0 to 1. Smoothstepped between.
   */
  offPisteRamp: readonly [start: number, end: number];
  /** Constrained smoothing passes. 2-4; weighted by `1 - featureMask`. */
  smoothingPasses: number;
  surfaces: SurfaceRules;

  /** Spawn on the centreline just below the top edge. */
  start: { x: number; z: number; yaw: number };
  /** Metres short of the far edge the finish line sits, so there is runout past it. */
  finishInset: number;
}
