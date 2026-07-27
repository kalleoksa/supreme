import { clamp01 } from '../core/math.js';
import type { Vec2 } from '../core/vec3.js';
import { FailReason, resetBoardState, type BoardState } from '../sim/BoardState.js';
import { SimEventKind, type EventBuffer } from '../sim/events.js';
import type { Heightfield } from '../sim/Heightfield.js';
import type { ProgressField } from './ProgressField.js';

/**
 * The race: countdown, clock, splits, finish, and out-of-bounds recovery.
 *
 * Pure like the rest of the simulation -- no wall clock, no DOM, no `localStorage`.
 * Persisting a best time is the application's job; this class only reports the number.
 *
 * It lives beside `ProgressField` rather than in `sim/` because it is entirely a
 * consumer of that field: every question it answers ("how far along", "is that a
 * shortcut or a cheat", "where is the split", "which way is down-course") is a lookup
 * into the same baked grid. Splitting the two across directories would have hidden
 * that.
 *
 * ## Why splits are progress thresholds and not gates
 *
 * A trigger volume is something a player can legitimately ride around on a
 * 250-metre-wide face, which turns a missed split into a bug report. A threshold on
 * the geodesic field is valid for every line by construction. The banner the player
 * sees is placed along the isoline afterwards -- the checkpoint is real, but it was
 * never the thing being measured.
 */

export const enum RaceState {
  /** Board held still on the start gate while the count runs down. */
  Countdown = 0,
  Running = 1,
  Finished = 2,
}

export interface RaceRules {
  /** Seconds of 3-2-1 before the board is released. */
  countdown: number;
  /** Progress thresholds that record a split. Ascending, exclusive of the finish. */
  splits: readonly number[];
  /** Seconds outside the bounds before the run is put back on course. */
  oobGrace: number;
  /** Snapshots per second of the recovery ring buffer. */
  rewindHz: number;
  /** Seconds of history the ring buffer holds. */
  rewindWindow: number;
  /** Speed the rider is given when placed back on course, in m/s. */
  respawnSpeed: number;
  /**
   * Fastest the board can physically travel, in m/s. Only used to sanity-check the
   * progress rate: a jump larger than this could not have been ridden.
   */
  maxSpeed: number;
}

export const DEFAULT_RULES: RaceRules = {
  countdown: 3,
  splits: [0.25, 0.5, 0.75],
  oobGrace: 3,
  rewindHz: 10,
  rewindWindow: 5,
  respawnSpeed: 8,
  maxSpeed: 45,
};

/**
 * A completed run, as the application persists it.
 *
 * Declared here rather than beside the storage code so the pure side owns the shape:
 * the race produces these numbers, and where they are kept is somebody else's problem.
 */
export interface BestRun {
  time: number;
  splits: number[];
  score: number;
  resets: number;
}

export interface StartGate {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** x, y, z, yaw, progress, time. */
const SNAPSHOT_STRIDE = 6;

export class Race {
  state: RaceState = RaceState.Countdown;

  /** Seconds since GO. Stops advancing at the finish. */
  time = 0;
  /** Seconds left on the start count. Zero once running. */
  countdown: number;

  /** Progress at the current position, and the best reached so far. */
  progress = 0;
  bestProgress = 0;

  /** Split times in seconds, in `rules.splits` order; -1 until reached. */
  readonly splitTimes: number[];

  /** Finish time in seconds, interpolated within the crossing step; -1 until finished. */
  finishTime = -1;

  /** Currently outside the bounds, and for how long. */
  oob = false;
  oobTime = 0;
  /** Signed metres to the boundary at the current position: positive inside. */
  oobDistance = 0;

  /** How many times the run has been put back on course. */
  resets = 0;

  /**
   * Progress steps too large to have been ridden. Diagnostic only in M1 -- there is no
   * leaderboard to defend yet -- but it is the check a verified time would need, and it
   * costs one comparison per step to have it already reporting.
   */
  flaggedJumps = 0;

  private nextSplit = 0;
  /** False until the first observed step, so the initial sample is not read as a jump. */
  private sampled = false;
  private readonly finishThreshold: number;

  private readonly snapshots: Float64Array;
  private readonly snapshotCapacity: number;
  private snapshotCount = 0;
  private snapshotHead = 0;
  private snapshotTimer = 0;

