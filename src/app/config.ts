/**
 * Global constants and feature flags.
 *
 * TITLE is the one place the product name lives. The working codename is
 * "whiteout"; the shipping title is undecided. Do not scatter it.
 */
export const TITLE = 'Whiteout';

/**
 * Simulation timestep. 120 Hz, not 60.
 *
 * The charged ollie's entire point is timing a button release against a terrain
 * crest, so the resolution of that release matters: 8.3 ms beats 16.7 ms on the
 * one mechanic the game is built around. At a single simulated body the extra
 * steps cost effectively nothing.
 */
export const FIXED_DT = 1 / 120;

/**
 * Substep ceiling per frame. Past this the sim runs in slow motion rather than
 * trying to catch up (which would explode). At an iOS-throttled 30 fps we need
 * exactly 4 substeps, so 8 leaves real headroom before anything degrades.
 */
export const MAX_STEPS = 8;

/** Frame delta is clamped to this. Protects against tab-switch time jumps. */
export const MAX_FRAME_DT = 0.25;

/**
 * Device pixel ratio ceiling. On a DPR-3 phone, rendering native costs ~4x the
 * fill rate of 1.5 for a difference nobody can see at speed. Adopted from the
 * first commit because it is free now and a retrofit later.
 */
export const MAX_PIXEL_RATIO = 1.5;

/** Fog / far-plane distance in metres. Also the terrain LOD budget driver. */
export const VIEW_DISTANCE = 900;

/**
 * Identifier of the track being ridden, used to key the stored best time.
 *
 * Still the Phase 1-5 tuning slope, and named as such rather than as track one: when
 * the authored track arrives it gets its own id, and times set on the test slope should
 * not be presented as times on it.
 */
export const TRACK_ID = 'testslope';
