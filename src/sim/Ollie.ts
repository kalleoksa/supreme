import { clamp01, lerp } from '../core/math.js';
import type { InputState } from '../input/InputState.js';
import { TrickState, type BoardState } from './BoardState.js';
import type { BoardTuning } from './boardTuning.js';
import { SimEventKind, type EventBuffer } from './events.js';
import { TerrainFlag, type TerrainSampler } from './Terrain.js';

/**
 * The charged ollie.
 *
 * This is the mechanic the whole game is built around, and it is worth being precise
 * about why it is good. Charge is the safe route: hold the button, lose a little speed
 * crouching, get a predictable pop. Timing is the fast route: release exactly as the
 * board crosses a crest and the terrain does the work for you, so a zero-charge
 * release at a perfect lip pops as hard as a full standing charge.
 *
 * That single trade -- `popPower = charge + LIP_WEIGHT * lipQuality`, both clamped
 * into the same 0..1 budget -- is the entire risk/reward primitive. A player who
 * cannot read terrain still gets air by charging early. A player who can gets the
 * same air without paying the speed, and gets it *while still steering*, because they
 * never crouched.
 *
 * Pure, like everything in `sim/`: no wall clock, no RNG, no renderer.
 */

export interface OllieResult {
  /** Speed to add along the launch axis, in m/s. Zero when nothing popped. */
  pop: number;
  /** Launch axis, blended between world up and the surface normal. */
  upX: number;
  upY: number;
  upZ: number;
}

const result: OllieResult = { pop: 0, upX: 0, upY: 1, upZ: 0 };

/**
 * How good a launch lip the board is currently crossing, 0..1.
 *
 * Uses the *spatial* second derivative of height along the direction of travel rather
 * than differencing terrain height across ticks. That matters: a tick-difference
 * measure changes with frame rate, so the timing window a player learns at 144 Hz
 * would not be the window they get on a throttled phone. This version is stateless
 * and identical at any frame rate.
 */
export function lipQualityAt(
  state: BoardState,
  terrain: TerrainSampler,
  tuning: BoardTuning,
): number {
  const speed = Math.hypot(state.vel.x, state.vel.z);
  if (speed < 1e-3) return 0;
  const convexity = terrain.convexity(
    state.pos.x,
    state.pos.z,
    state.vel.x / speed,
    state.vel.z / speed,
  );
  // Negative convexity is a crest. Anything concave is a compression, not a lip.
  const quality = clamp01(-convexity / tuning.LIP_REF);
  // Normalize -0 to 0. Negating a zero convexity yields -0, which compares unequal to
  // 0 under Object.is and would leak a signed zero into event payloads and snapshots.
  return quality === 0 ? 0 : quality;
}

/**
 * Advance the charge state machine and resolve a pop if one is due.
 *
 * Called from `stepBoard` before the force integration, so a pop lands in the same
 * step the button was released -- the release is the whole mechanic, and deferring it
 * a step would add latency exactly where precision is being asked for.
 */