  constructor(
    readonly progressField: ProgressField,
    readonly start: StartGate,
    readonly rules: RaceRules = DEFAULT_RULES,
  ) {
    this.countdown = rules.countdown;
    this.splitTimes = rules.splits.map(() => -1);
    this.snapshotCapacity = Math.max(1, Math.ceil(rules.rewindWindow * rules.rewindHz));
    this.snapshots = new Float64Array(this.snapshotCapacity * SNAPSHOT_STRIDE);

    // The finish is "within one cell of the line", not "progress exactly 1".
    //
    // Progress is normalized geodesic distance sampled bilinearly, so it only reaches
    // exactly 1 directly on a seeded cell centre; a rider crossing between two centres
    // peaks slightly below. One cell of slack is about 4 m of course, and the crossing
    // time is interpolated within the step anyway, so the threshold costs nothing in
    // accuracy while making the trigger unconditional.
    const cellProgress = progressField.reachable
      ? progressField.cell / progressField.maxDistance
      : 0;
    this.finishThreshold = 1 - cellProgress;
  }

  /** Put the race back on the start gate. */
  reset(): void {
    this.state = RaceState.Countdown;
    this.time = 0;
    this.countdown = this.rules.countdown;
    this.progress = 0;
    this.bestProgress = 0;
    this.splitTimes.fill(-1);
    this.nextSplit = 0;
    this.finishTime = -1;
    this.oob = false;
    this.oobTime = 0;
    this.oobDistance = 0;
    this.resets = 0;
    this.flaggedJumps = 0;
    this.sampled = false;
    this.snapshotCount = 0;
    this.snapshotHead = 0;
    this.snapshotTimer = 0;
  }

  /**
   * Start immediately, skipping the count.
   *
   * For the harnesses that drive the simulation directly -- diagnostic captures, the
   * browser tests, the headless bot -- which deliberately ignore the wall clock and have
   * no use for three seconds of a frozen board.
   */
  releaseGate(): void {
    if (this.state !== RaceState.Countdown) return;
    this.countdown = 0;
    this.state = RaceState.Running;
  }

  /**
   * Advance the race clock. Call before stepping the board.
   *
   * @returns true when the board should be held still for this step -- during the
   *   count, and after the finish. Freezing it here rather than zeroing the input is
   *   deliberate: a held input still charges an ollie, and a rider who pre-loads a pop
   *   on the gate should get it the instant the count ends.
   */
  prepare(dt: number): boolean {
    if (this.state === RaceState.Finished) return true;
    if (this.state === RaceState.Countdown) {
      this.countdown -= dt;
      if (this.countdown > 0) return true;
      this.countdown = 0;
      this.state = RaceState.Running;
    }
    this.time += dt;
    return false;
  }

  /** Read the board's new position and update progress, splits, finish and bounds. */
  observe(board: BoardState, field: Heightfield, dt: number, events: EventBuffer): void {
    if (this.state !== RaceState.Running) return;

    const previous = this.progress;
    const p = this.progressField.progressAt(board.pos.x, board.pos.z);
    this.progress = p;
    if (p > this.bestProgress) this.bestProgress = p;

    // The first sample of a run is a jump from nothing to wherever the gate is, which
    // is not a rate at all -- only the steps after it describe motion.
    if (this.sampled && this.progressField.reachable) {
      const rideable = (this.rules.maxSpeed * dt) / this.progressField.maxDistance + 1e-6;
      if (p - previous > rideable) this.flaggedJumps++;
    }
    this.sampled = true;

    const { splits } = this.rules;
    while (this.nextSplit < splits.length && this.bestProgress >= splits[this.nextSplit]) {
      this.splitTimes[this.nextSplit] = this.time;
      events.push(
        SimEventKind.Checkpoint,
        board.tick,
        this.nextSplit,
        this.time,
        splits[this.nextSplit],
      );
      this.nextSplit++;
    }

    if (p >= this.finishThreshold) {
      // Interpolate the crossing inside the step. Without this the clock is quantized
      // to the 8.3 ms timestep, which is 0.2 m of course at speed -- enough to make two
      // identical runs report different times, and the first thing anyone would notice
      // comparing a ghost.
      const span = p - previous;
      const frac = span > 1e-12 ? clamp01((this.finishThreshold - previous) / span) : 1;
      this.finishTime = this.time - dt * (1 - frac);
      this.state = RaceState.Finished;
      events.push(SimEventKind.Finish, board.tick, this.finishTime, board.score, this.resets);
      return;
    }

    this.updateBounds(board, field, dt, events);
  }

  private updateBounds(
    board: BoardState,
    field: Heightfield,
    dt: number,
    events: EventBuffer,
  ): void {
    const inside = field.contains(board.pos.x, board.pos.z);
    this.oobDistance = inside ? this.progressField.oobDistanceAt(board.pos.x, board.pos.z) : -127;

    if (this.oobDistance > 0) {
      if (this.oob) {
        this.oob = false;
        this.oobTime = 0;
        events.push(SimEventKind.BackInBounds, board.tick);
      }
      this.recordSnapshot(board, dt);
      return;
    }

    if (!this.oob) {
      this.oob = true;
      this.oobTime = 0;
      events.push(SimEventKind.OutOfBounds, board.tick, 0, this.oobDistance);
    }
    this.oobTime += dt;
    if (this.oobTime >= this.rules.oobGrace) this.returnToCourse(board, field, events);
  }

