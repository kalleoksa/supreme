import { describe, expect, it } from 'vitest';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { SurfaceId, TerrainFlag } from '../../src/sim/Terrain.js';
import {
  createBoardState,
  resetBoardState,
  TrickState,
  type BoardState,
} from '../../src/sim/BoardState.js';
import { createStepContext, stepBoard } from '../../src/sim/Board.js';
import { findLipAhead, lipQualityAt, timeToGround } from '../../src/sim/Ollie.js';
import { DEFAULT_TUNING, cloneTuning } from '../../src/sim/boardTuning.js';
import { createInputState, type InputState } from '../../src/input/InputState.js';
import { SimEventKind } from '../../src/sim/events.js';
import { v3 } from '../../src/core/vec3.js';

const DT = 1 / 120;
const DOWNHILL = Math.PI / 2;
const nrm = v3();

/** A field from an analytic height function, descending along +Z. */
function field(fn: (x: number, z: number) => number, size = 900, surface = SurfaceId.Groomed) {
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = fn(i - size / 2, j);
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

function rider(f: Heightfield, z: number, speed: number): BoardState {
  const s = createBoardState();
  f.normal(0, z, nrm);
  resetBoardState(s, 0, f.height(0, z) + DEFAULT_TUNING.RIDE_HEIGHT, z, DOWNHILL, speed, nrm);
  return s;
}

/**
 * Ride to `releaseZ`, holding the jump for `chargeSeconds` beforehand, then release.
 * Returns the pop that resulted and the apex reached.
 */
function popRun(
  f: Heightfield,
  opts: {
    startZ: number;
    releaseZ: number;
    chargeSeconds: number;
    speed?: number;
    tuning?: ReturnType<typeof cloneTuning>;
  },
) {
  const t = opts.tuning ?? cloneTuning();
  const ctx = createStepContext(t);
  const state = rider(f, opts.startZ, opts.speed ?? 22);
  const input: InputState = createInputState();

  let pop = 0;
  let quality = 0;
  let charge = 0;
  let apex = 0;
  let holding = false;

  for (let i = 0; i < 120 * 12; i++) {
    if (input.jump.pressed) input.jump.pressed = false;
    if (input.jump.released) input.jump.released = false;

    const distance = opts.releaseZ - state.pos.z;
    const timeToRelease = distance / Math.max(Math.hypot(state.vel.x, state.vel.z), 1e-3);

    if (!holding && state.grounded && timeToRelease <= opts.chargeSeconds) {
      holding = true;
      input.jump.pressed = true;
      input.jump.held = true;
    } else if (holding && input.jump.held && distance <= 0) {
      input.jump.held = false;
      input.jump.released = true;
    }

    stepBoard(state, input, f, DT, ctx);
    ctx.events.forEach((e) => {
      if (e.kind === SimEventKind.Pop) {
        pop = e.a;
        quality = e.b;
        charge = e.c;
      }
    });
    ctx.events.clear();

    if (!state.grounded) apex = Math.max(apex, state.clearance);
    if (pop > 0 && state.grounded && i > 60) break;
  }

  return { pop, quality, charge, apex, state };
}

describe('lip detection', () => {
  it('reads a crest as high quality and a trough as none', () => {
    const t = cloneTuning();
    // A hump centred at z = 400: h = 200 - 0.2z + 3*(1 - ((z-400)/18)^2)^2 near the top.
    const crest = field((_x, z) => {
      const u = (z - 400) / 18;
      const bump = Math.abs(u) < 1 ? 3 * (1 - u * u) * (1 - u * u) : 0;
      return 200 - 0.2 * z + bump;
    });

    const onCrest = rider(crest, 400, 22);
    expect(lipQualityAt(onCrest, crest, t)).toBeGreaterThan(0.5);

    const trough = field((_x, z) => {
      const u = (z - 400) / 18;
      const dip = Math.abs(u) < 1 ? -3 * (1 - u * u) * (1 - u * u) : 0;
      return 200 - 0.2 * z + dip;
    });
    const inTrough = rider(trough, 400, 22);
    expect(lipQualityAt(inTrough, trough, t)).toBe(0);
  });

  it('reads flat ground as no lip at all', () => {
    const flat = field((_x, z) => 200 - 0.2 * z);
    expect(lipQualityAt(rider(flat, 400, 22), flat, cloneTuning())).toBe(0);
  });

  it('is stateless, so the timing window does not move with frame rate', () => {
    // The alternative -- differencing terrain height across ticks -- gives a window
    // that widens or narrows with the display rate, so the timing a player learns at
    // 144 Hz would not be the timing they get on a throttled phone.
    const crest = field((_x, z) => {
      const u = (z - 300) / 16;
      return 200 - 0.2 * z + (Math.abs(u) < 1 ? 2.5 * (1 - u * u) * (1 - u * u) : 0);
    });
    const t = cloneTuning();
    const a = rider(crest, 300, 10);
    const b = rider(crest, 300, 38);
    // Same place, wildly different speeds: the measure must not care.
    expect(lipQualityAt(a, crest, t)).toBeCloseTo(lipQualityAt(b, crest, t), 6);
  });
});

describe('the charged ollie', () => {
  it('pops harder with more charge on flat ground', () => {
    const flat = field((_x, z) => 200 - 0.2 * z);
    const brief = popRun(flat, { startZ: 100, releaseZ: 160, chargeSeconds: 0.05 });
    const full = popRun(flat, { startZ: 100, releaseZ: 160, chargeSeconds: 0.8 });

    expect(brief.pop).toBeGreaterThan(0);
    expect(full.pop).toBeGreaterThan(brief.pop * 1.5);
    expect(full.apex).toBeGreaterThan(brief.apex);
  });

  it('a zero-charge release at a crest pops as hard as a full charge on the flat', () => {
    // Feel-gate criterion #2, and the reason this mechanic is worth building. Timing
    // and charge are interchangeable currencies in one budget, so a player who reads
    // terrain gets the same air as one who crouches -- and gets it while still
    // steering, because they never crouched.
    const t = cloneTuning();
    const flat = field((_x, z) => 200 - 0.2 * z);
    // A crest sharp enough to be worth a full-quality lip.
    const crest = field((_x, z) => {
      const u = (z - 400) / 14;
      return 200 - 0.2 * z + (Math.abs(u) < 1 ? 3.2 * (1 - u * u) * (1 - u * u) : 0);
    });

    const chargedFlat = popRun(flat, {
      startZ: 200,
      releaseZ: 330,
      chargeSeconds: t.CHARGE_TIME + 0.15,
      tuning: t,
    });
    const timedCrest = popRun(crest, {
      startZ: 300,
      releaseZ: 400,
      chargeSeconds: 0.02,
      tuning: t,
    });

    expect(timedCrest.quality).toBeGreaterThan(0.8);
    expect(timedCrest.charge).toBeLessThan(0.15);
    expect(chargedFlat.charge).toBeGreaterThan(0.9);

    // Within 15%: LIP_WEIGHT = 1 makes them nominally equal, and the remaining gap is
    // the terrain's own contribution to the launch on the crest.
    expect(timedCrest.pop).toBeGreaterThan(chargedFlat.pop * 0.85);
  });

  it('charging costs speed, so timing is the faster route', () => {
    const flat = field((_x, z) => 200 - 0.2 * z, 900);
    const t = cloneTuning();
    const ctx = createStepContext(t);

    const charging = rider(flat, 100, 24);
    const coasting = rider(flat, 100, 24);
    const hold = createInputState();
    hold.jump.pressed = true;
    hold.jump.held = true;
    const idle = createInputState();

    stepBoard(charging, hold, flat, DT, ctx);
    hold.jump.pressed = false;
    for (let i = 0; i < 120; i++) {
      stepBoard(charging, hold, flat, DT, ctx);
      stepBoard(coasting, idle, flat, DT, ctx);
    }

    expect(charging.trickState).toBe(TrickState.Charging);
    expect(Math.hypot(charging.vel.x, charging.vel.z)).toBeLessThan(
      Math.hypot(coasting.vel.x, coasting.vel.z),
    );
  });

  it('reports lip quality and spent charge so the HUD can explain the pop', () => {
    // Without these the player sees a big or small jump and cannot tell why, which is
    // exactly how the original's timing ended up feeling arbitrary.
    const crest = field((_x, z) => {
      const u = (z - 300) / 15;
      return 200 - 0.2 * z + (Math.abs(u) < 1 ? 3 * (1 - u * u) * (1 - u * u) : 0);
    });
    const run = popRun(crest, { startZ: 220, releaseZ: 300, chargeSeconds: 0.05 });
    expect(run.quality).toBeGreaterThan(0);
    expect(run.quality).toBeLessThanOrEqual(1);
    expect(run.charge).toBeGreaterThanOrEqual(0);
  });

  it('never exceeds MAX_POP even with a full charge on a perfect lip', () => {
    const t = cloneTuning();
    const crest = field((_x, z) => {
      const u = (z - 400) / 12;
      return 200 - 0.2 * z + (Math.abs(u) < 1 ? 4 * (1 - u * u) * (1 - u * u) : 0);
    });
    const run = popRun(crest, {
      startZ: 260,
      releaseZ: 400,
      chargeSeconds: t.CHARGE_TIME + 0.5,
      tuning: t,
    });
    expect(run.pop).toBeLessThanOrEqual(t.MAX_POP + 1e-6);
  });

  it('actually leaves the ground rather than being swallowed by the snap', () => {
    // The ordering trap: a pop applied while the board is still inside SNAP_TOL gets
    // removed by the ground snap on the very same step, and the jump silently does
    // nothing.
    const flat = field((_x, z) => 200 - 0.2 * z);
    const run = popRun(flat, { startZ: 100, releaseZ: 150, chargeSeconds: 0.6 });
    expect(run.apex).toBeGreaterThan(0.5);
  });

  it('refuses to pop on NoJump terrain', () => {
    const flat = field((_x, z) => 200 - 0.2 * z);
    flat.flagBytes.fill(TerrainFlag.NoJump);
    const run = popRun(flat, { startZ: 100, releaseZ: 150, chargeSeconds: 0.6 });
    expect(run.pop).toBe(0);
  });

  it('loses the charge when terrain launches the board first', () => {
    // Charge is payment for a pop. Holding it through an accidental air must not bank
    // a free one for the landing.
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const flat = field((_x, z) => 200 - 0.2 * z);
    const state = rider(flat, 100, 24);

    const hold = createInputState();
    hold.jump.pressed = true;
    hold.jump.held = true;
    stepBoard(state, hold, flat, DT, ctx);
    hold.jump.pressed = false;
    for (let i = 0; i < 40; i++) stepBoard(state, hold, flat, DT, ctx);
    expect(state.jumpCharge).toBeGreaterThan(0);

    // Throw it into the air by hand, as a kicker would.
    state.vel.y += 7;
    stepBoard(state, hold, flat, DT, ctx);
    expect(state.grounded).toBe(false);

    // Past the grace window the charge is gone, and stays gone while airborne.
    for (let i = 0; i < Math.ceil(t.CHARGE_AIR_GRACE / DT) + 4; i++) {
      stepBoard(state, hold, flat, DT, ctx);
    }
    expect(state.grounded).toBe(false);
    expect(state.jumpCharge).toBe(0);
    expect(state.trickState).toBe(TrickState.Air);
  });

  it('keeps the charge through a momentary skim over a ripple', () => {
    // The other side of the same rule, and the one that makes charging usable at all.
    // The test slope offers a crest roughly every 22 m by design, so at 120 km/h the
    // board goes briefly light several times a second. Discarding on every one of those
    // meant holding the button did nothing.
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const flat = field((_x, z) => 200 - 0.2 * z);
    const state = rider(flat, 100, 24);

    const hold = createInputState();
    hold.jump.pressed = true;
    hold.jump.held = true;
    stepBoard(state, hold, flat, DT, ctx);
    hold.jump.pressed = false;
    for (let i = 0; i < 40; i++) stepBoard(state, hold, flat, DT, ctx);
    const banked = state.jumpCharge;
    expect(banked).toBeGreaterThan(0);

    // A nudge that lifts the board for well under the grace window.
    state.vel.y += 1.2;
    for (let i = 0; i < 8; i++) stepBoard(state, hold, flat, DT, ctx);

    // Charge survived, and kept accumulating.
    expect(state.trickState).toBe(TrickState.Charging);
    expect(state.jumpCharge).toBeGreaterThanOrEqual(banked);
  });

  it('resumes charging on landing when the button is still held', () => {
    // The press edge alone is not enough. Hold the button, get bounced airborne by a
    // roller (which correctly discards the charge), land still holding -- and no new
    // press edge ever arrives, so the jump is dead until the player lets go and presses
    // again. On rolling terrain at speed that happens constantly and reads as the jump
    // randomly not working.
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const flat = field((_x, z) => 200 - 0.2 * z);
    const state = rider(flat, 100, 24);

    const hold = createInputState();
    hold.jump.pressed = true;
    hold.jump.held = true;
    stepBoard(state, hold, flat, DT, ctx);
    hold.jump.pressed = false;
    for (let i = 0; i < 40; i++) stepBoard(state, hold, flat, DT, ctx);

    // Terrain throws the board; past the grace window the charge is discarded.
    state.vel.y += 7;
    for (let i = 0; i < Math.ceil(t.CHARGE_AIR_GRACE / DT) + 4; i++) {
      stepBoard(state, hold, flat, DT, ctx);
    }
    expect(state.jumpCharge).toBe(0);

    // Fly and land, never releasing the button and never pressing it again.
    for (let i = 0; i < 400 && !state.grounded; i++) stepBoard(state, hold, flat, DT, ctx);
    expect(state.grounded).toBe(true);

    // Charging must have picked up again by itself.
    for (let i = 0; i < 30; i++) stepBoard(state, hold, flat, DT, ctx);
    expect(state.trickState).toBe(TrickState.Charging);
    expect(state.jumpCharge).toBeGreaterThan(0);
  });

  it('does not pop while crashed', () => {
    const t = cloneTuning();
    const ctx = createStepContext(t);
    const flat = field((_x, z) => 200 - 0.2 * z);
    const state = rider(flat, 100, 20);
    state.crashTimer = 1;

    const hold = createInputState();
    hold.jump.pressed = true;
    hold.jump.held = true;
    for (let i = 0; i < 60; i++) stepBoard(state, hold, flat, DT, ctx);
    expect(state.jumpCharge).toBe(0);

    hold.jump.held = false;
    hold.jump.released = true;
    ctx.events.clear();
    stepBoard(state, hold, flat, DT, ctx);
    let popped = false;
    ctx.events.forEach((e) => {
      if (e.kind === SimEventKind.Pop) popped = true;
    });
    expect(popped).toBe(false);
  });
});

describe('the lip band assist', () => {
  it('points at a crest ahead on the current path', () => {
    // The direct fix for the historical complaint that the timing was invisible.
    const crest = field((_x, z) => {
      const u = (z - 300) / 15;
      return 200 - 0.2 * z + (Math.abs(u) < 1 ? 3 * (1 - u * u) * (1 - u * u) : 0);
    });
    const t = cloneTuning();
    // 22 m short of the crest. The horizon is 1.2 s of travel, which at 25 m/s is only
    // 30 m -- deliberately about a second of warning, since that is how long a player
    // needs to see the lip, decide, and start charging. A crest further out than that
    // is correctly invisible.
    const state = rider(crest, 278, 25);
    const found = findLipAhead(state, crest, t);

    expect(found.distance).toBeGreaterThan(0);
    expect(found.distance).toBeGreaterThan(12);
    expect(found.distance).toBeLessThan(30);
    expect(found.quality).toBeGreaterThan(0.33);
  });

  it('points at nothing on featureless ground', () => {
    // A marker that is always on screen teaches nothing.
    const flat = field((_x, z) => 200 - 0.2 * z);
    const found = findLipAhead(rider(flat, 200, 25), flat, cloneTuning());
    expect(found.distance).toBe(-1);
  });

  it('points at nothing when nearly stopped', () => {
    const flat = field((_x, z) => 200 - 0.2 * z);
    const found = findLipAhead(rider(flat, 200, 0.5), flat, cloneTuning());
    expect(found.distance).toBe(-1);
  });
});

describe('time to ground', () => {
  it('is zero on the ground', () => {
    const flat = field((_x, z) => 200 - 0.2 * z);
    expect(timeToGround(rider(flat, 200, 20), flat, 9.81)).toBe(0);
  });

  it('grows with height and shrinks as the board falls', () => {
    // The air HUD reads this so a player can see whether a rotation will finish before
    // impact, rather than finding out on landing.
    const flat = field((_x, z) => 200 - 0.2 * z);
    const low = rider(flat, 200, 20);
    low.grounded = false;
    low.pos.y += 2;
    low.vel.y = 0;

    const high = rider(flat, 200, 20);
    high.grounded = false;
    high.pos.y += 10;
    high.vel.y = 0;

    const tLow = timeToGround(low, flat, 9.81);
    const tHigh = timeToGround(high, flat, 9.81);
    expect(tHigh).toBeGreaterThan(tLow);
    expect(tLow).toBeGreaterThan(0);
  });

  it('accounts for upward velocity', () => {
    const flat = field((_x, z) => 200 - 0.2 * z);
    const rising = rider(flat, 200, 20);
    rising.grounded = false;
    rising.pos.y += 1;
    rising.vel.y = 8;

    const falling = rider(flat, 200, 20);
    falling.grounded = false;
    falling.pos.y += 1;
    falling.vel.y = 0;

    expect(timeToGround(rising, flat, 9.81)).toBeGreaterThan(timeToGround(falling, flat, 9.81));
  });
});
