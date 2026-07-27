import { describe, expect, it } from 'vitest';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { SurfaceId, TerrainFlag } from '../../src/sim/Terrain.js';
import { ProgressField } from '../../src/race/ProgressField.js';
import {
  DEFAULT_RULES,
  formatDelta,
  formatRaceTime,
  Race,
  RaceState,
} from '../../src/race/Race.js';
import {
  createBoardState,
  FailReason,
  resetBoardState,
  type BoardState,
} from '../../src/sim/BoardState.js';
import { EventBuffer, SimEventKind } from '../../src/sim/events.js';
import { buildTestSlope } from '../../src/track/testSlope.js';
import { v3, type Vec2 } from '../../src/core/vec3.js';

const DT = 1 / 120;

/**
 * A straight corridor descending along +Z, `halfWidth` metres either side of x = 0.
 *
 * Deliberately synthetic: the field's job is to make the routing answers checkable by
 * hand, so the corridor is a rectangle and the geodesic distance to the finish is
 * (almost exactly) the metres remaining down the hill.
 */
function corridor(
  lengthMetres: number,
  widthMetres: number,
  halfWidth: number,
  grade = 0.2,
): Heightfield {
  const cols = widthMetres + 1;
  const rows = lengthMetres + 1;
  const heights = new Float32Array(cols * rows);
  const surfaces = new Uint8Array(cols * rows).fill(SurfaceId.Groomed);
  const flags = new Uint8Array(cols * rows);
  const originX = -widthMetres / 2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = originX + i;
      heights[j * cols + i] = 400 - grade * j;
      if (Math.abs(x) <= halfWidth) flags[j * cols + i] = TerrainFlag.InCorridor;
    }
  }
  return new Heightfield({
    cols,
    rows,
    spacing: 1,
    originX,
    originZ: 0,
    heights,
    surfaces,
    flags,
  });
}

function fieldFor(field: Heightfield, finishZ: number, halfWidth: number): ProgressField {
  return new ProgressField(field, {
    finish: [
      { x: -halfWidth, z: finishZ },
      { x: halfWidth, z: finishZ },
    ],
  });
}

describe('ProgressField on a straight corridor', () => {
  const LENGTH = 400;
  const HALF = 40;
  const field = corridor(LENGTH, 200, HALF);
  const progress = fieldFor(field, LENGTH - 20, HALF);

  it('finds the finish reachable from the start', () => {
    // The single most valuable assertion in the file: it catches "the route is broken"
    // for any future track without anyone having to play it.
    expect(progress.reachable).toBe(true);
    expect(progress.progressAt(0, 5)).toBeGreaterThan(0);
  });

  it('increases monotonically down the corridor', () => {
    let last = -1;
    for (let z = 2; z <= LENGTH - 22; z += 4) {
      const p = progress.progressAt(0, z);
      expect(p, `progress at z=${z}`).toBeGreaterThan(last);
      last = p;
    }
  });

  it('reaches 1 at the finish line and stays high past it', () => {
    expect(progress.progressAt(0, LENGTH - 20)).toBeCloseTo(1, 2);
    // Runout past the line is still close to the finish geodesically, so progress must
    // not collapse -- a rider coasting through must not read as having gone backwards.
    expect(progress.progressAt(0, LENGTH - 10)).toBeGreaterThan(0.9);
  });

  it('measures geodesic distance, so it matches metres remaining on a straight run', () => {
    // 300 m from the line, along a corridor with no obstacles: the flood should agree
    // with a ruler to within a cell.
    const p = progress.progressAt(0, LENGTH - 320);
    const remaining = (1 - p) * progress.maxDistance;
    expect(remaining).toBeGreaterThan(300 - progress.cell * 2);
    expect(remaining).toBeLessThan(300 + progress.cell * 2);
  });

  it('signs the bounds distance: positive inside, negative outside', () => {
    expect(progress.oobDistanceAt(0, 200)).toBeGreaterThan(20);
    expect(progress.isInCorridor(0, 200)).toBe(true);
    expect(progress.oobDistanceAt(HALF + 25, 200)).toBeLessThan(0);
    expect(progress.isInCorridor(HALF + 25, 200)).toBe(false);
    // Roughly zero on the boundary itself.
    expect(Math.abs(progress.oobDistanceAt(HALF, 200))).toBeLessThan(progress.cell * 2);
  });

  it('points down-course from the gradient', () => {
    const out: Vec2 = { x: 0, z: 0 };
    progress.directionToFinish(0, 200, out);
    expect(out.z).toBeGreaterThan(0.9);
    expect(Math.abs(out.x)).toBeLessThan(0.2);
  });

  it('reports unreachable when the corridor is walled off', () => {
    // Block the corridor completely a third of the way down.
    const blocked = corridor(LENGTH, 200, HALF);
    for (let j = 150; j < 160; j++) {
      for (let i = 0; i < blocked.cols; i++) blocked.flagBytes[j * blocked.cols + i] = 0;
    }
    const walled = fieldFor(blocked, LENGTH - 20, HALF);
    // The flood still succeeds below the wall, but the start cannot be reached.
    expect(walled.progressAt(0, 5)).toBe(0);
    expect(walled.progressAt(0, LENGTH - 40)).toBeGreaterThan(0);
  });

  it('does not cut diagonally through a corner', () => {
    // Two corridors offset by a diagonal pinch: a field that cut corners would report a
    // shorter path than one that respects the mask, so this pins the neighbour rule.
    const notched = corridor(200, 100, 40);
    for (let j = 100; j < 104; j++) {
      for (let i = 0; i < notched.cols; i++) {
        const x = notched.originX + i;
        // Leave only a narrow slot at the far right.
        if (x < 20) notched.flagBytes[j * notched.cols + i] = 0;
      }
    }
    const pinched = fieldFor(notched, 180, 40);
    // Going through the slot is genuinely longer than the straight line.
    const straightLine = 180 - 20;
    const detour = (1 - pinched.progressAt(0, 20)) * pinched.maxDistance;
    expect(detour).toBeGreaterThan(straightLine);
  });
});

