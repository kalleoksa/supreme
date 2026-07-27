import { describe, expect, it } from 'vitest';
import { Loop } from '../../src/app/Loop.js';
import { FakeClock } from '../../src/app/Clock.js';
import { FIXED_DT, MAX_STEPS } from '../../src/app/config.js';

interface Recording {
  loop: Loop;
  clock: FakeClock;
  stepDts: number[];
  renderAlphas: number[];
}

function makeLoop(): Recording {
  const clock = new FakeClock();
  const stepDts: number[] = [];
  const renderAlphas: number[] = [];
  const loop = new Loop(clock, {
    step(_tick, dt) {
      stepDts.push(dt);
    },
    render(alpha) {
      renderAlphas.push(alpha);
    },
  });
  return { loop, clock, stepDts, renderAlphas };
}

describe('Loop fixed timestep', () => {
  it('never varies the simulation timestep', () => {
    const { loop, clock, stepDts } = makeLoop();
    loop.advance();
    for (const fps of [144, 60, 59.94, 30, 24, 17]) {
      for (let f = 0; f < 20; f++) {
        clock.advanceFrames(1, fps);
        loop.advance();
      }
    }
    expect(stepDts.length).toBeGreaterThan(0);
    for (const dt of stepDts) expect(dt).toBe(FIXED_DT);
  });

  it('runs no steps on the very first frame', () => {
    // The first advance() only anchors the clock; simulating an arbitrary origin
    // delta would launch the rider before the player ever saw the game.
    const { loop, stepDts, renderAlphas } = makeLoop();
    loop.advance();
    expect(stepDts).toHaveLength(0);
    expect(renderAlphas).toHaveLength(1);
  });

  it('runs the same number of steps per unit of wall time regardless of frame rate', () => {
    // This is the property that makes an iOS-throttled 30 fps display play the
    // same game as a 144 Hz monitor, only choppier.
    const run = (fps: number, seconds: number): number => {
      const { loop, clock, stepDts } = makeLoop();
      loop.advance();
      const frames = Math.round(fps * seconds);
      for (let f = 0; f < frames; f++) {
        clock.advanceFrames(1, fps);
        loop.advance();
      }
      return stepDts.length;
    };

    const expected = 2 / FIXED_DT;
    for (const fps of [120, 60, 30]) {
      expect(Math.abs(run(fps, 2) - expected)).toBeLessThanOrEqual(2);
    }
  });

  it('runs exactly 4 substeps per frame at 30 fps', () => {
    // The iOS Low Power Mode case, called out explicitly so a change to FIXED_DT
    // or MAX_STEPS that breaks it fails here rather than on a phone.
    const { loop, clock, stepDts } = makeLoop();
    loop.advance();
    clock.advanceFrames(1, 30);
    loop.advance();
    expect(stepDts).toHaveLength(4);
    expect(4).toBeLessThanOrEqual(MAX_STEPS);
  });
});

describe('Loop time-jump protection', () => {
  it('clamps a huge delta instead of replaying it as simulation', () => {
    // A backgrounded tab can hand back a multi-second delta. Simulating it would
    // teleport the rider through the mountain.
    const { loop, clock, stepDts } = makeLoop();
    loop.advance();
    clock.advance(45);
    loop.advance();
    expect(stepDts.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('drops the backlog when starved rather than accumulating debt', () => {
    const { loop, clock, stepDts } = makeLoop();
    loop.advance();

    clock.advance(0.2); // 24 steps' worth, capped at MAX_STEPS
    loop.advance();
    expect(loop.stats.starved).toBe(true);
    expect(stepDts).toHaveLength(MAX_STEPS);

    // The following second must contain a second's worth of simulation and
    // nothing more -- the 16 dropped steps must not come back as a catch-up
    // spike, which would read to the player as a lurch after every hitch.
    const before = stepDts.length;
    for (let f = 0; f < 60; f++) {
      clock.advanceFrames(1, 60);
      loop.advance();
    }
    const stepsInOneSecond = stepDts.length - before;
    expect(Math.abs(stepsInOneSecond - 1 / FIXED_DT)).toBeLessThanOrEqual(2);
    expect(loop.stats.starved).toBe(false);
  });

  it('ignores a clock that goes backwards', () => {
    const { loop, clock, stepDts } = makeLoop();
    loop.advance();
    clock.advance(-5);
    loop.advance();
    expect(stepDts).toHaveLength(0);
  });

  it('resync() drops pending time without simulating it', () => {
    const { loop, clock, stepDts } = makeLoop();
    loop.advance();
    clock.advance(0.004); // less than one step: sits in the accumulator
    loop.advance();
    expect(stepDts).toHaveLength(0);

    loop.resync();
    clock.advanceFrames(1, 120);
    loop.advance();
    // Exactly one step: the leftover 4 ms was discarded, not carried.
    expect(stepDts).toHaveLength(1);
  });
});

describe('Loop render interpolation', () => {
  it('reports alpha in [0, 1)', () => {
    const { loop, clock, renderAlphas } = makeLoop();
    loop.advance();
    for (let f = 0; f < 200; f++) {
      clock.advance(0.001 + Math.random() * 0.03);
      loop.advance();
    }
    for (const a of renderAlphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('renders exactly once per frame even when several steps run', () => {
    const { loop, clock, stepDts, renderAlphas } = makeLoop();
    loop.advance();
    for (let f = 0; f < 10; f++) {
      clock.advanceFrames(1, 30);
      loop.advance();
    }
    expect(renderAlphas).toHaveLength(11);
    expect(stepDts).toHaveLength(40);
  });

  it('advances a monotonic tick counter', () => {
    const { loop, clock } = makeLoop();
    loop.advance();
    expect(loop.stats.tick).toBe(0);
    clock.advance(1);
    loop.advance();
    const after = loop.stats.tick;
    expect(after).toBeGreaterThan(0);
    clock.advance(1);
    loop.advance();
    expect(loop.stats.tick).toBeGreaterThan(after);
  });
});
