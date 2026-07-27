import type { ButtonLatch } from './InputState.js';

interface Edge {
  down: boolean;
  /** Seconds, on the same clock the loop uses. */
  time: number;
}

/**
 * Collects raw button edges and hands them out one per simulation tick.
 *
 * This exists because the display and the simulation run at different rates. rAF
 * may fire at 30 Hz while the sim steps at 120 Hz, so a frame can contain a whole
 * press-and-release that a naive "sample the current state each tick" reader would
 * miss entirely. For a game whose core mechanic is *releasing* the jump at the
 * right instant, and whose safety valve is a mid-air tap, silently dropping short
 * taps would be fatal.
 *
 * The rule is: **at most one edge per tick.** That single constraint gives three
 * properties for free:
 *
 *  - No edge is ever dropped. Leftovers roll into the next tick, or the next frame.
 *  - A press and its release never land on the same tick, so the charge state
 *    machine always sees a clean open-then-close and never a zero-length charge it
 *    has to special-case.
 *  - Every physical press yields exactly one `pressed`, so counting works.
 *
 * Edges are also time-stamped and gated on the tick's own time window, so a release
 * lands in the correct 8.3 ms slot rather than being rounded to the frame boundary.
 * That precision is the difference between the lip timing feeling sharp and feeling
 * arbitrary on a slow display.
 */
export class ButtonTracker {
  /** Physical state, updated the instant the browser tells us. */
  private physical = false;
  /** Simulated state, which lags physical while edges drain. */
  private simulated = false;
  private readonly queue: Edge[] = [];

  /**
   * Cap the backlog. A stuck key or a pathological input storm should degrade to
   * dropping ancient edges rather than growing without bound; 32 is far more than
   * any human can generate inside one frame.
   */
  private static readonly MAX_QUEUE = 32;

  /** Report a physical press. Ignores auto-repeat (a press while already down). */
  press(time: number): void {
    if (this.physical) return;
    this.physical = true;
    this.enqueue({ down: true, time });
  }

  release(time: number): void {
    if (!this.physical) return;
    this.physical = false;
    this.enqueue({ down: false, time });
  }

  /** Forget everything. For focus loss, where held keys can never be released. */
  reset(): void {
    this.physical = false;
    this.simulated = false;
    this.queue.length = 0;
  }

  private enqueue(edge: Edge): void {
    if (this.queue.length >= ButtonTracker.MAX_QUEUE) this.queue.shift();
    this.queue.push(edge);
  }

  /**
   * Resolve this button for one tick covering `[tickStart, tickEnd)`.
   *
   * Applies at most one queued edge whose timestamp has arrived. Edges older than
   * the window (which happens when a frame ran no steps at all) are applied
   * immediately rather than waiting.
   */
  sampleForTick(out: ButtonLatch, tickEnd: number): void {
    let pressed = false;
    let released = false;

    const next = this.queue[0];
    if (next !== undefined && next.time <= tickEnd) {
      this.queue.shift();
      this.simulated = next.down;
      if (next.down) pressed = true;
      else released = true;
    }

    out.held = this.simulated;
    out.pressed = pressed;
    out.released = released;
  }

  /** True while edges are still waiting; used by tests and diagnostics. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  get isPhysicallyDown(): boolean {
    return this.physical;
  }
}