describe('ProgressField on the test slope', () => {
  const slope = buildTestSlope();
  const progress = new ProgressField(slope.field, { finish: slope.finish });

  it('is reachable end to end', () => {
    expect(progress.reachable).toBe(true);
    expect(progress.progressAt(slope.startX, slope.startZ)).toBeGreaterThan(0);
    expect(progress.progressAt(slope.startX, slope.startZ)).toBeLessThan(0.1);
  });

  it('increases all the way down the centreline', () => {
    let last = -1;
    for (let z = 10; z < 1160; z += 10) {
      const p = progress.progressAt(0, z);
      expect(p, `centreline progress at z=${z}`).toBeGreaterThan(last);
      last = p;
    }
  });

  it('puts the far shoulders out of bounds and the whole corridor in', () => {
    expect(progress.isInCorridor(0, 500)).toBe(true);
    expect(progress.isInCorridor(115, 500)).toBe(true);
    expect(progress.isInCorridor(180, 500)).toBe(false);
  });

  describe('split isolines', () => {
    // These are what the split banners are built from, so a broken isoline is a banner
    // standing somewhere the split does not trigger.
    it('spans the corridor at each threshold', () => {
      for (const threshold of DEFAULT_RULES.splits) {
        const line = progress.isoline(threshold);
        expect(line.length, `isoline at p=${threshold}`).toBeGreaterThan(10);
        // Every point sits on the isoline, in bounds.
        for (const p of line) {
          expect(progress.progressAt(p.x, p.z)).toBeCloseTo(threshold, 2);
          expect(progress.isInCorridor(p.x, p.z)).toBe(true);
        }
        // And it crosses the middle of the course.
        expect(Math.min(...line.map((p) => p.x))).toBeLessThan(-60);
        expect(Math.max(...line.map((p) => p.x))).toBeGreaterThan(60);
      }
    });

    it('places later splits further down the hill', () => {
      const zs = DEFAULT_RULES.splits.map((threshold) => {
        const line = progress.isoline(threshold);
        const centre = line.reduce((best, p) => (Math.abs(p.x) < Math.abs(best.x) ? p : best));
        return centre.z;
      });
      for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeGreaterThan(zs[i - 1]);
    });

    it('returns nothing for a threshold beyond the course', () => {
      expect(progress.isoline(1.5)).toHaveLength(0);
    });
  });
});

