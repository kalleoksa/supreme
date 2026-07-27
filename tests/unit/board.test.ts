import { describe, expect, it } from 'vitest';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { SurfaceId } from '../../src/sim/Terrain.js';
import {
  createBoardState,
  groundSpeed,
  resetBoardState,
  snapshotBoardState,
  SNAPSHOT_SIZE,
  type BoardState,
} from '../../src/sim/BoardState.js';
import { createStepContext, stepBoard } from '../../src/sim/Board.js';
import { DEFAULT_TUNING, cloneTuning, tuningHash } from '../../src/sim/boardTuning.js';
import { createInputState, type InputState } from '../../src/input/InputState.js';
import { buildTestSlope } from '../../src/track/testSlope.js';
import { fnv1aFloats, toHex } from '../../src/core/hash.js';
import { v3 } from '../../src/core/vec3.js';
import { angleDelta } from '../../src/core/math.js';

const DT = 1 / 120;

/** A uniform plane at a given grade, descending along +Z. */
function plane(grade: number, surface = SurfaceId.Groomed, size = 400): Heightfield {
  const cols = size;
  const rows = size;
  const heights = new Float32Array(cols * rows);
  const surfaces = new Uint8Array(cols * rows).fill(surface);
  const flags = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) heights[j * cols + i] = 500 - grade * j;
  }
  return new Heightfield({
    cols,
    rows,
    spacing: 1,
    originX: -size / 2,
    originZ: -20,
    heights,
    surfaces,
    flags,
  });
}

const spawnNormal = v3();

function spawn(field: Heightfield, speed = 6, x = 0, z = 0): BoardState {
  const s = createBoardState();
  // Yaw PI/2 faces +Z, which is downhill on these test planes. The normal matters:
  // without it the spawn velocity is horizontal, which on a slope means the board
  // starts a moment airborne.
  field.normal(x, z, spawnNormal);
  resetBoardState(
    s,
    x,
    field.height(x, z) + DEFAULT_TUNING.RIDE_HEIGHT,
    z,
    Math.PI / 2,
    speed,
    spawnNormal,
  );
  return s;
}

function run(
  state: BoardState,
  field: Heightfield,
  input: InputState,
  seconds: number,
  dt = DT,
): void {
  const ctx = createStepContext(cloneTuning());
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepBoard(state, input, field, dt, ctx);
}

describe('board on a slope', () => {
  it('accelerates downhill and stays on the surface', () => {
    const field = plane(0.2);
    const state = spawn(field);
    const input = createInputState();

    run(state, field, input, 3);

    expect(state.grounded).toBe(true);
    expect(groundSpeed(state)).toBeGreaterThan(8);
    // Ground snap keeps the board exactly at ride height, never sunk or floating.
    expect(state.pos.y - field.height(state.pos.x, state.pos.z)).toBeCloseTo(
      DEFAULT_TUNING.RIDE_HEIGHT,
      4,
    );
    // Travelling downhill means +Z here.
    expect(state.pos.z).toBeGreaterThan(10);
  });

  it('converges to a terminal speed set by drag and friction', () => {
    // The most useful single sanity check on the longitudinal model: a constant slope
    // must reach an equilibrium rather than accelerating without bound.
    const field = plane(0.2, SurfaceId.Groomed, 3000);
    const state = spawn(field);
    const input = createInputState();

    run(state, field, input, 40);
    const first = groundSpeed(state);
    run(state, field, input, 10);
    const second = groundSpeed(state);

    expect(Math.abs(second - first)).toBeLessThan(0.5);
    // A 20% grade should be a fast cruise, not a crawl and not the cap.
    expect(first).toBeGreaterThan(15);
    expect(first).toBeLessThan(DEFAULT_TUNING.MAX_SPEED);
  });

  it('never exceeds MAX_SPEED even on a very steep slope', () => {
    const field = plane(0.85, SurfaceId.Ice, 3000);
    const state = spawn(field, 20);
    const input = createInputState();
    run(state, field, input, 60);
    expect(state.vLong).toBeLessThanOrEqual(DEFAULT_TUNING.MAX_SPEED + 1e-6);
  });

  it('slows down on flat ground and does not reverse through zero', () => {
    const field = plane(0);
    const state = spawn(field, 15);
    const input = createInputState();

    let prev = groundSpeed(state);
    const ctx = createStepContext(cloneTuning());
    for (let i = 0; i < 1200; i++) {
      stepBoard(state, input, field, DT, ctx);
      const now = groundSpeed(state);
      // Monotonically non-increasing, and friction must never push it backwards.
      expect(now).toBeLessThanOrEqual(prev + 1e-6);
      expect(state.vLong).toBeGreaterThanOrEqual(-1e-6);
      prev = now;
    }
  });

  it('brakes harder than it coasts', () => {
    const field = plane(0.12, SurfaceId.Groomed, 1200);
    const coast = spawn(field, 25);
    const braked = spawn(field, 25);

    const neutral = createInputState();
    const braking = createInputState();
    braking.steerY = -1;

    run(coast, field, neutral, 2);
    run(braked, field, braking, 2);

    expect(groundSpeed(braked)).toBeLessThan(groundSpeed(coast) - 5);
  });

  it('tucking is faster than not tucking', () => {
    const field = plane(0.25, SurfaceId.Groomed, 3000);
    const upright = spawn(field, 20);
    const tucked = spawn(field, 20);

    const neutral = createInputState();
    const tuck = createInputState();
    tuck.steerY = 1;

    run(upright, field, neutral, 15);
    run(tucked, field, tuck, 15);

    expect(groundSpeed(tucked)).toBeGreaterThan(groundSpeed(upright) + 1);
  });
});

