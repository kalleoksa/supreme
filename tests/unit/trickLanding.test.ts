import { describe, expect, it } from 'vitest';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { SurfaceId } from '../../src/sim/Terrain.js';
import {
  createBoardState,
  FailReason,
  LandQuality,
  resetBoardState,
  TrickState,
  type BoardState,
} from '../../src/sim/BoardState.js';
import { createStepContext, stepBoard } from '../../src/sim/Board.js';
import { cloneTuning, DEFAULT_TUNING } from '../../src/sim/boardTuning.js';
import { createInputState, type InputState } from '../../src/input/InputState.js';
import { completedHalfSpins, isRotational, TrickId, trickFor } from '../../src/sim/Trick.js';
import { FAIL_REASON_TEXT, LAND_QUALITY_TEXT, resolveLanding } from '../../src/sim/Landing.js';
import { SimEventKind, EventBuffer } from '../../src/sim/events.js';
import { v3 } from '../../src/core/vec3.js';
import { DEG } from '../../src/core/math.js';

const DT = 1 / 120;
const DOWNHILL = Math.PI / 2;
const nrm = v3();

function slope(grade = 0.2, size = 900, surface = SurfaceId.Groomed) {
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = 400 - grade * j;
  }
  return new Heightfield({
    cols: size,
    rows: size,
    spacing: 1,
    originX: -size / 2,
    originZ: 0,
    heights,
    surfaces: new Uint8Array(size * size).fill(surface),
    flags: new Uint8Array(size * size),
  });
}

function rider(f: Heightfield, z = 100, speed = 24): BoardState {
  const s = createBoardState();
  f.normal(0, z, nrm);
  resetBoardState(s, 0, f.height(0, z) + DEFAULT_TUNING.RIDE_HEIGHT, z, DOWNHILL, speed, nrm);
  return s;
}

interface LandingSnapshot {
  quality: number;
  reason: number;
  points: number;
}

/** Launch the rider, run a scripted trick, and report the resulting landing. */
function airRun(
  f: Heightfield,
  opts: {
    dirX?: -1 | 0 | 1;
    dirY?: -1 | 0 | 1;
    /** Seconds to hold the trick modifier. */
    hold?: number;
    /** Tap jump this many seconds after the trick starts, to break out. */
    breakAfter?: number;
    launch?: number;
    speed?: number;
    /** Skip the trick entirely, for grading a plain landing. */
    noTrick?: boolean;
  } = {},
): { landing: LandingSnapshot | null; state: BoardState } {
  const t = cloneTuning();
  const ctx = createStepContext(t);
  const state = rider(f, 100, opts.speed ?? 24);
  const input: InputState = createInputState();

  // Throw it up by hand, so the test is about the trick rather than the ollie.
  state.vel.y += opts.launch ?? 8;
  stepBoard(state, input, f, DT, ctx);

  if (!opts.noTrick) {
    input.trick.pressed = true;
    input.trick.held = true;
    input.trickDirX = opts.dirX ?? 0;
    input.trickDirY = opts.dirY ?? 0;
  }

  let landing: LandingSnapshot | null = null;
  const hold = opts.hold ?? 10;
  let elapsed = 0;

  for (let i = 0; i < 120 * 8; i++) {
    stepBoard(state, input, f, DT, ctx);
    elapsed += DT;

    input.trick.pressed = false;
    input.jump.pressed = false;
    if (elapsed > hold) input.trick.held = false;
    if (opts.breakAfter !== undefined && Math.abs(elapsed - opts.breakAfter) < DT * 0.75) {
      input.jump.pressed = true;
    }

    ctx.events.forEach((e) => {
      if (e.kind === SimEventKind.Land) landing = { quality: e.a, reason: e.b, points: e.c };
    });
    ctx.events.clear();

    if (landing) break;
  }

  return { landing, state };
}