export function resolveOllie(
  state: BoardState,
  input: InputState,
  terrain: TerrainSampler,
  dt: number,
  tuning: BoardTuning,
  events: EventBuffer,
): OllieResult {
  result.pop = 0;
  result.upX = 0;
  result.upY = 1;
  result.upZ = 0;

  // Crashed riders do not pop; recovery is on a timer.
  if (state.crashTimer > 0) {
    state.jumpCharge = 0;
    return result;
  }

  if (!state.grounded) {
    // Left the ground without releasing -- terrain launched us. The stored charge is
    // gone rather than banked: charge is payment for a pop, and holding it through a
    // genuine air should not buy free height on landing.
    //
    // But only past the grace window. Skimming over a ripple must not count: the test
    // slope offers a crest every ~22 m by design, so at 120 km/h the board goes briefly
    // light several times a second, and discarding on every one of those made holding
    // the button do nothing at all.
    if (state.trickState === TrickState.Charging && state.airTime > tuning.CHARGE_AIR_GRACE) {
      state.trickState = TrickState.Air;
      state.jumpCharge = 0;
    }
    return result;
  }

  // --- Begin, or resume, charging.
  //
  // Held-and-grounded is the condition, not the press edge alone. The press edge by
  // itself has a nasty failure: hold the button, get bounced into the air by a roller
  // (which correctly discards the charge), land still holding -- and no new press edge
  // ever arrives, so the button is dead until the player lets go and presses again.
  // On rolling terrain at speed that happens constantly, and it reads as the jump
  // randomly not working.
  //
  // Holding the button means "I want to charge", so honour that whenever the board is
  // back on the ground.
  if (input.jump.held && state.trickState !== TrickState.Charging) {
    state.trickState = TrickState.Charging;
    state.jumpCharge = 0;
  }

  // --- Accumulate. The speed and steering costs live in Board.stepGrounded, keyed off
  // this same state, so crouching is visibly slow rather than free.
  if (state.trickState === TrickState.Charging && input.jump.held) {
    state.jumpCharge = clamp01(state.jumpCharge + dt / tuning.CHARGE_TIME);
  }

  // --- Release: pop.
  if (state.trickState === TrickState.Charging && input.jump.released) {
    const quality = lipQualityAt(state, terrain, tuning);

    // Some terrain refuses a pop -- a graded landing zone, for instance, where
    // launching again would skip the feature the player just landed in.
    if ((state.ground.flags & TerrainFlag.NoJump) !== 0) {
      state.trickState = TrickState.Idle;
      state.jumpCharge = 0;
      events.push(SimEventKind.Pop, state.tick, 0, quality, 0);
      return result;
    }

    // The formula. Charge and lip quality are interchangeable currencies in one 0..1
    // budget, so at LIP_WEIGHT = 1 a perfectly-timed release with no charge is worth
    // exactly as much as a full charge on flat ground.
    const charge = state.jumpCharge;
    const popPower = clamp01(charge + tuning.LIP_WEIGHT * quality);
    const pop = lerp(tuning.MIN_POP, tuning.MAX_POP, popPower);

    // Launch partly along the surface normal rather than straight up. This is what
    // makes banks and walls throw the rider *laterally*, so a wide mountain produces
    // interesting airs instead of merely tall ones.
    let ux = state.ground.nx * tuning.POP_NORMAL_BIAS;
    let uy = lerp(1, state.ground.ny, tuning.POP_NORMAL_BIAS);
    let uz = state.ground.nz * tuning.POP_NORMAL_BIAS;
    const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (len > 1e-6) {
      ux /= len;
      uy /= len;
      uz /= len;
    } else {
      ux = 0;
      uy = 1;
      uz = 0;
    }

    result.pop = pop;
    result.upX = ux;
    result.upY = uy;
    result.upZ = uz;

    state.trickState = TrickState.Air;
    state.launchSpeed = Math.hypot(state.vel.x, state.vel.z);
    state.launchNormal.x = state.ground.nx;
    state.launchNormal.y = state.ground.ny;
    state.launchNormal.z = state.ground.nz;
    state.jumpCharge = 0;

    // `a` is the pop, `b` the lip quality, `c` the charge that was spent. The HUD reads
    // b and c to tell the player *why* the pop was as big as it was -- which is the
    // only way the timing is ever learned.
    events.push(SimEventKind.Pop, state.tick, pop, quality, charge);
    return result;
  }

  // --- Released without ever charging, or charge abandoned.
  if (state.trickState === TrickState.Charging && !input.jump.held) {
    state.trickState = TrickState.Idle;
    state.jumpCharge = 0;
  }

  return result;
}

/**
 * Look ahead along the predicted path for the best lip to release on.
 *
 * Presentation, not simulation -- the HUD paints a band on the snow at the returned
 * distance. That assist is the direct fix for the loudest historical criticism of the
 * game this one descends from: the charge-and-release timing was good, but invisible,
 * so getting it right felt arbitrary. Putting the answer in world space, on the
 * terrain ahead, makes it a skill instead of a guess.
 *
 * Returns the distance in metres to the strongest crest within the horizon, or -1 if
 * there is nothing worth aiming at.
 */
export function findLipAhead(
  state: BoardState,
  terrain: TerrainSampler,
  tuning: BoardTuning,
  horizonSeconds = 1.2,
  samples = 24,
): { distance: number; quality: number } {
  const speed = Math.hypot(state.vel.x, state.vel.z);
  if (speed < 2) return { distance: -1, quality: 0 };

  const dx = state.vel.x / speed;
  const dz = state.vel.z / speed;
  const maxDistance = speed * horizonSeconds;

  let bestDistance = -1;
  let bestQuality = 0;

  for (let i = 1; i <= samples; i++) {
    const d = (maxDistance * i) / samples;
    const convexity = terrain.convexity(state.pos.x + dx * d, state.pos.z + dz * d, dx, dz);
    const quality = clamp01(-convexity / tuning.LIP_REF);
    if (quality > bestQuality) {
      bestQuality = quality;
      bestDistance = d;
    }
  }

  // Below a third of a full-quality lip there is nothing worth pointing at, and a
  // marker that is always on screen teaches nothing.
  if (bestQuality < 0.33) return { distance: -1, quality: 0 };
  return { distance: bestDistance, quality: bestQuality };
}

/**
 * Time until the board next meets the surface, by stepping the ballistic arc.
 *
 * Feeds the air HUD's time-to-ground bar, which is what lets a player see whether a
 * rotation will finish before impact rather than discovering it on landing.
 */
export function timeToGround(
  state: BoardState,
  terrain: TerrainSampler,
  gravity: number,
  maxSeconds = 4,
  step = 1 / 30,
): number {
  if (state.grounded) return 0;

  let x = state.pos.x;
  let y = state.pos.y;
  let z = state.pos.z;
  let vy = state.vel.y;

  for (let t = 0; t < maxSeconds; t += step) {
    vy -= gravity * step;
    x += state.vel.x * step;
    y += vy * step;
    z += state.vel.z * step;
    if (y <= terrain.height(x, z)) return t + step;
  }
  return maxSeconds;
}
