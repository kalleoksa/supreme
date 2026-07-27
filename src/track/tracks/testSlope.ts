import { SurfaceId } from '../../sim/Terrain.js';
import { StampKind, type Stamp, type TrackSpec } from '../TrackSpec.js';

/**
 * The tuning slope, as a spec.
 *
 * This is scaffolding for tuning the ride, not content -- the authored track is a separate
 * spec and comes after the feel gate. It is here in spec form for two reasons: it proves
 * the format can express a track that already worked (the generator reproduces the
 * hand-written version's golden height hash exactly), and it means the tuning slope gets
 * every generator improvement for free instead of drifting away from the real path.
 *
 * Every number below was measured rather than guessed, and the measurements are recorded
 * where they belong -- next to the value they justify.
 */

/**
 * Rollers are the whole point of the tuning slope.
 *
 * The charged ollie rewards releasing at a crest, so tuning it needs a supply of crests at
 * varied sizes and spacings, some on the racing line and some off it. A roller's usefulness
 * as a launch is its along-slope crest curvature (`-4 * height / radiusZ^2`, reported by
 * `validate.ts`): a broad low mound is scenery and a tight tall one is a pop. Every entry
 * is kept past ~0.02 1/m so it actually registers, which `terrainGeneration.test.ts`
 * asserts -- that is how a mellowed-out roller gets caught before anyone wonders why the
 * jump feels dead there.
 */
const roller = (r: Omit<Stamp, 'kind'>): Stamp => ({ kind: StampKind.Bump, ...r });

const ROLLERS: Stamp[] = [
  roller({ z: 120, x: 0, radiusX: 26, radiusZ: 16, height: 2.2 }), // -0.034
  roller({ z: 210, x: -34, radiusX: 20, radiusZ: 12, height: 3.1 }), // -0.086, snappy
  roller({ z: 300, x: 18, radiusX: 30, radiusZ: 14, height: 2.4 }), // -0.049
  roller({ z: 395, x: 0, radiusX: 44, radiusZ: 22, height: 4.0 }), // -0.033
  roller({ z: 500, x: 40, radiusX: 24, radiusZ: 14, height: 2.6 }), // -0.053
  roller({ z: 585, x: -22, radiusX: 34, radiusZ: 17, height: 2.8 }), // -0.039
  roller({ z: 700, x: 6, radiusX: 52, radiusZ: 30, height: 5.2 }), // -0.023, big mellow booter
  roller({ z: 820, x: -46, radiusX: 22, radiusZ: 13, height: 2.9 }), // -0.069
  roller({ z: 905, x: 24, radiusX: 28, radiusZ: 18, height: 2.3 }), // -0.028
  roller({ z: 1010, x: 0, radiusX: 40, radiusZ: 24, height: 3.4 }), // -0.024
];

