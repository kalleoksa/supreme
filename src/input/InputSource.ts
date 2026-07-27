import type { ButtonTracker } from './ButtonTracker.js';

/**
 * A backend that can drive the game.
 *
 * Keyboard and gamepad implement this now; a `TouchSource` for phones and a
 * `ReplaySource` for ghost playback implement it later without the simulation, the
 * camera or the HUD knowing anything changed. That is the seam that makes the
 * mobile port content-and-UI work rather than an architecture change.
 */
export interface InputSource {
  readonly id: string;

  /** True when this backend has seen activity, so the router can prefer it. */
  readonly active: boolean;

  /** Read hardware state once per frame. Called before any sim steps. */
  poll(now: number): void;

  /** Current steer axes, -1..1. Sampled per tick. */
  readonly steerX: number;
  readonly steerY: number;

  readonly carve: ButtonTracker;
  readonly jump: ButtonTracker;
  readonly trick: ButtonTracker;

  /** Consume a one-shot pause request. */
  takePause(): boolean;
  /** Consume a one-shot reset request. */
  takeReset(): boolean;

  dispose(): void;
}