describe('board steering', () => {
  it('turns toward the steer input', () => {
    const field = plane(0.2, SurfaceId.Groomed, 1200);
    const state = spawn(field, 12);
    const input = createInputState();
    input.steerX = 1;

    const before = state.yaw;
    run(state, field, input, 1);
    expect(state.yaw).toBeGreaterThan(before);

    const right = spawn(field, 12);
    const left = createInputState();
    left.steerX = -1;
    run(right, field, left, 1);
    expect(right.yaw).toBeLessThan(before);
  });

  it('derives yaw rate from a commanded radius, so losing speed does not tighten the turn', () => {
    // The failure this guards against is subtle and only appears in play. If yaw rate
    // falls with speed -- the obvious way to make a board feel heavy -- then turning
    // scrubs speed, lower speed raises the rate, and the higher rate scrubs more
    // speed. One held input spirals the board into a stationary spin.
    const field = plane(0.05, SurfaceId.Groomed, 3000);
    const input = createInputState();
    input.steerX = 1;

    const slow = spawn(field, 6);
    const fast = spawn(field, 30);
    run(slow, field, input, 0.4);
    run(fast, field, input, 0.4);

    // Faster must mean a higher yaw rate, not a lower one: omega = v / r.
    expect(Math.abs(fast.yawRate)).toBeGreaterThan(Math.abs(slow.yawRate));
  });

  it('can always turn around when nearly stopped', () => {
    // omega = v / r alone means a stopped rider can never reorient, which is a dead
    // end with no way out. PIVOT_RATE exists precisely to prevent that.
    const field = plane(0.02, SurfaceId.Groomed, 1200);
    const state = spawn(field, 0.2);
    const input = createInputState();
    input.steerX = 1;

    const before = state.yaw;
    run(state, field, input, 1.5);
    expect(Math.abs(state.yaw - before)).toBeGreaterThan(0.4);
  });

  it('a held full-lock carve does not spiral into a standstill', () => {
    // Measured before the radius model: a one-second carve at 87 km/h rotated the
    // board 134 degrees and left it at 2 km/h facing uphill, with no way back.
    const { field } = buildTestSlope();
    const state = spawn(field, 24, 0, 40);

    const carving = createInputState();
    carving.steerX = 1;
    carving.carve.held = true;

    run(state, field, carving, 3);

    // Still carrying real speed after three seconds of the most abusive input a
    // player can give it.
    expect(groundSpeed(state)).toBeGreaterThan(4);
  });

  it('a skidding board weathervanes back toward its direction of travel', () => {
    // A board sliding sideways has far more drag on its broad side than along its
    // length, and that imbalance rotates it toward travel. Without it, a board left
    // pointing off-axis after a carve slid down the hill sideways until the player
    // manually steered out, which felt like ice rather than snow.
    const field = plane(0.2, SurfaceId.Groomed, 2000);
    const state = spawn(field, 22);

    // Travelling down the fall line but pointed 60 degrees off it.
    state.yaw = Math.PI / 2 + 1.05;
    const offBy = () => Math.abs(angleDelta(state.yaw, Math.atan2(state.vel.z, state.vel.x)));
    const before = offBy();

    run(state, field, createInputState(), 1.5);
    expect(offBy()).toBeLessThan(before * 0.6);
  });

  it('does not weathervane away a clean carve', () => {
    // The alignment must not fight a deliberate turn. It is scaled by skid precisely
    // so that a railed carve -- which has almost none -- is left alone.
    const field = plane(0.2, SurfaceId.Groomed, 2000);
    const state = spawn(field, 22);
    const carving = createInputState();
    carving.steerX = 0.7;
    carving.carve.held = true;

    const before = state.yaw;
    run(state, field, carving, 1);
    // Still turned a long way despite the board being off its travel direction.
    expect(Math.abs(state.yaw - before)).toBeGreaterThan(0.7);
  });

  it('a passive traversing rider drifts back toward the fall line', () => {
    // Emergent rather than designed, and worth keeping: lateral gravity pulls a
    // traversing board down-slope, that rotates its direction of travel, and the
    // weathervane follows. So a player who simply lets go ends up pointing downhill
    // again instead of traversing across the mountain forever -- without having to
    // know any of that. Slowly, though; steering is still much faster.
    const field = plane(0.22, SurfaceId.Groomed, 3000);
    const state = spawn(field, 18);

    // Point it across the hill: +X, perpendicular to the +Z fall line.
    state.yaw = 0;
    state.vel.x = 18;
    state.vel.y = 0;
    state.vel.z = 0;

    const idle = createInputState();
    run(state, field, idle, 8);

    // Downhill is yaw = PI/2. Started 90 degrees off it; must have closed some of it.
    const offBy = Math.abs(angleDelta(state.yaw, Math.PI / 2));
    expect(offBy).toBeLessThan(Math.PI / 2 - 0.15);
    expect(state.pos.z).toBeGreaterThan(2);
  });

  it('a rider turned across the fall line recovers by steering', () => {
    // The stuck state: strong off-edge grip meant a board turned sideways
    // hockey-stopped to a permanent halt, because lateral friction killed the very
    // sideways velocity that gravity would otherwise use to pull it downhill.
    const field = plane(0.25, SurfaceId.Groomed, 2000);
    const state = spawn(field, 10);

    // Point it across the hill and drain its speed, the state a spin-out leaves.
    state.yaw = 0; // +X, perpendicular to the +Z fall line
    state.vel.x = 1;
    state.vel.y = 0;
    state.vel.z = 0;

    const steer = createInputState();
    steer.steerX = 1; // turn toward +Z, downhill
    run(state, field, steer, 3);

    const neutral = createInputState();
    neutral.steerY = 1;
    run(state, field, neutral, 4);

    expect(groundSpeed(state)).toBeGreaterThan(8);
    expect(state.pos.z).toBeGreaterThan(10);
  });

  it('gives steering mass rather than snapping to the target rate', () => {
    const field = plane(0.1, SurfaceId.Groomed, 1200);
    const state = spawn(field, 12);
    const input = createInputState();
    input.steerX = 1;
    const ctx = createStepContext(cloneTuning());

    stepBoard(state, input, field, DT, ctx);
    const afterOne = state.yawRate;
    for (let i = 0; i < 30; i++) stepBoard(state, input, field, DT, ctx);
    const settled = state.yawRate;

    expect(afterOne).toBeLessThan(settled * 0.5);
  });
});