describe('trick selection', () => {
  it('maps the latched steer direction to a trick', () => {
    expect(trickFor(1, 0)).toBe(TrickId.Spin);
    expect(trickFor(-1, 0)).toBe(TrickId.Spin);
    expect(trickFor(0, 1)).toBe(TrickId.NoseGrab);
    expect(trickFor(0, -1)).toBe(TrickId.Backflip);
    expect(trickFor(1, 1)).toBe(TrickId.GrabbedSpin);
    // Modifier with nothing else: a plain spin, rather than nothing at all.
    expect(trickFor(0, 0)).toBe(TrickId.Spin);
  });

  it('knows which tricks score by rotating and which by holding', () => {
    expect(isRotational(TrickId.Spin)).toBe(true);
    expect(isRotational(TrickId.Backflip)).toBe(true);
    expect(isRotational(TrickId.GrabbedSpin)).toBe(true);
    expect(isRotational(TrickId.NoseGrab)).toBe(false);
  });
});

describe('tricks in the air', () => {
  it('accumulates rotation while spinning', () => {
    const f = slope();
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const state = rider(f);
    const input = createInputState();

    state.vel.y += 9;
    stepBoard(state, input, f, DT, ctx);
    input.trick.pressed = true;
    input.trick.held = true;
    input.trickDirX = 1;

    stepBoard(state, input, f, DT, ctx);
    input.trick.pressed = false;
    expect(state.trickState).toBe(TrickState.Tricking);

    for (let i = 0; i < 60; i++) stepBoard(state, input, f, DT, ctx);
    expect(Math.abs(state.trickRot)).toBeGreaterThan(1);
    expect(completedHalfSpins(state)).toBeGreaterThanOrEqual(0);
  });

  it('lets a rotation coast on after the modifier is released', () => {
    // You cannot stop a spin in mid-air, and pretending otherwise would make rotation
    // feel weightless. Measured mid-flight, because the landing clears trickRot.
    const f = slope();
    const t0 = cloneTuning();
    const ctx0 = createStepContext(t0);
    const spin = rider(f);
    const in0 = createInputState();
    spin.vel.y += 11;
    stepBoard(spin, in0, f, DT, ctx0);
    in0.trick.pressed = true;
    in0.trick.held = true;
    in0.trickDirX = 1;
    stepBoard(spin, in0, f, DT, ctx0);
    in0.trick.pressed = false;

    for (let i = 0; i < 20; i++) stepBoard(spin, in0, f, DT, ctx0);
    const atRelease = Math.abs(spin.trickRot);
    in0.trick.held = false;
    for (let i = 0; i < 20; i++) stepBoard(spin, in0, f, DT, ctx0);

    expect(spin.grounded).toBe(false);
    // Still turning after the button came up.
    expect(Math.abs(spin.trickRot)).toBeGreaterThan(atRelease);
  });

  it('ends a grab when the modifier is released', () => {
    // A grab is not a rotation: letting go is letting go.
    const f = slope();
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const state = rider(f);
    const input = createInputState();
    state.vel.y += 10;
    stepBoard(state, input, f, DT, ctx);
    input.trick.pressed = true;
    input.trick.held = true;
    input.trickDirY = 1; // nose grab
    stepBoard(state, input, f, DT, ctx);
    input.trick.pressed = false;
    for (let i = 0; i < 30; i++) stepBoard(state, input, f, DT, ctx);
    const heldFor = state.trickHoldTime;
    expect(heldFor).toBeGreaterThan(0);

    input.trick.held = false;
    stepBoard(state, input, f, DT, ctx);
    expect(state.trickState).toBe(TrickState.Air);
  });

  it('breaks out of a trick on a jump tap and unwinds toward level', () => {
    // The safety valve. Tapping jump trades points for a landing you can survive.
    const f = slope();
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const state = rider(f);
    const input = createInputState();

    state.vel.y += 11;
    stepBoard(state, input, f, DT, ctx);
    input.trick.pressed = true;
    input.trick.held = true;
    input.trickDirX = 1;
    stepBoard(state, input, f, DT, ctx);
    input.trick.pressed = false;

    // Spin a little way past level, then bail.
    for (let i = 0; i < 40; i++) stepBoard(state, input, f, DT, ctx);
    const midRotation = Math.abs(state.trickRot);
    expect(midRotation).toBeGreaterThan(0.5);

    input.jump.pressed = true;
    stepBoard(state, input, f, DT, ctx);
    input.jump.pressed = false;
    expect(state.trickState).toBe(TrickState.Breaking);
    expect(state.trickBroken).toBe(true);

    // The break window pulls the rotation toward the nearest whole revolution.
    const before = Math.abs(state.trickRot % (Math.PI * 2));
    for (let i = 0; i < Math.ceil(t.BREAK_TIME / DT) + 2; i++) {
      stepBoard(state, input, f, DT, ctx);
    }
    const after = Math.abs(state.trickRot % (Math.PI * 2));
    expect(Math.min(after, Math.PI * 2 - after)).toBeLessThanOrEqual(
      Math.min(before, Math.PI * 2 - before) + 1e-6,
    );
  });
});