export const TEST_SLOPE: TrackSpec = {
  id: 'testslope',
  name: 'Tuning Slope',
  seed: 0x5eed1a,

  lengthMetres: 1200,
  widthMetres: 400,
  spacing: 1,

  grade: {
    // Arbitrary summit: only relative height matters anywhere.
    summit: 1200 * 0.28,
    points: [
      { z: 0, grade: 0.5 }, // drop-in
      { z: 70, grade: 0.22 },
      { z: 260, grade: 0.19 },
      { z: 430, grade: 0.34 }, // steeper: the "gas" section
      { z: 560, grade: 0.2 },
      { z: 760, grade: 0.42 }, // chute
      { z: 880, grade: 0.21 },
      { z: 1080, grade: 0.11 }, // runout, never flat enough to stall
      { z: 1200, grade: 0.1 },
    ],
  },

  cross: {
    corridorHalfWidth: 90,
    // 1.35x the groomed corridor. The shoulders are ridable on purpose, so drifting wide
    // costs speed rather than ending the run, and the boundary sits out where the shoulder
    // stops being a choice.
    boundsHalfWidth: 90 * 1.35,
    // A wide shallow valley: quadratic through the middle so the racing line is genuinely
    // flat-ish, then rising hard past the corridor.
    corridorRise: 7.5,
    // Shoulders around 40-45 degrees rather than steeper. A near-vertical wall stops being
    // terrain the player reads and becomes an invisible boundary wearing a texture, which
    // is exactly what the freedom-of-line pillar rules out.
    shoulderQuadratic: 0.004,
    shoulderLinear: 0.12,
  },

  stamps: ROLLERS,

  // Three bands, each with a distinct job, because a single "detail noise" term cannot
  // serve all three at once.
  noise: [
    {
      // ROLLING is the important one and the corridor's whole character. Ten authored
      // rollers over 1200 m is one feature every five seconds at speed -- far too sparse to
      // feel like a snowboarding run -- so this band is what makes the terrain
      // *continuously* poppable, and the authored rollers become the set pieces on top.
      //
      // The parameters were measured, and the two numbers in tension are crest spacing and
      // rideability. Amplitude barely moves spacing: 1.05 -> 1.6 m at a 30 m scale shifted
      // the median crest gap only 170 -> 94 m, because value noise only has a local maximum
      // along a given line about every other lattice cell. Wavelength is the lever. At
      // scale 22 / amp 1.15 the median gap is 22 m -- a pop opportunity a bit under once a
      // second at 25 m/s -- while the fall-line grade stays at a 23% median with only 0.7%
      // of the corridor running uphill. Pushing amplitude further buys chatter and uphill
      // ripples, not better spacing.
      label: 'rolling',
      scale: 22,
      octaves: 2,
      gain: 0.5,
      lacunarity: 2,
      seedOffset: 0,
      amplitude: 1.15,
      offPisteBias: [0.9, 1.2],
    },
    {
      // BROAD is large-scale terrain shape, kept mostly off-piste so it does not fight the
      // authored grade profile.
      label: 'broad',
      scale: 95,
      octaves: 2,
      gain: 0.5,
      lacunarity: 2,
      seedOffset: 0x77,
      amplitude: 2.6,
      offPisteBias: [0.15, 1.0],
    },
    {
      // FINE is surface texture, so the snow does not read as a CAD model. Below the scale
      // the physics cares about.
      label: 'fine',
      scale: 9,
      octaves: 2,
      gain: 0.5,
      lacunarity: 2,
      seedOffset: 0x1234,
      amplitude: 0.22,
      offPisteBias: [0.5, 1.0],
    },
  ],

  offPisteRamp: [0.35, 1.4],
  smoothingPasses: 2,

  surfaces: {
    rockNormalY: 0.5,
    rock: SurfaceId.Rock,
    cliffNormalY: 0.45,
    corridor: SurfaceId.Groomed,
    shoulder: SurfaceId.Packed,
    outer: SurfaceId.Powder,
    shoulderSurfaceExtent: 1.35,
    ice: {
      scale: 26,
      octaves: 2,
      gain: 0.5,
      lacunarity: 2,
      seedOffset: 0x99,
      threshold: 0.74,
      surface: SurfaceId.Ice,
    },
  },

  /**
   * Two species of conifer.
   *
   * The corridor density scale is 0.12 rather than 0, and that is the number worth not
   * "tidying up": trees inside the ridable area are what turn a 240 m wide face into a set
   * of real route choices. A cleared racing line would make freedom of line mean only that
   * the corridor is wide. They are excluded around the authored rollers, because a tree in a
   * landing zone punishes the player for doing exactly what the terrain invited.
   */
  scatter: {
    launchClearance: 1.6,
    species: [
      {
        id: 'spruce',
        densityPerHectare: 55,
        surfaces: [SurfaceId.Powder, SurfaceId.Packed, SurfaceId.Groomed],
        minNormalY: 0.72,
        radius: 0.55,
        height: 9,
        heightVariance: 2.5,
        seedOffset: 0x2a11,
        corridorDensityScale: 0.12,
      },
      {
        id: 'sapling',
        densityPerHectare: 90,
        surfaces: [SurfaceId.Powder, SurfaceId.Packed],
        minNormalY: 0.62,
        radius: 0.28,
        height: 3.4,
        heightVariance: 1.1,
        seedOffset: 0x7b3d,
        corridorDensityScale: 0.05,
      },
    ],
  },

  // Yaw PI/2 faces +Z, which is downhill.
  start: { x: 0, z: 6, yaw: Math.PI / 2 },
  finishInset: 30,
};
