import { approach } from '../core/math.js';
import { ButtonTracker } from './ButtonTracker.js';
import type { InputSource } from './InputSource.js';

/**
 * Default keyboard bindings, by `KeyboardEvent.code`.
 *
 * `code` rather than `key` so the layout does not matter: WASD stays where the
 * fingers are on AZERTY and Dvorak alike.
 *
 * Deliberately not the original game's Ctrl and Alt. Neither ports to the web --
 * browsers and assistive technology intercept both, Alt opens the menu bar on
 * Windows, and Ctrl+key is reserved for browser shortcuts.
 */
const BINDINGS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  tuck: ['ArrowUp', 'KeyW'],
  scrub: ['ArrowDown', 'KeyS'],
  jump: ['Space'],
  carve: ['ShiftLeft', 'ShiftRight'],
  trick: ['KeyK', 'KeyZ'],
  pause: ['Escape'],
  reset: ['KeyR'],
} as const;

/**
 * Rate at which digital keys ramp the steer axis, in units per second.
 *
 * Without a ramp the keyboard snaps instantly to full lock while a stick eases in,
 * which makes the two feel like different games. `boardTuning.STEER_RATE` is the
 * value to tune; this mirrors it.
 */
const STEER_RATE = 6;

export class KeyboardSource implements InputSource {
  readonly id = 'keyboard';

  readonly carve = new ButtonTracker();
  readonly jump = new ButtonTracker();
  readonly trick = new ButtonTracker();

  steerX = 0;
  steerY = 0;
  active = false;

  private readonly down = new Set<string>();
  private pauseRequested = false;
  private resetRequested = false;
  private lastPoll = 0;
  private started = false;

  constructor(private readonly target: EventTarget = window) {
    target.addEventListener('keydown', this.onKeyDown as EventListener);
    target.addEventListener('keyup', this.onKeyUp as EventListener);
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Space scrolls the page and arrows scroll it too; both would fight the game.
    if (isBound(e.code)) e.preventDefault();
    if (e.repeat) return;

    this.down.add(e.code);
    this.active = true;
    const now = performance.now() / 1000;

    if (BINDINGS.jump.includes(e.code as never)) this.jump.press(now);
    if (BINDINGS.carve.includes(e.code as never)) this.carve.press(now);
    if (BINDINGS.trick.includes(e.code as never)) this.trick.press(now);
    if (BINDINGS.pause.includes(e.code as never)) this.pauseRequested = true;
    if (BINDINGS.reset.includes(e.code as never)) this.resetRequested = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (isBound(e.code)) e.preventDefault();
    this.down.delete(e.code);
    const now = performance.now() / 1000;

    if (BINDINGS.jump.includes(e.code as never)) this.jump.release(now);
    if (BINDINGS.carve.includes(e.code as never)) this.carve.release(now);
    if (BINDINGS.trick.includes(e.code as never)) this.trick.release(now);
  };

  /**
   * Losing focus mid-input would otherwise leave a key held forever -- the keyup
   * never arrives, so the rider carves into a wall until the player clicks back and
   * taps the key again.
   */
  private onBlur = (): void => {
    this.down.clear();
    this.carve.reset();
    this.jump.reset();
    this.trick.reset();
    this.steerX = 0;
    this.steerY = 0;
  };

  poll(now: number): void {
    const dt = this.started ? Math.min(Math.max(now - this.lastPoll, 0), 0.25) : 0;
    this.started = true;
    this.lastPoll = now;

    this.steerX = approach(this.steerX, this.axis(BINDINGS.left, BINDINGS.right), STEER_RATE * dt);
    this.steerY = approach(this.steerY, this.axis(BINDINGS.scrub, BINDINGS.tuck), STEER_RATE * dt);
  }

  private axis(negative: readonly string[], positive: readonly string[]): number {
    const neg = negative.some((c) => this.down.has(c)) ? 1 : 0;
    const pos = positive.some((c) => this.down.has(c)) ? 1 : 0;
    return pos - neg;
  }

  takePause(): boolean {
    const v = this.pauseRequested;
    this.pauseRequested = false;
    return v;
  }

  takeReset(): boolean {
    const v = this.resetRequested;
    this.resetRequested = false;
    return v;
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener);
    window.removeEventListener('blur', this.onBlur);
  }
}

const ALL_BOUND: ReadonlySet<string> = new Set(Object.values(BINDINGS).flat());

function isBound(code: string): boolean {
  return ALL_BOUND.has(code);
}

export { BINDINGS as KEYBOARD_BINDINGS };
