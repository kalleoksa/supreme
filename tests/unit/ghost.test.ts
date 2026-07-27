import { describe, expect, it } from 'vitest';
import {
  decodeGhost,
  GhostFlag,
  GHOST_FRAME_BYTES,
  GHOST_HEADER_BYTES,
  GhostRecorder,
} from '../../src/race/GhostRecorder.js';
import { quat, quatFromRiderPose, quatMul, quatNormalize } from '../../src/core/quat.js';
import { createStepContext, stepBoard } from '../../src/sim/Board.js';
import {
  createBoardState,
  resetBoardState,
  TrickState,
  type BoardState,
} from '../../src/sim/BoardState.js';
import { DEFAULT_TUNING } from '../../src/sim/boardTuning.js';
import { createInputState } from '../../src/input/InputState.js';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { SurfaceId } from '../../src/sim/Terrain.js';
import { v3 } from '../../src/core/vec3.js';

const DT = 1 / 120;

function plane(grade = 0.22, size = 400): Heightfield {
  const heights = new Float32Array(size * size);
  const surfaces = new Uint8Array(size * size).fill(SurfaceId.Groomed);
  const flags = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = 500 - grade * j;
  }
  return new Heightfield({
    cols: size,
    rows: size,
    spacing: 1,
    originX: -size / 2,
    originZ: -20,
    heights,
    surfaces,
    flags,
  });
}

const normal = v3();

function spawn(field: Heightfield, speed = 14): BoardState {
  const state = createBoardState();
  field.normal(0, 0, normal);
  resetBoardState(
    state,
    0,
    field.height(0, 0) + DEFAULT_TUNING.RIDE_HEIGHT,
    0,
    Math.PI / 2,
    speed,
    normal,
  );
  return state;
}

describe('quaternion pose', () => {
  it('is a unit quaternion', () => {
    const q = quatFromRiderPose(quat(), 1.1, -0.3, 0.24);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 10);
  });

  it('is the identity for a flat rider facing +X', () => {
    const q = quatFromRiderPose(quat(), 0, 0, 0);
    expect(q.x).toBeCloseTo(0, 12);
    expect(q.y).toBeCloseTo(0, 12);
    expect(q.z).toBeCloseTo(0, 12);
    expect(Math.abs(q.w)).toBeCloseTo(1, 12);
  });

  it('composes in the order the renderer applies: yaw, then pitch, then roll', () => {
    // Rotations do not commute, so this is the assertion that keeps a recorded ghost from
    // leaning the wrong way if someone reorders `RiderView`.
    const yaw = 0.7;
    const pitch = -0.25;
    const roll = 0.18;
    const expected = quat();
    quatMul(expected, axis(1, -yaw), axis(2, pitch));
    quatMul(expected, expected, axis(0, roll));
    quatNormalize(expected);

    const actual = quatFromRiderPose(quat(), yaw, pitch, roll);
    expect(actual.x).toBeCloseTo(expected.x, 12);
    expect(actual.y).toBeCloseTo(expected.y, 12);
    expect(actual.z).toBeCloseTo(expected.z, 12);
    expect(actual.w).toBeCloseTo(expected.w, 12);

    // And the reverse order is genuinely different, so the test above is not vacuous.
    const swapped = quat();
    quatMul(swapped, axis(2, pitch), axis(1, -yaw));
    quatMul(swapped, swapped, axis(0, roll));
    expect(Math.abs(swapped.x - expected.x) + Math.abs(swapped.z - expected.z)).toBeGreaterThan(
      0.01,
    );
  });
});

function axis(which: 0 | 1 | 2, angle: number) {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return {
    x: which === 0 ? s : 0,
    y: which === 1 ? s : 0,
    z: which === 2 ? s : 0,
    w: Math.cos(h),
  };
}

