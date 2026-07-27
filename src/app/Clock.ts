/**
 * Time source. The real one reads performance.now; the fake one is driven by
 * tests, which is how "does this behave identically at 30 fps?" becomes an
 * assertion rather than a hope.
 */
export interface Clock {
  /** Seconds. Monotonic. Origin is arbitrary. */
  now(): number;
}

export class RealClock implements Clock {
  now(): number {
    return performance.now() / 1000;
  }
}

export class FakeClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(seconds: number): void {
    this.t += seconds;
  }

  /** Advance by one frame at a given display rate, e.g. advanceFrames(1, 30). */
  advanceFrames(frames: number, fps: number): void {
    this.t += frames / fps;
  }
}