// --- Race -------------------------------------------------------------------------

const spawnNormal = v3();

interface Harness {
  race: Race;
  board: BoardState;
  field: Heightfield;
  events: EventBuffer;
  /** Step the race with the board teleported along the corridor at `speed` m/s. */
  drive(seconds: number, speed: number, x?: number): void;
  place(x: number, z: number): void;
}

function harness(halfWidth = 40, length = 400): Harness {
  const field = corridor(length, 200, halfWidth);
  const progressField = fieldFor(field, length - 20, halfWidth);
  const board = createBoardState();
  const events = new EventBuffer(256);

  const place = (x: number, z: number): void => {
    field.normal(x, z, spawnNormal);
    resetBoardState(board, x, field.height(x, z) + 0.06, z, Math.PI / 2, 10, spawnNormal);
  };
  place(0, 4);

  const race = new Race(progressField, {
    x: 0,
    y: field.height(0, 4) + 0.06,
    z: 4,
    yaw: Math.PI / 2,
  });

  const drive = (seconds: number, speed: number, x = board.pos.x): void => {
    const steps = Math.round(seconds / DT);
    const resetsAtStart = race.resets;
    for (let i = 0; i < steps; i++) {
      const frozen = race.prepare(DT);
      if (!frozen) {
        board.pos.x = x;
        board.pos.z += speed * DT;
        board.pos.y = field.height(board.pos.x, board.pos.z) + 0.06;
        board.vel.x = 0;
        board.vel.z = speed;
        board.tick++;
      }
      race.observe(board, field, DT, events);
      // A recovery moves the board, and this harness teleports it: continuing would
      // drag the rider straight back to the position that triggered the recovery. The
      // real game hands control back to the physics here, so stop driving.
      if (race.resets !== resetsAtStart) return;
    }
  };

  return { race, board, field, events, drive, place };
}

describe('Race countdown', () => {
  it('holds the board still until the count expires, then starts the clock at zero', () => {
    const h = harness();
    expect(h.race.state).toBe(RaceState.Countdown);
    expect(h.race.prepare(DT)).toBe(true);
    expect(h.race.time).toBe(0);

    // Two seconds in, still counting.
    for (let i = 0; i < 240; i++) h.race.prepare(DT);
    expect(h.race.state).toBe(RaceState.Countdown);
    expect(h.race.countdown).toBeGreaterThan(0.9);
    expect(h.race.time).toBe(0);

    // Past three seconds, running.
    for (let i = 0; i < 130; i++) h.race.prepare(DT);
    expect(h.race.state).toBe(RaceState.Running);
    expect(h.race.countdown).toBe(0);
    expect(h.race.time).toBeGreaterThan(0);
    expect(h.race.time).toBeLessThan(0.2);
  });

  it('does not record progress or splits during the count', () => {
    const h = harness();
    h.place(0, 300);
    for (let i = 0; i < 60; i++) {
      h.race.prepare(DT);
      h.race.observe(h.board, h.field, DT, h.events);
    }
    expect(h.race.progress).toBe(0);
    expect(h.race.splitTimes.every((t) => t < 0)).toBe(true);
  });
});

describe('Race splits', () => {
  it('records them in order, at ascending times', () => {
    const h = harness();
    h.drive(3.2, 0); // burn the countdown
    h.drive(60, 25);

    expect(h.race.splitTimes.every((t) => t >= 0)).toBe(true);
    for (let i = 1; i < h.race.splitTimes.length; i++) {
      expect(h.race.splitTimes[i]).toBeGreaterThan(h.race.splitTimes[i - 1]);
    }
  });

  it('emits one checkpoint event per split, carrying the index and time', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(60, 25);

    const checkpoints = h.events.pending.filter((e) => e.kind === SimEventKind.Checkpoint);
    expect(checkpoints).toHaveLength(DEFAULT_RULES.splits.length);
    checkpoints.forEach((e, i) => {
      expect(e.a).toBe(i);
      expect(e.b).toBeCloseTo(h.race.splitTimes[i], 6);
    });
  });

  it('does not re-award a split when the rider bobs back across it', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(6, 25);
    const awarded = h.race.splitTimes.filter((t) => t >= 0).length;
    expect(awarded).toBeGreaterThan(0);
    // Reverse back up the hill and come down again.
    h.drive(3, -25);
    h.drive(4, 25);
    expect(h.race.splitTimes.filter((t) => t >= 0)).toHaveLength(awarded);
  });

  it('compares against a reference run', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(60, 25);
    const mine = h.race.splitTimes[0];
    expect(h.race.splitDelta(0, [mine - 1])).toBeCloseTo(1, 6);
    expect(h.race.splitDelta(0, [mine + 0.5])).toBeCloseTo(-0.5, 6);
    expect(h.race.splitDelta(0, undefined)).toBeUndefined();
    expect(h.race.splitDelta(0, [-1])).toBeUndefined();
  });
});