describe('GhostRecorder', () => {
  it('samples at its own rate, not once per simulation step', () => {
    const field = plane();
    const board = spawn(field);
    const ctx = createStepContext(DEFAULT_TUNING);
    const input = createInputState();
    const ghost = new GhostRecorder(20);

    let time = 0;
    for (let i = 0; i < 120 * 5; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
      time += DT;
      ghost.record(board, time, DT);
    }

    // 5 seconds at 20 Hz, plus the frame captured on the very first step.
    expect(ghost.count).toBeGreaterThanOrEqual(100);
    expect(ghost.count).toBeLessThanOrEqual(102);
  });

  it('records the same ghost at 30 fps as at 120 fps', () => {
    // The whole reason recording is driven from the simulation step: the capture must not
    // depend on how fast the machine drawing it happens to be.
    const capture = (substeps: number): number[] => {
      const field = plane();
      const board = spawn(field);
      const ctx = createStepContext(DEFAULT_TUNING);
      const input = createInputState();
      const ghost = new GhostRecorder(20);
      let time = 0;
      const frames = 120 * 6;
      for (let frame = 0; frame < frames / substeps; frame++) {
        for (let s = 0; s < substeps; s++) {
          stepBoard(board, input, field, DT, ctx);
          ctx.events.clear();
          time += DT;
          ghost.record(board, time, DT);
        }
      }
      return decodeGhost(ghost.serialize()).frames.map((f) => f.z);
    };

    const at120 = capture(1);
    const at30 = capture(4);
    expect(at30).toHaveLength(at120.length);
    for (let i = 0; i < at120.length; i++) expect(at30[i]).toBeCloseTo(at120[i], 5);
  });

  it('round-trips through the wire format', () => {
    const field = plane();
    const board = spawn(field);
    const ctx = createStepContext(DEFAULT_TUNING);
    const input = createInputState();
    const ghost = new GhostRecorder(20);

    let time = 0;
    const positions: { x: number; y: number; z: number; speed: number }[] = [];
    for (let i = 0; i < 120 * 3; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
      time += DT;
      const before = ghost.count;
      ghost.record(board, time, DT);
      if (ghost.count !== before) {
        positions.push({
          x: board.pos.x,
          y: board.pos.y,
          z: board.pos.z,
          speed: Math.hypot(board.vel.x, board.vel.z),
        });
      }
    }

    const decoded = decodeGhost(ghost.serialize());
    expect(decoded.hz).toBe(20);
    expect(decoded.frames).toHaveLength(positions.length);
    decoded.frames.forEach((f, i) => {
      // Position is float32, so exact to the storage precision.
      expect(f.x).toBeCloseTo(positions[i].x, 3);
      expect(f.y).toBeCloseTo(positions[i].y, 3);
      expect(f.z).toBeCloseTo(positions[i].z, 3);
      // Speed is quantized to a centimetre per second.
      expect(f.speed).toBeCloseTo(positions[i].speed, 1);
      // A unit quaternion survives int16 to well under a visible angle.
      const len = Math.hypot(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
      expect(len).toBeCloseTo(1, 3);
      expect(f.flags & GhostFlag.Grounded).toBe(GhostFlag.Grounded);
    });
  });

  it('costs about 45 KB for a 90-second run', () => {
    // The number that decided transform capture was affordable at all. If a change to the
    // frame layout blows this out, the format needs revisiting rather than the assertion.
    const ghost = new GhostRecorder(20);
    const field = plane();
    const board = spawn(field);
    const ctx = createStepContext(DEFAULT_TUNING);
    const input = createInputState();
    for (let i = 0; i < 120 * 90; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
      ghost.record(board, i * DT, DT);
      // Keep the rider on the plane; where it goes does not matter, only how much is kept.
      if (board.pos.z > 300) board.pos.z = 0;
    }
    expect(ghost.count).toBeGreaterThan(1790);
    expect(ghost.byteLength).toBeLessThan(48 * 1024);
    expect(ghost.byteLength).toBe(GHOST_HEADER_BYTES + ghost.count * GHOST_FRAME_BYTES);
  });

  it('records trick rotation separately from the riding pose', () => {
    const ghost = new GhostRecorder(20);
    const board = spawn(plane());
    board.trickState = TrickState.Tricking;
    board.trickRot = Math.PI * 1.5;
    ghost.record(board, 0, DT);

    const frame = decodeGhost(ghost.serialize()).frames[0];
    expect(frame.trickRot).toBeCloseTo(Math.PI * 1.5, 2);
    expect(frame.flags & GhostFlag.Tricking).toBe(GhostFlag.Tricking);
    // The pose itself carries no trick rotation: a viewer must be able to spin the board
    // without spinning the camera.
    const pose = quatFromRiderPose(quat(), board.yaw, 0, 0);
    expect(Math.abs(frame.rotation.y)).toBeCloseTo(Math.abs(pose.y), 2);
  });

  it('grows past its initial capacity rather than truncating the run', () => {
    const ghost = new GhostRecorder(20, 1); // capacity: 20 frames
    const board = spawn(plane());
    for (let i = 0; i < 100; i++) {
      board.pos.z = i;
      ghost.record(board, i * 0.05, 0.05);
    }
    expect(ghost.count).toBe(100);
    const frames = decodeGhost(ghost.serialize()).frames;
    expect(frames).toHaveLength(100);
    expect(frames[99].z).toBeCloseTo(99, 3);
  });

  it('resets to empty', () => {
    const ghost = new GhostRecorder(20);
    const board = spawn(plane());
    for (let i = 0; i < 40; i++) ghost.record(board, i * 0.05, 0.05);
    expect(ghost.count).toBeGreaterThan(0);
    ghost.reset();
    expect(ghost.count).toBe(0);
    expect(decodeGhost(ghost.serialize()).frames).toHaveLength(0);
  });

  it('refuses a buffer that is not a ghost', () => {
    expect(() => decodeGhost(new ArrayBuffer(4))).toThrow(/too short/);
    expect(() => decodeGhost(new ArrayBuffer(64))).toThrow(/bad magic/);

    const ghost = new GhostRecorder(20);
    const board = spawn(plane());
    for (let i = 0; i < 10; i++) ghost.record(board, i * 0.05, 0.05);
    const good = ghost.serialize();

    // A version we do not understand, and a truncated body, both fail loudly. A ghost that
    // decodes to plausible noise is worse than one that will not load.
    const wrongVersion = good.slice(0);
    new DataView(wrongVersion).setUint16(4, 99, true);
    expect(() => decodeGhost(wrongVersion)).toThrow(/version/);
    expect(() => decodeGhost(good.slice(0, good.byteLength - GHOST_FRAME_BYTES))).toThrow(
      /expected/,
    );
  });
});
