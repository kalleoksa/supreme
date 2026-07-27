import { FIXED_DT, MAX_FRAME_DT, MAX_STEPS } from './config.js';
import type { Clock } from './Clock.js';

export interface LoopHandlers {
  /**
   * Advance the simulation by exactly FIXED_DT. Called 0..MAX_STEPS times per
   * frame. `tick` is the monotonic simulation tick index.
   */
  step(tick: number, dt: number): void;

  /**
   * Draw one frame. `alpha` is the fraction of a step remaining in the
   * accumulator, for interpolating between the previous and current sim state --
   * which is what lets a 30 fps display still look smooth.
   */
  render(alpha: number, frameDt: number): void;
}

export interface LoopStats {
  tick: number;
  /** Steps run on the most recent frame. */
  steps: number;
  /** True when the frame hit MAX_STEPS and the sim fell behind wall-clock. */
  starved: boolean;
  frameDt: number;
}

/**
 * Fixed-timestep game loop with an accumulator and render interpolation.
 *
 * The rAF plumbing is deliberately separate from `advance()` so tests can drive
 * the loop with a FakeClock at any simulated frame rate. That is how
 * dt-independence becomes a unit test instead of a manual check.
 */
export class Loop {
  private accumulator = 0;
  private last = 0;
  private started = false;
  private rafId = 0;
  private running = false;

  readonly stats: LoopStats = { tick: 0, steps: 0, starved: false, frameDt: 0 };

  constructor(
    private readonly clock: Clock,
    private readonly handlers: LoopHandlers,
  ) {}

  /**
   * Consume elapsed wall time, run whole simulation steps, then render once.
   * Safe to call directly (tests) or from rAF (the game).
   */
  advance(): void {
    const now = this.clock.now();
    if (!this.started) {
      this.started = true;
      this.last = now;
    }

    // Clamp: a backgrounded tab can produce a multi-second delta, and replaying
    // that as simulation would teleport the rider through the mountain.
    let frameDt = now - this.last;
    this.last = now;
    if (frameDt < 0) frameDt = 0;
    if (frameDt > MAX_FRAME_DT) frameDt = MAX_FRAME_DT;

    this.accumulator += frameDt;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.handlers.step(this.stats.tick, FIXED_DT);
      this.stats.tick++;
      this.accumulator -= FIXED_DT;
      steps++;
    }

    const starved = this.accumulator >= FIXED_DT;
    if (starved) {
      // Fell behind. Drop the backlog rather than accumulating debt: the sim runs
      // in slow motion for a frame, which is recoverable, instead of spiralling.
      this.accumulator = 0;
    }

    this.stats.steps = steps;
    this.stats.starved = starved;
    this.stats.frameDt = frameDt;

    this.handlers.render(this.accumulator / FIXED_DT, frameDt);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const frame = (): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      this.advance();
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * Re-anchor the clock without simulating the gap. Call after a pause, a tab
   * regaining focus, or a WebGL context restore.
   */
  resync(): void {
    this.last = this.clock.now();
    this.accumulator = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