describe('board in the air', () => {
  it('leaves the ground over a crest and lands again', () => {
    const { field } = buildTestSlope();
    // Approach the big roller at z = 700 with plenty of speed.
    const state = createBoardState();
    resetBoardState(
      state,
      6,
      field.height(6, 640) + DEFAULT_TUNING.RIDE_HEIGHT,
      640,
      Math.PI / 2,
      30,
    );
    const input = createInputState();
    const ctx = createStepContext(cloneTuning());

    let sawAir = false;
    let maxApex = 0;
    for (let i = 0; i < 600; i++) {
      stepBoard(state, input, field, DT, ctx);
      if (!state.grounded) {
        sawAir = true;
        maxApex = Math.max(maxApex, state.clearance);
      }
    }
    expect(sawAir).toBe(true);
    expect(maxApex).toBeGreaterThan(0.3);
    // And it must come back down rather than flying off forever.
    expect(state.grounded).toBe(true);
  });

  it('does not re-ground on the tick it leaves the surface', () => {
    // Without the "not moving away from the surface" test, the snap re-captures the
    // board immediately and eats every jump.
    const field = plane(0.2, SurfaceId.Groomed, 1200);
    const state = spawn(field, 20);
    const ctx = createStepContext(cloneTuning());
    const input = createInputState();

    stepBoard(state, input, field, DT, ctx);
    // Launch it upward by hand, as a pop would.
    state.vel.y += 6;
    stepBoard(state, input, field, DT, ctx);
    expect(state.grounded).toBe(false);
  });

  it('has no lateral grip in the air', () => {
    const field = plane(0.2, SurfaceId.Groomed, 1200);
    const state = spawn(field, 20);
    const ctx = createStepContext(cloneTuning());
    const input = createInputState();

    state.pos.y += 30;
    state.vel.y = 0;
    // Sideways velocity, which on the ground would be scrubbed off quickly.
    state.vel.x = 8;
    const before = state.vel.x;
    for (let i = 0; i < 20; i++) stepBoard(state, input, field, DT, ctx);

    expect(state.grounded).toBe(false);
    expect(Math.abs(state.vel.x)).toBeGreaterThan(before * 0.9);
  });
});

