import { describe, expect, it } from 'vitest';
import { ProgressField } from '../../src/race/ProgressField.js';
import { Race, RaceState } from '../../src/race/Race.js';
import { createStepContext, stepBoard } from '../../src/sim/Board.js';
import { createBoardState, groundSpeed, resetBoardState } from '../../src/sim/BoardState.js';
import { DEFAULT_TUNING } from '../../src/sim/boardTuning.js';
import { SimEventKind } from '../../src/sim/events.js';
import { createInputState } from '../../src/input/InputState.js';
import { buildTestSlope } from '../../src/track/testSlope.js';
import { angleDelta, clamp } from '../../src/core/math.js';
import { v3, type Vec2 } from '../../src/core/vec3.js';

/**
 * A bot rides the whole course, in Node, with no GPU.
 *
 * This is the strongest end-to-end signal the container can produce, and the payoff of
 * keeping the simulation a pure function: board physics, terrain sampling, the geodesic
 * progress field, splits, bounds recovery and the finish all run together for a full
 * 90-second descent. Anything that makes the course unfinishable -- a grade that stalls,
 * a bounds mask that strands the rider, a landing that cannot be survived -- fails here
 * rather than in somebody's play session.
 *
 * The bot is deliberately unsophisticated: point down the negative gradient of the
 * progress field, tuck, and hold on. It is not meant to be good, it is meant to prove
 * the course is ridable by something with no knowledge of it.
 */

const DT = 1 / 120;
const MAX_SECONDS = 150;

interface BotResult {
  finished: boolean;
  time: number;
  splits: number[];
  resets: number;
  flaggedJumps: number;
  crashes: number;
  topSpeed: number;
  meanSpeed: number;
  finalProgress: number;
}

function runBot(): BotResult {
  const slope = buildTestSlope();
  const field = slope.field;
  const progressField = new ProgressField(field, { finish: slope.finish });

  const board = createBoardState();
  const normal = v3();
  field.normal(slope.startX, slope.startZ, normal);
  resetBoardState(
    board,
    slope.startX,
    field.height(slope.startX, slope.startZ) + DEFAULT_TUNING.RIDE_HEIGHT,
    slope.startZ,
    slope.startYaw,
    6,
    normal,
  );

  const race = new Race(progressField, {
    x: slope.startX,
    y: board.pos.y,
    z: slope.startZ,
    yaw: slope.startYaw,
  });
  // Skip the gate: the count is a presentation concern and 360 idle steps prove nothing.
  race.releaseGate();

  const ctx = createStepContext(DEFAULT_TUNING);
  const input = createInputState();
  const dir: Vec2 = { x: 0, z: 0 };

  let crashes = 0;
  let topSpeed = 0;
  let speedSum = 0;
  let samples = 0;

  const steps = Math.round(MAX_SECONDS / DT);
  for (let i = 0; i < steps; i++) {
    progressField.directionToFinish(board.pos.x, board.pos.z, dir);
    if (dir.x !== 0 || dir.z !== 0) {
      const desired = Math.atan2(dir.z, dir.x);
      // Proportional only. A derivative term would make the bot ride better and prove
      // less: the point is that a crude controller gets down, not that a good one does.
      input.steerX = clamp(angleDelta(board.yaw, desired) * 2, -1, 1);
    } else {
      input.steerX = 0;
    }
    // Tuck, but ease off while turning hard -- tucking costs turn rate, and a bot that
    // tucks through everything simply drives into the containment shoulders.
    input.steerY = Math.abs(input.steerX) > 0.5 ? 0 : 1;
    // Carve when the correction is committed enough to be worth an edge.
    input.carve.held = Math.abs(input.steerX) > 0.35;

    if (race.prepare(DT)) break;
    stepBoard(board, input, field, DT, ctx);
    race.observe(board, field, DT, ctx.events);

    ctx.events.forEach((e) => {
      if (e.kind === SimEventKind.Crash) crashes++;
    });
    ctx.events.clear();

    const speed = groundSpeed(board);
    if (speed > topSpeed) topSpeed = speed;
    speedSum += speed;
    samples++;

    if (race.state === RaceState.Finished) break;
  }

  return {
    finished: race.state === RaceState.Finished,
    time: race.finishTime,
    splits: race.splitTimes.slice(),
    resets: race.resets,
    flaggedJumps: race.flaggedJumps,
    crashes,
    topSpeed,
    meanSpeed: samples > 0 ? speedSum / samples : 0,
    finalProgress: race.bestProgress,
  };
}

describe('headless bot run', () => {
  const result = runBot();

  it('gets to the finish', () => {
    // The regression canary for every future terrain edit. If this fails, the course is
    // not ridable and no amount of tuning will hide it.
    expect(result.finished, `stalled at ${(result.finalProgress * 100).toFixed(1)}% progress`).toBe(
      true,
    );
  });

  it('takes a plausible time for a 1.2 km descent', () => {
    // Measured at 40.8 s over 1140 m of course, with splits at 14.1 / 23.4 / 32.1 s.
    // That is a mean of 28.5 m/s against the plan's ~25 m/s target for a 20% grade,
    // which is what tucking most of the way down a 22%-average course should buy.
    //
    // The window is wide on purpose. It is not a tuning assertion -- it exists to catch
    // a course that has turned into either a stall (grade gone too shallow) or a rocket
    // (too steep), and either failure moves this number by far more than a tuning pass
    // would.
    expect(result.time).toBeGreaterThan(25);
    expect(result.time).toBeLessThan(120);
  });

  it('holds a speed the grade profile was tuned for', () => {
    // Measured: mean 28.5 m/s, peak 35.1 m/s, no crashes on the way down.
    expect(result.meanSpeed).toBeGreaterThan(15);
    expect(result.topSpeed).toBeGreaterThan(25);
    expect(result.topSpeed).toBeLessThanOrEqual(DEFAULT_TUNING.MAX_SPEED);
  });

  it('records every split, in order', () => {
    expect(result.splits.every((t) => t >= 0)).toBe(true);
    for (let i = 1; i < result.splits.length; i++) {
      expect(result.splits[i]).toBeGreaterThan(result.splits[i - 1]);
    }
  });

  it('never registers an impossible progress jump', () => {
    expect(result.flaggedJumps).toBe(0);
  });

  it('does not need the boundary to keep it on course', () => {
    // Containment is geometry: the cross profile's rising shoulders are what turn a
    // wandering rider back. A bot that has to be teleported repeatedly means the
    // shoulders are not doing their job, which would be a terrain bug, not a bot one.
    expect(result.resets).toBeLessThanOrEqual(1);
  });
});