describe('landing grading', () => {
  it('grades a clean level landing well', () => {
    const f = slope();
    // No trick at all: this is about the landing itself. Pressing the modifier would
    // start a spin that coasts to the ground and land mid-revolution.
    const run = airRun(f, { noTrick: true, launch: 5 });
    expect(run.landing).not.toBeNull();
    expect(run.landing!.quality).toBeGreaterThanOrEqual(LandQuality.Clean);
    expect(run.landing!.reason).toBe(FailReason.None);
  });

  it('crashes on an unfinished rotation, and says which way it was wrong', () => {
    // This is the phase's whole thesis. The original's failure was not that landings were
    // hard, it was that a failure told you nothing -- so the grader has to know *why*.
    const f = slope();
    // Hold a spin all the way to the ground so it lands mid-revolution.
    const run = airRun(f, { dirX: 1, hold: 10, launch: 6 });
    expect(run.landing).not.toBeNull();

    if (run.landing!.quality === LandQuality.Crash) {
      expect([FailReason.UnderRotated, FailReason.OverRotated]).toContain(run.landing!.reason);
    }
  });

  it('a broken trick is not treated as an unfinished rotation', () => {
    // The break exists to save the landing; it must actually do that.
    const f = slope();
    const broken = airRun(f, { dirX: 1, hold: 10, breakAfter: 0.25, launch: 9 });
    expect(broken.landing).not.toBeNull();
    expect(broken.state.lastFailReason).not.toBe(FailReason.UnderRotated);
    expect(broken.state.lastFailReason).not.toBe(FailReason.OverRotated);
  });

  it('crashes on a hard impact and names it', () => {
    const f = slope();
    const t = cloneTuning();
    const state = rider(f, 100, 10);
    const events = new EventBuffer();

    // Straight down, far faster than IMPACT_MAX.
    state.vel.x = 0;
    state.vel.z = 2;
    state.vel.y = -(t.IMPACT_MAX + 10);
    state.ground.ny = 1;
    state.ground.nx = 0;
    state.ground.nz = 0;
    state.ground.landForgive = 1;

    const landing = resolveLanding(state, t, events, t.IMPACT_MAX + 10);
    expect(landing.quality).toBe(LandQuality.Crash);
    expect(landing.reason).toBe(FailReason.HardImpact);
    expect(state.crashTimer).toBeGreaterThan(0);
    expect(state.trickState).toBe(TrickState.Crashed);
  });

  it('names a sideways landing', () => {
    const f = slope();
    const t = cloneTuning();
    const state = rider(f, 100, 22);
    const events = new EventBuffer();

    // Travelling down the fall line but pointing across it.
    state.yaw = 0;
    state.vel.x = 0;
    state.vel.z = 22;
    state.vel.y = -1;
    state.slopeAngle = Math.atan(0.2);
    state.ground.ny = 1;
    state.ground.landForgive = 1;

    const landing = resolveLanding(state, t, events, 1);
    expect(landing.score01).toBeLessThan(0.8);
    expect(landing.reason).toBe(FailReason.Sideways);
  });

  it('names a landing that comes in too steep for the slope', () => {
    const f = slope();
    const t = cloneTuning();
    const state = rider(f, 100, 20);
    const events = new EventBuffer();

    // Nearly vertical descent onto a shallow slope, but under the impact limit.
    state.vel.x = 0;
    state.vel.z = 1.5;
    state.vel.y = -12;
    state.slopeAngle = Math.atan(0.05);
    state.ground.ny = 1;
    state.ground.landForgive = 1;

    const landing = resolveLanding(state, t, events, 4);
    expect(landing.reason).toBe(FailReason.TooFlat);
  });

  it('powder forgives what ice does not', () => {
    // Surface forgiveness is why a bail into deep snow is survivable.
    const t = cloneTuning();
    const f = slope();

    const grade = (forgive: number) => {
      const state = rider(f, 100, 20);
      state.vel.x = 0;
      state.vel.z = 8;
      state.vel.y = -9;
      state.slopeAngle = Math.atan(0.1);
      state.ground.ny = 1;
      state.ground.landForgive = forgive;
      return resolveLanding(state, t, new EventBuffer(), 6).score01;
    };

    expect(grade(1.4)).toBeGreaterThan(grade(0.5));
  });

  it('a perfect landing is faster than a clean one', () => {
    // The reason precision is worth risk on a timed run.
    const t = cloneTuning();
    const f = slope();
    const state = rider(f, 100, 22);
    // Velocity essentially parallel to the surface: as good as it gets.
    const slopeRad = Math.atan(0.2);
    state.slopeAngle = slopeRad;
    const speed = 22;
    state.vel.x = 0;
    state.vel.z = speed * Math.cos(slopeRad);
    state.vel.y = -speed * Math.sin(slopeRad);
    state.yaw = DOWNHILL;
    state.ground.ny = Math.cos(slopeRad);
    state.ground.nz = Math.sin(slopeRad);
    state.ground.landForgive = 1;

    const before = Math.hypot(state.vel.x, state.vel.z);
    const landing = resolveLanding(state, t, new EventBuffer(), 0.2);
    expect(landing.quality).toBe(LandQuality.Perfect);
    expect(Math.hypot(state.vel.x, state.vel.z)).toBeGreaterThan(before);
  });

  it('a crash collapses speed, starts a recovery timer and keeps the clock running', () => {
    const t = cloneTuning();
    const f = slope();
    const state = rider(f, 100, 30);
    state.vel.y = -(t.IMPACT_MAX + 5);
    state.ground.ny = 1;
    state.ground.landForgive = 1;
    const timeBefore = state.time;

    resolveLanding(state, t, new EventBuffer(), t.IMPACT_MAX + 5);

    expect(Math.hypot(state.vel.x, state.vel.z)).toBeLessThan(30 * 0.3);
    expect(state.crashTimer).toBeCloseTo(t.CRASH_RECOVER, 5);
    // No time is refunded and no state is rewound: losing time is the punishment.
    expect(state.time).toBe(timeBefore);
  });

  it('emits a land event, and a crash event only when it crashed', () => {
    const t = cloneTuning();
    const f = slope();

    const clean = rider(f, 100, 20);
    const slopeRad = Math.atan(0.2);
    clean.slopeAngle = slopeRad;
    clean.vel.z = 20 * Math.cos(slopeRad);
    clean.vel.y = -20 * Math.sin(slopeRad);
    clean.ground.ny = Math.cos(slopeRad);
    clean.ground.nz = Math.sin(slopeRad);
    clean.ground.landForgive = 1;
    const cleanEvents = new EventBuffer();
    resolveLanding(clean, t, cleanEvents, 0.2);

    let lands = 0;
    let crashes = 0;
    cleanEvents.forEach((e) => {
      if (e.kind === SimEventKind.Land) lands++;
      if (e.kind === SimEventKind.Crash) crashes++;
    });
    expect(lands).toBe(1);
    expect(crashes).toBe(0);

    const bad = rider(f, 100, 20);
    bad.vel.y = -(t.IMPACT_MAX + 8);
    bad.ground.ny = 1;
    bad.ground.landForgive = 1;
    const badEvents = new EventBuffer();
    resolveLanding(bad, t, badEvents, t.IMPACT_MAX + 8);
    let badCrashes = 0;
    badEvents.forEach((e) => {
      if (e.kind === SimEventKind.Crash) badCrashes++;
    });
    expect(badCrashes).toBe(1);
  });

  it('has display text for every failure reason and quality band', () => {
    // A reason the grader can produce but the HUD cannot name is worse than useless: the
    // player sees a blank where the explanation should be.
    for (const reason of [
      FailReason.None,
      FailReason.UnderRotated,
      FailReason.OverRotated,
      FailReason.Sideways,
      FailReason.TooFlat,
      FailReason.HardImpact,
      FailReason.HitObstacle,
      FailReason.OutOfBounds,
    ]) {
      expect(FAIL_REASON_TEXT[reason]).toBeDefined();
    }
    for (const q of [
      LandQuality.Crash,
      LandQuality.Sketchy,
      LandQuality.Clean,
      LandQuality.Perfect,
    ]) {
      expect(LAND_QUALITY_TEXT[q]).toBeTruthy();
    }
  });
});