describe('board grip and surfaces', () => {
  it('lets a flat board drift rather than railing it', () => {
    // Both halves of this matter. Sideways velocity has to bleed off, or the board
    // never settles; but it must not vanish, or the board rails whether or not the
    // player is carving -- which makes the carve invisible and, worse, lets a rider
    // turned across the fall line hockey-stop to a permanent halt.
    const field = plane(0.1, SurfaceId.Groomed, 1200);
    const state = spawn(field, 15);
    const input = createInputState();

    state.vel.x = 10;
    run(state, field, input, 1);

    const drift = Math.abs(state.vLat);
    expect(drift).toBeLessThan(6);
    expect(drift).toBeGreaterThan(0.5);
  });

  it('grips markedly harder on edge than off it', () => {
    // The carve has to be *visible* in the numbers or the central mechanic is
    // invisible in play. Off-edge grip was originally set high enough that carving
    // changed almost nothing; this is the assertion that keeps the gap real.
    const field = plane(0.15, SurfaceId.Groomed, 1200);
    const loose = spawn(field, 20);
    const railed = spawn(field, 20);
    loose.vel.x = 10;
    railed.vel.x = 10;

    const neutral = createInputState();
    const carving = createInputState();
    carving.carve.held = true;

    run(loose, field, neutral, 0.6);
    run(railed, field, carving, 0.6);

    expect(Math.abs(railed.vLat)).toBeLessThan(Math.abs(loose.vLat) * 0.5);
  });

  it('holds a line better on groomed snow than on ice', () => {
    const groomed = plane(0.15, SurfaceId.Groomed, 1200);
    const ice = plane(0.15, SurfaceId.Ice, 1200);

    const a = spawn(groomed, 20);
    const b = spawn(ice, 20);
    a.vel.x = 8;
    b.vel.x = 8;

    const input = createInputState();
    run(a, groomed, input, 0.5);
    run(b, ice, input, 0.5);

    // Ice has a fraction of the grip, so more sideways drift survives.
    expect(Math.abs(b.vLat)).toBeGreaterThan(Math.abs(a.vLat));
  });

  it('reports skid as a normalized 0..1 measure', () => {
    const field = plane(0.15, SurfaceId.Ice, 1200);
    const state = spawn(field, 20);
    state.vel.x = 20;
    const ctx = createStepContext(cloneTuning());
    stepBoard(state, createInputState(), field, DT, ctx);
    expect(state.skid).toBeGreaterThan(0);
    expect(state.skid).toBeLessThanOrEqual(1);
  });
});

describe('frame-rate independence', () => {
  it('produces the same trajectory at 30 fps and 120 fps substepping', () => {
    // The property that makes an iOS-throttled display play the same game. Decays are
    // analytic in dt precisely so this holds.
    const field = plane(0.22, SurfaceId.Groomed, 3000);
    const input = createInputState();
    input.steerX = 0.4;
    input.steerY = 0.6;

    const a = spawn(field, 10);
    const b = spawn(field, 10);

    // Both advance 6 s of simulated time in fixed 1/120 steps; the difference is only
    // how many steps are grouped per notional frame, which must not matter at all.
    const ctxA = createStepContext(cloneTuning());
    for (let i = 0; i < 720; i++) stepBoard(a, input, field, DT, ctxA);

    const ctxB = createStepContext(cloneTuning());
    for (let frame = 0; frame < 180; frame++) {
      for (let sub = 0; sub < 4; sub++) stepBoard(b, input, field, DT, ctxB);
    }

    expect(b.pos.x).toBeCloseTo(a.pos.x, 9);
    expect(b.pos.y).toBeCloseTo(a.pos.y, 9);
    expect(b.pos.z).toBeCloseTo(a.pos.z, 9);
    expect(b.yaw).toBeCloseTo(a.yaw, 9);
  });
});