describe('Race finish', () => {
  it('finishes, stops the clock, and emits the time', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(60, 25);

    expect(h.race.state).toBe(RaceState.Finished);
    expect(h.race.finishTime).toBeGreaterThan(0);

    const finish = h.events.pending.filter((e) => e.kind === SimEventKind.Finish);
    expect(finish).toHaveLength(1);
    expect(finish[0].a).toBeCloseTo(h.race.finishTime, 6);

    // The clock is frozen: further steps must not advance it.
    const at = h.race.time;
    expect(h.race.prepare(DT)).toBe(true);
    expect(h.race.time).toBe(at);
  });

  it('interpolates the crossing inside the step rather than quantizing to it', () => {
    // Two runs at speeds chosen so the crossing lands at different points inside a
    // step. Without sub-frame interpolation both would report a time that is an exact
    // multiple of the timestep, which is the bug this guards.
    const times: number[] = [];
    for (const speed of [25, 25.37, 31.9]) {
      const h = harness();
      h.drive(3.2, 0);
      h.drive(60, speed);
      expect(h.race.state).toBe(RaceState.Finished);
      times.push(h.race.finishTime);
    }
    const quantized = times.filter((t) => Math.abs(t / DT - Math.round(t / DT)) < 1e-6);
    expect(quantized).toHaveLength(0);
  });

  it('reports a time consistent with the distance covered', () => {
    const h = harness();
    h.drive(3.2, 0);
    const startZ = h.board.pos.z;
    h.drive(60, 25);
    // The threshold is one cell short of the line, so allow a cell of slack.
    const expected = (380 - startZ) / 25;
    expect(h.race.finishTime).toBeGreaterThan(expected - h.race.progressField.cell / 25 - 0.05);
    expect(h.race.finishTime).toBeLessThan(expected + h.race.progressField.cell / 25 + 0.05);
  });
});

describe('Race out of bounds', () => {
  it('warns on leaving, clears on returning, and does not reset inside the grace window', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(2, 25, 0); // build a snapshot history on course

    h.drive(2, 25, 90); // outside the 40 m corridor
    expect(h.race.oob).toBe(true);
    expect(h.race.oobTime).toBeGreaterThan(1.9);
    expect(h.race.oobDistance).toBeLessThan(0);
    expect(h.race.resets).toBe(0);
    expect(h.events.pending.some((e) => e.kind === SimEventKind.OutOfBounds)).toBe(true);

    h.drive(0.5, 25, 0);
    expect(h.race.oob).toBe(false);
    expect(h.race.oobTime).toBe(0);
    expect(h.events.pending.some((e) => e.kind === SimEventKind.BackInBounds)).toBe(true);
  });

  it('puts the rider back on course past the grace window, with the clock still running', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(4, 25, 0);
    const progressBefore = h.race.bestProgress;
    const timeBefore = h.race.time;
    const zBefore = h.board.pos.z;

    h.drive(3.4, 25, 90);

    expect(h.race.resets).toBe(1);
    expect(h.race.oob).toBe(false);
    expect(h.board.lastFailReason).toBe(FailReason.OutOfBounds);
    // Back inside the corridor, near where the run was last valid.
    expect(Math.abs(h.board.pos.x)).toBeLessThanOrEqual(40);
    expect(h.race.progressField.isInCorridor(h.board.pos.x, h.board.pos.z)).toBe(true);
    // Within one snapshot interval of the furthest point reached: the buffer runs at
    // 10 Hz, so up to a tenth of a second of riding is given back.
    expect(h.race.progress).toBeLessThanOrEqual(progressBefore);
    expect(progressBefore - h.race.progress).toBeLessThan(0.02);
    // The punishment is the clock, and the clock kept running: three seconds elapsed
    // and the rider is back where they were before the excursion, not further down.
    expect(h.race.time).toBeGreaterThan(timeBefore + 2.9);
    expect(h.board.pos.z).toBeLessThanOrEqual(zBefore + 0.5);
    expect(h.board.pos.z).toBeGreaterThan(zBefore - 20);
  });

  it('falls back to the start gate when there is no valid history', () => {
    const h = harness();
    h.drive(3.2, 0);
    // Straight off the side from the first step, so nothing was ever snapshotted.
    h.drive(3.4, 25, 90);
    expect(h.race.resets).toBe(1);
    expect(h.board.pos.x).toBeCloseTo(0, 6);
    expect(h.board.pos.z).toBeCloseTo(4, 6);
  });

  it('gives the rider a return direction while out of bounds', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(1, 25, 90);
    const out: Vec2 = { x: 0, z: 0 };
    h.race.progressField.directionToFinish(h.board.pos.x, h.board.pos.z, out);
    // The gradient off the right-hand shoulder must have a component back toward x = 0.
    expect(out.x).toBeLessThanOrEqual(0);
  });

  it('treats leaving the heightfield entirely as out of bounds', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.board.pos.x = 5000;
    h.race.observe(h.board, h.field, DT, h.events);
    expect(h.race.oob).toBe(true);
    expect(h.race.oobDistance).toBeLessThan(0);
  });
});