describe('scoring', () => {
  it('pays for completed rotations, not attempted ones', () => {
    const t = cloneTuning();
    const f = slope();
    const state = rider(f, 100, 20);
    state.trickState = TrickState.Tricking;
    state.trickId = TrickId.Spin;
    state.airTime = 1;
    // Just short of a full revolution.
    state.trickRot = Math.PI * 2 - 0.05;
    state.trickBroken = true; // so the near-miss is not a crash
    state.slopeAngle = Math.atan(0.2);
    state.ground.ny = 1;
    state.ground.landForgive = 1;
    state.vel.z = 20;
    state.vel.y = -3;

    const landed = resolveLanding(state, t, new EventBuffer(), 2);
    // A 350-degree spin is paid as the 180 it actually completed.
    expect(landed.points).toBeGreaterThan(0);
  });

  it('a crash costs points and resets the combo', () => {
    const t = cloneTuning();
    const f = slope();
    const state = rider(f, 100, 20);
    state.score = 5000;
    state.comboCount = 3;
    state.vel.y = -(t.IMPACT_MAX + 6);
    state.ground.ny = 1;
    state.ground.landForgive = 1;

    resolveLanding(state, t, new EventBuffer(), t.IMPACT_MAX + 6);
    expect(state.score).toBe(5000 - t.CRASH_PENALTY);
    expect(state.comboCount).toBe(0);
  });

  it('never lets the score go negative', () => {
    const t = cloneTuning();
    const f = slope();
    const state = rider(f, 100, 20);
    state.score = 10;
    state.vel.y = -(t.IMPACT_MAX + 6);
    state.ground.ny = 1;
    state.ground.landForgive = 1;
    resolveLanding(state, t, new EventBuffer(), t.IMPACT_MAX + 6);
    expect(state.score).toBe(0);
  });

  it('uses degrees consistently in the tolerances', () => {
    // LAND_ROT_TOL and friends are authored in degrees for readability; a missing DEG
    // conversion would make them 57x too permissive and silently disable the grading.
    expect(DEFAULT_TUNING.LAND_ROT_TOL * DEG).toBeLessThan(1);
    expect(DEFAULT_TUNING.LAND_ANGLE_MAX * DEG).toBeLessThan(Math.PI / 2);
    expect(DEFAULT_TUNING.LAND_ALIGN_MAX * DEG).toBeLessThan(Math.PI / 2);
  });
});
