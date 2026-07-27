import { describe, expect, it } from 'vitest';
import { ButtonTracker } from '../../src/input/ButtonTracker.js';
import { quantizeDir } from '../../src/input/InputState.js';

function latch(): { held: boolean; pressed: boolean; released: boolean } {
  return { held: false, pressed: false, released: false };
}

describe('ButtonTracker', () => {
  it('reports a press on the tick its timestamp falls in', () => {
    const b = new ButtonTracker();
    const out = latch();

    b.press(1.0);
    // A tick that ends before the press must not see it.
    b.sampleForTick(out, 0.9);
    expect(out).toEqual({ held: false, pressed: false, released: false });

    b.sampleForTick(out, 1.05);
    expect(out).toEqual({ held: true, pressed: true, released: false });

    // Held persists without re-firing the edge.
    b.sampleForTick(out, 1.1);
    expect(out).toEqual({ held: true, pressed: false, released: false });
  });

  it('never drops a press and release that happen inside one frame', () => {
    // The case that matters most. At 30 fps display and 120 Hz sim, a 5 ms tap sits
    // entirely inside one frame. Sampling "current state per tick" would miss it
    // completely -- and a missed tap is a missed jump.
    const b = new ButtonTracker();
    const out = latch();

    b.press(1.001);
    b.release(1.006);

    const seen: string[] = [];
    for (let k = 0; k < 4; k++) {
      b.sampleForTick(out, 1.0 + (k + 1) / 120);
      if (out.pressed) seen.push('press');
      if (out.released) seen.push('release');
    }
    expect(seen).toEqual(['press', 'release']);
  });

  it('never puts a press and its release on the same tick', () => {
    // The charge state machine should always see a clean open-then-close, so it never
    // has to special-case a zero-length charge.
    const b = new ButtonTracker();
    const out = latch();
    b.press(1.0);
    b.release(1.0);

    b.sampleForTick(out, 2);
    expect(out.pressed).toBe(true);
    expect(out.released).toBe(false);

    b.sampleForTick(out, 2);
    expect(out.pressed).toBe(false);
    expect(out.released).toBe(true);
  });

  it('fires exactly one press per physical press, ignoring auto-repeat', () => {
    const b = new ButtonTracker();
    const out = latch();
    b.press(1.0);
    b.press(1.0); // key auto-repeat
    b.press(1.0);

    let presses = 0;
    for (let k = 0; k < 8; k++) {
      b.sampleForTick(out, 2);
      if (out.pressed) presses++;
    }
    expect(presses).toBe(1);
  });

  it('ignores a release when the button was never down', () => {
    const b = new ButtonTracker();
    const out = latch();
    b.release(1.0);
    b.sampleForTick(out, 2);
    expect(out.released).toBe(false);
    expect(out.held).toBe(false);
  });

  it('preserves the order and count of a rapid burst', () => {
    const b = new ButtonTracker();
    const out = latch();
    for (let i = 0; i < 5; i++) {
      b.press(1 + i * 0.002);
      b.release(1 + i * 0.002 + 0.001);
    }

    const seen: string[] = [];
    for (let k = 0; k < 40; k++) {
      b.sampleForTick(out, 3);
      if (out.pressed) seen.push('P');
      if (out.released) seen.push('R');
    }
    expect(seen.join('')).toBe('PRPRPRPRPR');
    expect(b.hasPending).toBe(false);
  });

  it('applies edges that arrived before the current window without waiting', () => {
    // Happens whenever a frame runs zero steps: the edge is already in the past by
    // the time any tick asks for it, and must not be stranded.
    const b = new ButtonTracker();
    const out = latch();
    b.press(1.0);
    b.sampleForTick(out, 50);
    expect(out.pressed).toBe(true);
  });

  it('bounds the queue rather than growing without limit', () => {
    const b = new ButtonTracker();
    for (let i = 0; i < 200; i++) {
      b.press(i);
      b.release(i + 0.5);
    }
    const out = latch();
    let drained = 0;
    while (b.hasPending && drained < 1000) {
      b.sampleForTick(out, 1e9);
      drained++;
    }
    // 32 is the cap; the exact number matters less than it being bounded.
    expect(drained).toBeLessThanOrEqual(32);
  });

  it('reset() clears held state, for focus loss', () => {
    // Without this a keyup lost to a window blur leaves the rider carving forever.
    const b = new ButtonTracker();
    const out = latch();
    b.press(1.0);
    b.sampleForTick(out, 2);
    expect(out.held).toBe(true);

    b.reset();
    b.sampleForTick(out, 3);
    expect(out.held).toBe(false);
    expect(b.isPhysicallyDown).toBe(false);
    expect(b.hasPending).toBe(false);
  });

  it('converges simulated state to physical state once drained', () => {
    const b = new ButtonTracker();
    const out = latch();
    b.press(1.0);
    b.release(1.1);
    b.press(1.2);

    for (let k = 0; k < 10; k++) b.sampleForTick(out, 5);
    expect(out.held).toBe(b.isPhysicallyDown);
    expect(out.held).toBe(true);
  });
});

describe('quantizeDir', () => {
  it('has a deadzone so a resting stick picks no trick direction', () => {
    expect(quantizeDir(0)).toBe(0);
    expect(quantizeDir(0.3)).toBe(0);
    expect(quantizeDir(-0.3)).toBe(0);
    expect(quantizeDir(0.5)).toBe(1);
    expect(quantizeDir(-0.5)).toBe(-1);
  });
});
