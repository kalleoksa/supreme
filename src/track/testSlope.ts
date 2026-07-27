import type { Vec2 } from '../core/vec3.js';
import type { Heightfield } from '../sim/Heightfield.js';
import type { Obstacles } from '../sim/Obstacles.js';
import { generateTrack, type GeneratedTrack } from './generate.js';
import { TEST_SLOPE } from './tracks/testSlope.js';

/**
 * Builds the tuning slope.
 *
 * The terrain itself now lives in `tracks/testSlope.ts` as a `TrackSpec`, compiled by
 * `generate.ts`. This file is the small adapter that survived the move, and it stays
 * because a great deal of the test suite and the diagnostic tooling calls
 * `buildTestSlope()`; keeping the entry point means the port was verifiable against the
 * golden height hash instead of against a rewritten set of expectations.
 *
 * New code should prefer `generateTrack(spec)` directly -- it returns the launch features
 * and the feature mask as well.
 */

export interface TestSlope {
  field: Heightfield;
  /** Static obstacles, for the physics step context. */
  obstacles: Obstacles;
  /** Suggested spawn, on the centreline just below the top edge. */
  startX: number;
  startZ: number;
  /** Heading in radians: 0 = +X, so +Z (downhill) is PI/2. */
  startYaw: number;
  /** Finish line as two world-space endpoints, spanning the in-bounds width. */
  finish: [Vec2, Vec2];
}

export function buildTestSlope(): TestSlope {
  return generateTrack(TEST_SLOPE);
}

/** The full generator output, for callers that want the launch features or the mask. */
export function buildTestSlopeTrack(): GeneratedTrack {
  return generateTrack(TEST_SLOPE);
}
