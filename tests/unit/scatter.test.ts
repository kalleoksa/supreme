import { describe, expect, it } from 'vitest';
import { Obstacles, NO_OBSTACLES, type ObstacleSet } from '../../src/sim/Obstacles.js';
import { generateTrack } from '../../src/track/generate.js';
import { TEST_SLOPE } from '../../src/track/tracks/testSlope.js';
import { createStepContext, stepBoard } from '../../src/sim/Board.js';
import {
  createBoardState,
  FailReason,
  groundSpeed,
  resetBoardState,
  TrickState,
  type BoardState,
} from '../../src/sim/BoardState.js';
import { DEFAULT_TUNING } from '../../src/sim/boardTuning.js';
import { SimEventKind } from '../../src/sim/events.js';
import { createInputState } from '../../src/input/InputState.js';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { SurfaceId } from '../../src/sim/Terrain.js';
import { v3 } from '../../src/core/vec3.js';

const DT = 1 / 120;

function set(points: readonly [number, number, number][]): ObstacleSet {
  const positions = new Float32Array(points.length * 2);
  const radii = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    positions[i * 2] = points[i][0];
    positions[i * 2 + 1] = points[i][1];
    radii[i] = points[i][2];
  }
  return { positions, radii, species: new Uint8Array(points.length), count: points.length };
}

describe('Obstacles grid', () => {
  it('finds an overlap and misses a near miss', () => {
    const o = new Obstacles(set([[10, 20, 0.5]]));
    expect(o.firstHit(10, 20, 0.4)).toBe(0);
    // 0.5 + 0.4 = 0.9 m reach, so 0.95 m away is clear.
    expect(o.firstHit(10.95, 20, 0.4)).toBe(-1);
    expect(o.anyHit(10.2, 20.1, 0.4)).toBe(true);
  });

  it('returns the deepest overlap when two trunks are clipped at once', () => {
    // Squarely inside the second, barely touching the first.
    const o = new Obstacles(
      set([
        [0, 0, 0.5],
        [1.2, 0, 0.5],
      ]),
    );
    expect(o.firstHit(1.2, 0, 0.4)).toBe(1);
    expect(o.firstHit(0, 0, 0.4)).toBe(0);
  });

  it('searches beyond a single cell, so a trunk near a cell edge is still found', () => {
    // Cells are 8 m. Two obstacles far apart put the grid bounds well past one cell, then a
    // query just inside one of them must still hit -- this is the 3x3 neighbourhood working.
    const o = new Obstacles(
      set([
        [0, 0, 0.5],
        [64, 64, 0.5],
        [7.9, 8.1, 0.5],
      ]),
    );
    expect(o.firstHit(7.9, 8.1, 0.4)).toBe(2);
    expect(o.firstHit(8.2, 8.4, 0.3)).toBe(2);
  });

  it('handles a query far outside its bounds', () => {
    const o = new Obstacles(set([[0, 0, 0.5]]));
    expect(o.firstHit(5000, -5000, 1)).toBe(-1);
  });

  it('is empty and safe with no obstacles', () => {
    expect(NO_OBSTACLES.count).toBe(0);
    expect(NO_OBSTACLES.firstHit(0, 0, 1)).toBe(-1);
    expect(new Obstacles(set([])).firstHit(0, 0, 1)).toBe(-1);
  });

  it('finds every obstacle it was given', () => {
    // Guards the counting sort: a bucketing bug loses obstacles silently, and a tree you can
    // ride through is worse than no tree at all.
    const points: [number, number, number][] = [];
    for (let i = 0; i < 400; i++) {
      points.push([(i % 20) * 11 - 100, Math.floor(i / 20) * 13, 0.5]);
    }
    const o = new Obstacles(set(points));
    for (const [x, z] of points) expect(o.firstHit(x, z, 0.2)).toBeGreaterThanOrEqual(0);
  });
});

// --- Collision in the physics step ------------------------------------------------