  /**
   * Snapshot a valid pose, at `rewindHz`.
   *
   * Only grounded, un-crashed, in-bounds states are recorded, because the buffer's one
   * job is to hold somewhere it is safe to be put back. Recording mid-air would let a
   * recovery drop the rider into the same hole they just fell out of.
   */
  private recordSnapshot(board: BoardState, dt: number): void {
    this.snapshotTimer += dt;
    const interval = 1 / this.rules.rewindHz;
    if (this.snapshotTimer < interval) return;
    this.snapshotTimer = 0;
    if (!board.grounded || board.crashTimer > 0) return;

    const base = this.snapshotHead * SNAPSHOT_STRIDE;
    this.snapshots[base] = board.pos.x;
    this.snapshots[base + 1] = board.pos.y;
    this.snapshots[base + 2] = board.pos.z;
    this.snapshots[base + 3] = board.yaw;
    this.snapshots[base + 4] = this.progress;
    this.snapshots[base + 5] = this.time;
    this.snapshotHead = (this.snapshotHead + 1) % this.snapshotCapacity;
    if (this.snapshotCount < this.snapshotCapacity) this.snapshotCount++;
  }

  /**
   * Put the rider back on course at the furthest valid pose in the buffer.
   *
   * **The clock keeps running.** That is the entire punishment, and it is the right
   * one: no menu, no fade, no confirmation. An interruption breaks flow far more than
   * losing three seconds does, and a run that has gone wrong should still be a run.
   */
  private returnToCourse(board: BoardState, field: Heightfield, events: EventBuffer): void {
    let x = this.start.x;
    let y = this.start.y;
    let z = this.start.z;
    let yaw = this.start.yaw;
    let progress = 0;

    let bestProgress = -1;
    for (let i = 0; i < this.snapshotCount; i++) {
      const base = i * SNAPSHOT_STRIDE;
      if (this.snapshots[base + 4] > bestProgress) {
        bestProgress = this.snapshots[base + 4];
        x = this.snapshots[base];
        y = this.snapshots[base + 1];
        z = this.snapshots[base + 2];
        yaw = this.snapshots[base + 3];
        progress = bestProgress;
      }
    }

    field.normal(x, z, tmpNormal);
    resetBoardState(board, x, y, z, yaw, this.rules.respawnSpeed, tmpNormal);
    board.lastFailReason = FailReason.OutOfBounds;

    this.oob = false;
    this.oobTime = 0;
    this.oobDistance = this.progressField.oobDistanceAt(x, z);
    // Re-anchor progress so the teleport is not itself read as an impossible jump.
    this.progress = progress;
    this.resets++;
    this.snapshotTimer = 0;

    events.push(SimEventKind.OutOfBounds, board.tick, 1, this.oobDistance, this.resets);
  }

  /**
   * How well the rider is heading down-course: 1 straight at the finish, -1 backwards.
   *
   * Same field again, no extra data. Drives the wrong-way warning, and while out of
   * bounds the arrow pointing back to the course.
   */
  headingAlignment(board: BoardState): number {
    const speed = Math.hypot(board.vel.x, board.vel.z);
    if (speed < 0.5) return 1;
    this.progressField.directionToFinish(board.pos.x, board.pos.z, tmpDir);
    if (tmpDir.x === 0 && tmpDir.z === 0) return 1;
    return (board.vel.x * tmpDir.x + board.vel.z * tmpDir.z) / speed;
  }

  /** The finished run, or undefined while it is still in progress. */
  result(board: BoardState): BestRun | undefined {
    if (this.state !== RaceState.Finished || this.finishTime < 0) return undefined;
    return {
      time: this.finishTime,
      splits: this.splitTimes.slice(),
      score: board.score,
      resets: this.resets,
    };
  }

  /** Seconds behind (positive) or ahead of a reference run at the same split. */
  splitDelta(index: number, reference: readonly number[] | undefined): number | undefined {
    if (!reference) return undefined;
    const mine = this.splitTimes[index];
    const theirs = reference[index];
    if (mine < 0 || theirs === undefined || theirs < 0) return undefined;
    return mine - theirs;
  }
}

/** Reused: nothing in the step path allocates. */
const tmpNormal = { x: 0, y: 1, z: 0 };
const tmpDir: Vec2 = { x: 0, z: 0 };

/** `1:23.45`, the way a stopwatch reads. */
export function formatRaceTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(2)}`;
}

/** `+1.24` / `-0.31`, for a split comparison. */
export function formatDelta(seconds: number): string {
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${Math.abs(seconds).toFixed(2)}`;
}