describe('Race wrong way and sanity checks', () => {
  it('reads alignment as +1 down-course and -1 backwards', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(1, 25);
    expect(h.race.headingAlignment(h.board)).toBeGreaterThan(0.9);
    h.board.vel.z = -25;
    expect(h.race.headingAlignment(h.board)).toBeLessThan(-0.9);
    // A stationary rider is not going the wrong way.
    h.board.vel.x = 0;
    h.board.vel.z = 0;
    expect(h.race.headingAlignment(h.board)).toBe(1);
  });

  it('does not flag a normally ridden run', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(60, 25);
    expect(h.race.flaggedJumps).toBe(0);
  });

  it('flags a progress jump no board could have ridden', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(1, 25);
    h.board.pos.z += 200;
    h.race.observe(h.board, h.field, DT, h.events);
    expect(h.race.flaggedJumps).toBe(1);
  });

  it('does not flag its own recovery teleport', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(4, 25, 0);
    h.drive(3.4, 25, 90);
    expect(h.race.resets).toBe(1);
    const flaggedAfterReset = h.race.flaggedJumps;
    h.drive(1, 25, 0);
    expect(h.race.flaggedJumps).toBe(flaggedAfterReset);
  });
});

describe('Race reset', () => {
  it('returns to the start gate state', () => {
    const h = harness();
    h.drive(3.2, 0);
    h.drive(60, 25);
    expect(h.race.state).toBe(RaceState.Finished);

    h.race.reset();
    expect(h.race.state).toBe(RaceState.Countdown);
    expect(h.race.time).toBe(0);
    expect(h.race.countdown).toBe(DEFAULT_RULES.countdown);
    expect(h.race.finishTime).toBe(-1);
    expect(h.race.bestProgress).toBe(0);
    expect(h.race.splitTimes.every((t) => t < 0)).toBe(true);

    // And it can be raced again.
    h.place(0, 4);
    h.drive(3.2, 0);
    h.drive(60, 25);
    expect(h.race.state).toBe(RaceState.Finished);
  });
});

describe('time formatting', () => {
  it('reads like a stopwatch', () => {
    expect(formatRaceTime(0)).toBe('0:00.00');
    expect(formatRaceTime(9.5)).toBe('0:09.50');
    expect(formatRaceTime(83.456)).toBe('1:23.46');
    expect(formatRaceTime(-1)).toBe('--:--.--');
    expect(formatRaceTime(Number.NaN)).toBe('--:--.--');
  });

  it('signs a delta both ways', () => {
    expect(formatDelta(1.235)).toBe('+1.24');
    expect(formatDelta(-0.31)).toBe('-0.31');
    expect(formatDelta(0)).toBe('+0.00');
  });
});