describe('numerical robustness', () => {
  it('keeps every state field finite under random input', () => {
    // Fuzzing for NaN is worth more than it sounds: normalizing a zero-length vector
    // is the classic failure in code like this, and it presents as the rider silently
    // vanishing rather than as an error.
    const { field } = buildTestSlope();
    const state = spawn(field, 10, 0, 30);
    const ctx = createStepContext(cloneTuning());
    const input = createInputState();
    const snapshot = new Float64Array(SNAPSHOT_SIZE);

    let seed = 12345;
    const rand = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < 20000; i++) {
      if (i % 7 === 0) {
        input.steerX = rand() * 2 - 1;
        input.steerY = rand() * 2 - 1;
        input.carve.held = rand() > 0.5;
        input.jump.held = rand() > 0.7;
      }
      stepBoard(state, input, field, DT, ctx);

      snapshotBoardState(state, snapshot);
      for (let k = 0; k < SNAPSHOT_SIZE; k++) {
        if (!Number.isFinite(snapshot[k])) {
          throw new Error(`state[${k}] became ${snapshot[k]} at step ${i}`);
        }
      }

      // Reset if it wanders off the field, mimicking what the game does.
      if (!field.contains(state.pos.x, state.pos.z)) {
        resetBoardState(state, 0, field.height(0, 30) + 0.06, 30, Math.PI / 2, 8);
      }
    }
  });

  it('survives being placed on a vertical face without producing NaN', () => {
    // The degenerate case for the board basis: heading parallel to the surface normal.
    const cols = 64;
    const rows = 64;
    const heights = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) heights[j * cols + i] = j < 32 ? 0 : 60;
    }
    const field = new Heightfield({
      cols,
      rows,
      spacing: 1,
      originX: 0,
      originZ: 0,
      heights,
      surfaces: new Uint8Array(cols * rows),
      flags: new Uint8Array(cols * rows),
    });

    const state = createBoardState();
    resetBoardState(state, 30, field.height(30, 31) + 0.06, 31, Math.PI / 2, 20);
    const ctx = createStepContext(cloneTuning());
    const input = createInputState();

    for (let i = 0; i < 400; i++) stepBoard(state, input, field, DT, ctx);
    expect(Number.isFinite(state.pos.x + state.pos.y + state.pos.z)).toBe(true);
    expect(Number.isFinite(state.yaw)).toBe(true);
  });
});

describe('determinism', () => {
  it('two identical runs produce an identical state hash', () => {
    const { field } = buildTestSlope();
    const input = createInputState();
    input.steerX = 0.3;
    input.steerY = 0.8;

    const hashRun = (): number => {
      const state = spawn(field, 8, 0, 20);
      const ctx = createStepContext(cloneTuning());
      const snapshot = new Float64Array(SNAPSHOT_SIZE);
      for (let i = 0; i < 3600; i++) stepBoard(state, input, field, DT, ctx);
      snapshotBoardState(state, snapshot);
      return fnv1aFloats(snapshot);
    };

    expect(toHex(hashRun())).toBe(toHex(hashRun()));
  });

  it('matches its golden state hash', () => {
    // A failure here means the physics changed. That is allowed -- but it invalidates
    // recorded times, so it should be a deliberate act with an updated snapshot,
    // not something noticed weeks later.
    const { field } = buildTestSlope();
    const input = createInputState();
    input.steerX = 0.3;
    input.steerY = 0.8;

    const state = spawn(field, 8, 0, 20);
    const ctx = createStepContext(cloneTuning());
    for (let i = 0; i < 3600; i++) stepBoard(state, input, field, DT, ctx);

    const snapshot = new Float64Array(SNAPSHOT_SIZE);
    snapshotBoardState(state, snapshot);
    expect(toHex(fnv1aFloats(snapshot))).toMatchInlineSnapshot(`"150574ca"`);
  });

  it('tuning hash is stable and order-independent', () => {
    const a = cloneTuning();
    const b = cloneTuning();
    expect(tuningHash(a)).toBe(tuningHash(b));

    b.MAX_SPEED = a.MAX_SPEED + 1;
    expect(tuningHash(b)).not.toBe(tuningHash(a));
  });
});