function flat(size = 200): Heightfield {
  const heights = new Float32Array(size * size);
  const surfaces = new Uint8Array(size * size).fill(SurfaceId.Groomed);
  const flags = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = 300 - 0.2 * j;
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

function spawn(field: Heightfield, speed: number): BoardState {
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

/** Ride straight downhill into a trunk placed `distance` metres ahead. */
function rideInto(speed: number, distance = 20) {
  const field = flat();
  const board = spawn(field, speed);
  const ctx = createStepContext(DEFAULT_TUNING);
  ctx.obstacles = new Obstacles(set([[0, distance, 0.55]]));
  const input = createInputState();

  let crashed = false;
  let scraped = false;
  let contacts = 0;
  for (let i = 0; i < 120 * 6; i++) {
    stepBoard(board, input, field, DT, ctx);
    ctx.events.forEach((e) => {
      // push(kind, tick, a, b, c) -> a is the reason, b the into-speed, c the scrape flag.
      if (e.kind === SimEventKind.Crash && e.a === FailReason.HitObstacle) {
        contacts++;
        if (e.c === 1) scraped = true;
        else crashed = true;
      }
    });
    ctx.events.clear();
    // Stop at the crash rather than riding on. A crashed rider stops moving, so the distance
    // break never fires and the recovery timer would expire before anything was asserted.
    if (crashed) break;
    if (board.pos.z > distance + 6) break;
  }
  return { board, crashed, scraped, contacts };
}

describe('obstacle collision', () => {
  it('does nothing at all without obstacles', () => {
    // The default. Every physics test that predates scatter runs this path, which is what
    // keeps their golden state hash a statement about the ride.
    const field = flat();
    const board = spawn(field, 20);
    const ctx = createStepContext(DEFAULT_TUNING);
    expect(ctx.obstacles.count).toBe(0);
    const input = createInputState();
    for (let i = 0; i < 240; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
    }
    expect(board.lastFailReason).toBe(FailReason.None);
    expect(board.crashTimer).toBe(0);
  });

  it('crashes the run at speed, and names the reason', () => {
    const { board, crashed } = rideInto(20);
    expect(crashed).toBe(true);
    expect(board.lastFailReason).toBe(FailReason.HitObstacle);
    expect(board.crashTimer).toBeGreaterThan(0);
    expect(board.trickState).toBe(TrickState.Crashed);
    expect(groundSpeed(board)).toBeLessThan(4);
  });

  it('only scrapes below the crash threshold, so a clipped tree does not end a good run', () => {
    // The asymmetry is the design. If every contact were a crash the only correct play would
    // be to avoid the trees entirely, and the route choices they exist to create would stop
    // being routes.
    const { board, crashed, scraped } = rideInto(6);
    expect(crashed).toBe(false);
    expect(scraped).toBe(true);
    expect(board.crashTimer).toBe(0);
    expect(board.trickState).not.toBe(TrickState.Crashed);
  });

  it('never leaves the rider inside a trunk', () => {
    const field = flat();
    const board = spawn(field, 18);
    const ctx = createStepContext(DEFAULT_TUNING);
    const obstacles = new Obstacles(set([[0, 20, 0.55]]));
    ctx.obstacles = obstacles;
    const input = createInputState();
    for (let i = 0; i < 120 * 6; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
      const dist = Math.hypot(board.pos.x - 0, board.pos.z - 20);
      // Allowed to touch, never to be inside. A rider left inside re-collides every tick.
      expect(dist, `inside the trunk at tick ${i}`).toBeGreaterThanOrEqual(
        0.55 + DEFAULT_TUNING.BODY_RADIUS - 1e-3,
      );
    }
  });

  it('charges for the impact, not for every tick of contact', () => {
    // The bug this pins was measured: a flat per-tick multiplier compounded while the rider
    // stayed in contact, and the headless bot came down with 8,551 scrape events at a mean
    // speed of 9.1 m/s against 28.5 with no trees. Trees had become a grinder rather than an
    // obstacle. Scaling the penalty by the into-speed means sliding along a trunk is free.
    //
    // Slightly off the fall line, which is the realistic case: a rider brushing a trunk
    // should come out the other side still racing.
    const field = flat();
    const board = spawn(field, 8);
    const ctx = createStepContext(DEFAULT_TUNING);
    ctx.obstacles = new Obstacles(set([[0.7, 14, 0.55]]));
    const input = createInputState();

    let reported = 0;
    for (let i = 0; i < 120 * 8; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.forEach((e) => {
        if (e.kind === SimEventKind.Crash && e.a === FailReason.HitObstacle) reported++;
      });
      ctx.events.clear();
    }
    // A handful of reported contacts, not hundreds.
    expect(reported).toBeLessThan(20);
    // Past the trunk and still carrying speed.
    expect(board.pos.z).toBeGreaterThan(20);
    expect(groundSpeed(board)).toBeGreaterThan(4);
  });

  it('pins a rider who presses squarely into a trunk directly below them', () => {
    // Worth pinning as correct rather than fixing. With the trunk exactly on the fall line the
    // push-out direction is exactly opposite to gravity's pull, so the two cancel and the
    // rider stops -- which is what would happen. Real terrain never has that symmetry, and the
    // headless bot gets past 3,600 trees, so this is a degenerate case and not the norm.
    const field = flat();
    const board = spawn(field, 6);
    const ctx = createStepContext(DEFAULT_TUNING);
    ctx.obstacles = new Obstacles(set([[0, 10, 0.55]]));
    const input = createInputState();
    for (let i = 0; i < 120 * 8; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
    }
    expect(groundSpeed(board)).toBeLessThan(1);
    // Stopped against the trunk, not inside it, and no NaN.
    expect(Number.isFinite(board.pos.x)).toBe(true);
    expect(Math.hypot(board.pos.x, board.pos.z - 10)).toBeGreaterThan(0.9);
  });

  it('deflects rather than stopping dead when clipped off-centre', () => {
    const field = flat();
    const board = spawn(field, 8);
    const ctx = createStepContext(DEFAULT_TUNING);
    // Offset so the rider catches the edge of the trunk.
    ctx.obstacles = new Obstacles(set([[0.8, 20, 0.55]]));
    const input = createInputState();
    for (let i = 0; i < 120 * 6; i++) {
      stepBoard(board, input, field, DT, ctx);
      ctx.events.clear();
      if (board.pos.z > 26) break;
    }
    // Pushed away from the trunk's side, and still descending.
    expect(board.pos.x).toBeLessThan(0);
    expect(board.pos.z).toBeGreaterThan(20);
  });
});

// --- Placement --------------------------------------------------------------------

describe('scatter placement', () => {
  const track = generateTrack(TEST_SLOPE);

  it('places props, deterministically', () => {
    // Measured: 3,628 props across two species.
    expect(track.scatter.length).toBeGreaterThan(2000);
    expect(track.scatter.length).toBeLessThan(6000);
    const again = generateTrack(TEST_SLOPE);
    expect(again.scatter.length).toBe(track.scatter.length);
    expect(again.scatter[100].x).toBe(track.scatter[100].x);
    expect(again.scatter[100].z).toBe(track.scatter[100].z);
  });

  it('does not clear the corridor centre', () => {
    // The design rule most likely to be "tidied up" by someone assuming a racing line should
    // be clear. Trees inside the ridable area are what turn a 240 m wide face into a set of
    // real route choices; a bare corridor makes freedom of line mean only that it is wide.
    const inCorridor = track.scatter.filter((i) => Math.abs(i.x) <= 90);
    expect(inCorridor.length).toBeGreaterThan(20);
    // Measured: the nearest sits 0.2 m off the centreline.
    const nearest = Math.min(...track.scatter.map((i) => Math.abs(i.x)));
    expect(nearest).toBeLessThan(5);
  });

  it('is thinner on the groomed line than off it', () => {
    // Thinner, not bare. Density per unit area is the comparison, since the corridor and the
    // shoulders cover different amounts of ground.
    const corridorArea = 2 * 90 * TEST_SLOPE.lengthMetres;
    const shoulderArea = (TEST_SLOPE.widthMetres - 2 * 90) * TEST_SLOPE.lengthMetres;
    const corridorDensity = track.scatter.filter((i) => Math.abs(i.x) <= 90).length / corridorArea;
    const shoulderDensity = track.scatter.filter((i) => Math.abs(i.x) > 90).length / shoulderArea;
    expect(corridorDensity).toBeGreaterThan(0);
    expect(shoulderDensity).toBeGreaterThan(corridorDensity * 3);
  });

  it('keeps every launch feature clear', () => {
    // A tree in a landing zone punishes the player for doing exactly what the terrain
    // invited, which is the least fair thing a course can do.
    const clearance = TEST_SLOPE.scatter!.launchClearance;
    for (const prop of track.scatter) {
      for (const launch of track.launches) {
        const dx = (prop.x - launch.x) / (launch.radiusX * clearance);
        const dz = (prop.z - launch.z) / (launch.radiusZ * clearance);
        expect(
          dx * dx + dz * dz,
          `prop at ${prop.x.toFixed(1)},${prop.z.toFixed(1)} sits in the launch at z=${launch.z}`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('respects the surface and slope rules of each species', () => {
    const species = TEST_SLOPE.scatter!.species;
    const n = v3();
    for (const prop of track.scatter) {
      const rules = species[prop.speciesIndex];
      expect(rules.surfaces).toContain(track.field.surface(prop.x, prop.z));
      track.field.normal(prop.x, prop.z, n);
      expect(n.y).toBeGreaterThanOrEqual(rules.minNormalY);
    }
  });

  it('sits every prop on the surface', () => {
    for (const prop of track.scatter) {
      expect(prop.y).toBeCloseTo(track.field.height(prop.x, prop.z), 4);
      expect(prop.height).toBeGreaterThan(0.5);
    }
  });

  it('places nothing when the spec has no scatter rules', () => {
    const { scatter: _scatter, ...bare } = TEST_SLOPE;
    const bareTrack = generateTrack(bare);
    expect(bareTrack.scatter).toHaveLength(0);
    expect(bareTrack.obstacles.count).toBe(0);
  });

  it('builds an obstacle grid that agrees with the placement', () => {
    expect(track.obstacles.count).toBe(track.scatter.length);
    for (let i = 0; i < track.scatter.length; i += 37) {
      const prop = track.scatter[i];
      expect(track.obstacles.firstHit(prop.x, prop.z, 0.1)).toBeGreaterThanOrEqual(0);
    }
  });
});
