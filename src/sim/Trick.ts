import { clamp01 } from '../core/math.js';
import type { InputState } from '../input/InputState.js';
import { TrickState, type BoardState } from './BoardState.js';
import type { BoardTuning } from './boardTuning.js';
import { SimEventKind, type EventBuffer } from './events.js';

/**
 * The trick vocabulary. Deliberately small.
 *
 * Four tricks from one modifier button plus the steer axis. The depth is meant to come
 * from *combination and timing* -- which lip you popped from, how much air you have,
 * whether you can finish the rotation, whether you bail -- not from memorising a move
 * list. A large vocabulary would also work against the legibility this phase exists to
 * deliver: the player has to be able to read what they are doing mid-air.
 */
export const enum TrickId {
  None = 0,
  Spin = 1,
  NoseGrab = 2,
  Backflip = 3,
  GrabbedSpin = 4,
}

const TWO_PI = Math.PI * 2;

export interface TrickNames {
  readonly [id: number]: string;
}

export const TRICK_NAMES: TrickNames = {
  [TrickId.None]: '',
  [TrickId.Spin]: 'SPIN',
  [TrickId.NoseGrab]: 'NOSE GRAB',
  [TrickId.Backflip]: 'BACKFLIP',
  [TrickId.GrabbedSpin]: 'GRABBED SPIN',
};

/** Points a completed rotation or a full second of grab is worth, before multipliers. */
const BASE_SCORE: Record<number, number> = {
  [TrickId.None]: 0,
  [TrickId.Spin]: 220,
  [TrickId.NoseGrab]: 140,
  [TrickId.Backflip]: 340,
  [TrickId.GrabbedSpin]: 420,
};

/** Pick a trick from the latched steer direction at the moment the modifier engaged. */
export function trickFor(dirX: -1 | 0 | 1, dirY: -1 | 0 | 1): TrickId {
  if (dirX !== 0 && dirY !== 0) return TrickId.GrabbedSpin;
  if (dirX !== 0) return TrickId.Spin;
  if (dirY > 0) return TrickId.NoseGrab;
  if (dirY < 0) return TrickId.Backflip;
  // Modifier with the stick centred: a plain spin in the direction of travel.
  return TrickId.Spin;
}

/** Does this trick score by rotating, or by holding? */
export function isRotational(id: TrickId): boolean {
  return id === TrickId.Spin || id === TrickId.Backflip || id === TrickId.GrabbedSpin;
}

/**
 * Advance the trick state machine.
 *
 * Airborne only. Landing resolution lives in `Landing.ts`, which reads the state this
 * leaves behind -- in particular `trickRot` and `trickBroken`, which decide whether the
 * landing is clean or a crash.
 */
export function stepTrick(
  state: BoardState,
  input: InputState,
  dt: number,
  tuning: BoardTuning,
  events: EventBuffer,
): void {
  if (state.crashTimer > 0) return;

  // On the ground there is nothing to do but clear stale trick state.
  if (state.grounded) {
    if (state.trickState === TrickState.Tricking || state.trickState === TrickState.Breaking) {
      state.trickState = TrickState.Idle;
    }
    return;
  }

  switch (state.trickState) {
    case TrickState.Air:
    case TrickState.Idle: {
      if (input.trick.pressed) {
        state.trickId = trickFor(input.trickDirX, input.trickDirY);
        state.trickRot = 0;
        state.trickHoldTime = 0;
        state.trickBroken = false;
        state.trickState = TrickState.Tricking;
        events.push(SimEventKind.TrickStart, state.tick, state.trickId);
      }
      break;
    }

    case TrickState.Tricking: {
      // Tapping jump mid-air breaks out of the trick. This is the safety valve, and
      // showing what it costs is how risk/reward gets taught -- a silent bail teaches
      // nothing, so `Landing` reports the forfeited points.
      if (input.jump.pressed) {
        state.trickBroken = true;
        state.trickState = TrickState.Breaking;
        state.breakTimer = tuning.BREAK_TIME;
        events.push(SimEventKind.TrickBreak, state.tick, pendingScore(state, tuning), 0, 0);
        break;
      }

      // Releasing the modifier ends a grab but lets a rotation coast to completion --
      // you cannot stop a spin in mid-air, and pretending otherwise would make the
      // rotation feel weightless.
      if (isRotational(state.trickId)) {
        state.trickRot += rotationRate(state.trickId, tuning) * dt;
      } else if (input.trick.held) {
        state.trickHoldTime += dt;
      } else {
        state.trickState = TrickState.Air;
      }
      break;
    }

    case TrickState.Breaking: {
      // A brief window where the board rights itself before landing.
      state.breakTimer = Math.max(0, state.breakTimer - dt);
      // Unwind toward the nearest whole revolution so the break actually helps the
      // landing rather than merely stopping the spin.
      const target = Math.round(state.trickRot / TWO_PI) * TWO_PI;
      const rate = rotationRate(state.trickId, tuning) * 1.6;
      const delta = target - state.trickRot;
      const step = Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
      state.trickRot += step;
      if (state.breakTimer === 0) state.trickState = TrickState.Air;
      break;
    }

    default:
      break;
  }
}

function rotationRate(id: TrickId, tuning: BoardTuning): number {
  return id === TrickId.Backflip ? tuning.FLIP_RATE : tuning.SPIN_RATE;
}

/**
 * Points the current trick would be worth if landed cleanly right now.
 *
 * Rotational tricks pay per completed half-revolution, so a 360 is worth more than a
 * 180 but an incomplete 270 is worth the 180 it actually finished -- the player is paid
 * for what they landed, not what they attempted.
 */
export function pendingScore(state: BoardState, tuning: BoardTuning): number {
  const base = BASE_SCORE[state.trickId] ?? 0;
  if (base === 0) return 0;

  let units: number;
  if (isRotational(state.trickId)) {
    // Half-revolutions, which is how snowboard rotations are actually counted.
    units = Math.floor(Math.abs(state.trickRot) / Math.PI) * 0.5;
  } else {
    units = state.trickHoldTime;
  }
  if (units <= 0) return 0;

  // Air time is a mild multiplier: bigger air is worth more, but not so much that
  // height dominates execution.
  const airFactor = 1 + clamp01(state.airTime / 2.5) * 0.6;
  const raw = base * units * airFactor;
  return Math.round(state.trickBroken ? raw * tuning.BREAK_SCORE_KEEP : raw);
}

/** How far the current rotation is from the nearest whole revolution, in radians. */
export function rotationError(state: BoardState): number {
  const rot = Math.abs(state.trickRot);
  const nearest = Math.round(rot / TWO_PI) * TWO_PI;
  return Math.abs(rot - nearest);
}

/** Completed half-revolutions, for naming the trick on the HUD (180, 360, 540...). */
export function completedHalfSpins(state: BoardState): number {
  return Math.floor(Math.abs(state.trickRot) / Math.PI);
}
