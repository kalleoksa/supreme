import { clamp01, DEG } from '../core/math.js';
import { dot3 } from '../core/vec3.js';
import { FailReason, LandQuality, TrickState, type BoardState } from './BoardState.js';
import type { BoardTuning } from './boardTuning.js';
import { SimEventKind, type EventBuffer } from './events.js';
import { isRotational, pendingScore, rotationError } from './Trick.js';

/**
 * Landing grading, and the reason it names its failures.
 *
 * The loudest historical complaint about the game this one descends from was that its
 * trick system was illegible -- "far too easy to get it wrong" -- and the deeper problem
 * was not difficulty, it was that a failure told you nothing. You landed badly, lost
 * your points, and had no idea which of four things you had done wrong.
 *
 * So the grader's job is not only to produce a number. It has to know *why*, and say so:
 * UNDER-ROTATED is a different mistake from SIDEWAYS, and a player who is told which one
 * they made can fix it. That is the whole thesis of this phase, and it starts with the
 * simulation actually computing the answer rather than just a lower score.
 */

export interface LandingResult {
  quality: LandQuality;
  /** Continuous 0..1 grade behind the band, for the HUD and for scoring. */
  score01: number;
  reason: FailReason;
  points: number;
  /** Points given up by breaking out of the trick, for the HUD to report. */
  forfeited: number;
}

const result: LandingResult = {
  quality: LandQuality.Clean,
  score01: 1,
  reason: FailReason.None,
  points: 0,
  forfeited: 0,
};

/** Weights for the three components of a landing grade. They sum to 1. */
const W_FLAT = 0.4;
const W_ALIGN = 0.35;
const W_TRICK = 0.25;

/**
 * Grade a landing and apply its consequences.
 *
 * Called on the transition from airborne to grounded, before the ground snap has removed
 * the impact velocity -- the impact is one of the things being graded.
 */
export function resolveLanding(
  state: BoardState,
  tuning: BoardTuning,
  events: EventBuffer,
  impactSpeed: number,
): LandingResult {
  const forgive = state.ground.landForgive;

  // --- How flat is the landing? Compare the descent angle against the slope: coming
  // down steeply onto a shallow slope is what breaks legs, and landing *along* a slope
  // is what feels effortless.
  const horiz = Math.hypot(state.vel.x, state.vel.z);
  const descentAngle = Math.atan2(-state.vel.y, Math.max(horiz, 1e-3));
  const slopeAngle = state.slopeAngle;
  // A perfect landing has the velocity parallel to the surface.
  const flatErr = Math.abs(descentAngle - slopeAngle) / (tuning.LAND_ANGLE_MAX * DEG * forgive);
  const flat01 = 1 - clamp01(flatErr);

  // --- Is the board pointing where it is going? Landing sideways at speed is the other
  // classic way to lose a run.
  let alignErr = 0;
  if (horiz > 1) {
    const travelX = state.vel.x / horiz;
    const travelZ = state.vel.z / horiz;
    const dot = Math.cos(state.yaw) * travelX + Math.sin(state.yaw) * travelZ;
    alignErr = Math.acos(clamp01(Math.abs(dot))) / (tuning.LAND_ALIGN_MAX * DEG * forgive);
  }
  const align01 = 1 - clamp01(alignErr);

  // --- Did the rotation finish? An unbroken trick still mid-revolution is a crash, not
  // a bad landing: the board is simply not underneath the rider.
  let trick01 = 1;
  let rotationBad = false;
  const wasTricking =
    state.trickState === TrickState.Tricking || state.trickState === TrickState.Breaking;
  if (wasTricking && isRotational(state.trickId)) {
    const err = rotationError(state);
    const tolerance = tuning.LAND_ROT_TOL * DEG * forgive;
    trick01 = 1 - clamp01(err / tolerance);
    rotationBad = err > tolerance && !state.trickBroken;
  }

  // A weighted sum alone is too forgiving: with these weights a landing that is
  // *completely* sideways still scores 0.65 and grades as Clean, because the other two
  // components mask it. Multiplying by the worst component means being wholly wrong about
  // any one thing caps the grade -- you cannot land clean while pointing 90 degrees off
  // your direction of travel, however good the rest of it was.
  const weighted = W_FLAT * flat01 + W_ALIGN * align01 + W_TRICK * trick01;
  const worst = Math.min(flat01, align01, trick01);
  const score01 = clamp01(weighted * (0.35 + 0.65 * worst));

  // --- Bands, plus the hard failure cases.
  let quality: LandQuality;
  let reason = FailReason.None;

  if (impactSpeed > tuning.IMPACT_MAX * forgive) {
    quality = LandQuality.Crash;
    reason = FailReason.HardImpact;
  } else if (rotationBad) {
    quality = LandQuality.Crash;
    // Distinguishing under- from over-rotation matters: they are opposite corrections.
    const rot = Math.abs(state.trickRot);
    const nearest = Math.round(rot / (Math.PI * 2)) * (Math.PI * 2);
    reason = rot < nearest ? FailReason.UnderRotated : FailReason.OverRotated;
  } else if (score01 < 0.25) {
    quality = LandQuality.Crash;
    reason = worstOf(flat01, align01, trick01, state);
  } else if (score01 < 0.5) {
    quality = LandQuality.Sketchy;
    reason = worstOf(flat01, align01, trick01, state);
  } else if (score01 < 0.8) {
    quality = LandQuality.Clean;
  } else {
    quality = LandQuality.Perfect;
  }

  // --- Score.
  const raw = wasTricking ? pendingScore(state, tuning) : 0;
  const forfeited = state.trickBroken ? Math.round(raw / tuning.BREAK_SCORE_KEEP - raw) : 0;

  let points = 0;
  if (quality === LandQuality.Crash) {
    points = -tuning.CRASH_PENALTY;
    state.comboCount = 0;
  } else {
    const qualityMul =
      quality === LandQuality.Perfect ? 1.5 : quality === LandQuality.Clean ? 1 : 0.5;
    // Combo multiplies, but only for tricks -- chaining plain landings is not a skill.
    const comboMul = 1 + state.comboCount * 0.25;
    points = Math.round(raw * qualityMul * comboMul);
    if (raw > 0) state.comboCount++;
  }
  state.score = Math.max(0, state.score + points);

  // --- Consequences.
  switch (quality) {
    case LandQuality.Perfect:
      // The reward players chase. A perfect landing is *faster* than a clean one, which
      // is what makes precision worth the risk on a timed run.
      applyForwardBoost(state, tuning.LAND_BOOST);
      break;
    case LandQuality.Clean:
      break;
    case LandQuality.Sketchy:
      scaleHorizontalSpeed(state, 0.8);
      break;
    case LandQuality.Crash:
      // Speed collapses and control is gone for CRASH_RECOVER seconds. Crucially the
      // race clock keeps running -- losing time *is* the punishment. No respawn prompt,
      // no menu: an interruption would break the flow the whole run depends on.
      scaleHorizontalSpeed(state, 0.15);
      state.crashTimer = tuning.CRASH_RECOVER;
      state.trickState = TrickState.Crashed;
      break;
    default:
      break;
  }

  state.lastLandQuality = quality;
  state.lastFailReason = reason;
  if (quality === LandQuality.Crash) {
    // Crashed is already set above.
  } else if (state.trickState !== TrickState.Charging) {
    state.trickState = TrickState.Idle;
  }
  // Deliberately *not* clearing a Charging state. A player holding the jump through a
  // landing -- which happens constantly on rolling terrain -- would otherwise have their
  // charge silently reset to zero on every touchdown, because the ollie sees a
  // non-Charging state and starts over.
  state.trickId = 0;
  state.trickRot = 0;
  state.trickHoldTime = 0;
  state.trickBroken = false;

  result.quality = quality;
  result.score01 = score01;
  result.reason = reason;
  result.points = points;
  result.forfeited = forfeited;

  events.push(SimEventKind.Land, state.tick, quality, reason, points);
  if (quality === LandQuality.Crash) {
    events.push(SimEventKind.Crash, state.tick, reason, impactSpeed, 0);
  }
  return result;
}

/** Name the component that let the landing down, so the HUD can say it out loud. */
function worstOf(flat01: number, align01: number, trick01: number, state: BoardState): FailReason {
  if (flat01 <= align01 && flat01 <= trick01) return FailReason.TooFlat;
  if (align01 <= trick01) return FailReason.Sideways;
  const rot = Math.abs(state.trickRot);
  const nearest = Math.round(rot / (Math.PI * 2)) * (Math.PI * 2);
  return rot < nearest ? FailReason.UnderRotated : FailReason.OverRotated;
}

function applyForwardBoost(state: BoardState, boost: number): void {
  const horiz = Math.hypot(state.vel.x, state.vel.z);
  if (horiz < 1e-3) return;
  const scale = (horiz + boost) / horiz;
  state.vel.x *= scale;
  state.vel.z *= scale;
}

function scaleHorizontalSpeed(state: BoardState, factor: number): void {
  state.vel.x *= factor;
  state.vel.z *= factor;
}

/** Human-readable failure text. Kept next to the grader so the two cannot drift. */
export const FAIL_REASON_TEXT: Record<number, string> = {
  [FailReason.None]: '',
  [FailReason.UnderRotated]: 'UNDER-ROTATED',
  [FailReason.OverRotated]: 'OVER-ROTATED',
  [FailReason.Sideways]: 'SIDEWAYS',
  [FailReason.TooFlat]: 'TOO FLAT',
  [FailReason.HardImpact]: 'TOO FAST INTO THE GROUND',
  [FailReason.HitObstacle]: 'HIT SOMETHING',
  [FailReason.OutOfBounds]: 'OFF COURSE',
};

export const LAND_QUALITY_TEXT: Record<number, string> = {
  [LandQuality.Crash]: 'CRASH',
  [LandQuality.Sketchy]: 'SKETCHY',
  [LandQuality.Clean]: 'CLEAN',
  [LandQuality.Perfect]: 'PERFECT',
};

/** Impact speed into the surface, for the grader. Positive means moving into it. */
export function impactSpeedInto(state: BoardState): number {
  return -dot3(state.vel, {
    x: state.ground.nx,
    y: state.ground.ny,
    z: state.ground.nz,
  });
}
