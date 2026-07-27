import { clamp } from '../core/math.js';
import { ButtonTracker } from './ButtonTracker.js';
import type { InputSource } from './InputSource.js';

/** Standard Mapping indices. */
const BTN_A = 0;
const BTN_X = 2;
const BTN_RB = 5;
const BTN_RT = 7;
const BTN_START = 9;
const BTN_BACK = 8;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

const AXIS_LX = 0;
const AXIS_LY = 1;

/** Radial deadzone, then rescale so the usable range still reaches 1.0. */
const DEADZONE = 0.12;
/**
 * Response curve exponent. Above 1 this gives finer control near centre, which is
 * where the small corrections of a held carve live.
 */
const CURVE = 1.4;
/** A trigger past this counts as a press for the digital carve latch. */
const TRIGGER_THRESHOLD = 0.3;

export class GamepadSource implements InputSource {
  readonly id = 'gamepad';

  readonly carve = new ButtonTracker();
  readonly jump = new ButtonTracker();
  readonly trick = new ButtonTracker();

  steerX = 0;
  steerY = 0;
  active = false;

  /**
   * Analog carve engagement, 0..1, from the trigger's travel.
   *
   * The latch says whether the edge is engaged at all; this says how hard. Partial
   * edge is free expressiveness on a pad and there is no keyboard equivalent, so it
   * is exposed separately rather than being folded into the button.
   */
  carveAnalog = 0;

  private index: number | null = null;
  private pauseRequested = false;
  private resetRequested = false;

  constructor() {
    window.addEventListener('gamepadconnected', this.onConnected);
    window.addEventListener('gamepaddisconnected', this.onDisconnected);
  }

  private onConnected = (e: Event): void => {
    const pad = (e as GamepadEvent).gamepad;
    if (pad.mapping === 'standard' || this.index === null) this.index = pad.index;
  };

  private onDisconnected = (e: Event): void => {
    if ((e as GamepadEvent).gamepad.index === this.index) {
      this.index = null;
      this.active = false;
      this.steerX = 0;
      this.steerY = 0;
      this.carveAnalog = 0;
      this.carve.reset();
      this.jump.reset();
      this.trick.reset();
    }
  };

  poll(now: number): void {
    const pad = this.currentPad();
    if (!pad) return;

    const rawX = pad.axes[AXIS_LX] ?? 0;
    // Sticks report -1 as up; the game's steerY is +1 for tuck (forward).
    const rawY = -(pad.axes[AXIS_LY] ?? 0);

    const dpadX = (pressed(pad, BTN_DPAD_RIGHT) ? 1 : 0) - (pressed(pad, BTN_DPAD_LEFT) ? 1 : 0);
    const dpadY = (pressed(pad, BTN_DPAD_UP) ? 1 : 0) - (pressed(pad, BTN_DPAD_DOWN) ? 1 : 0);

    const [ax, ay] = applyRadialDeadzone(rawX, rawY);
    this.steerX = dpadX !== 0 ? dpadX : ax;
    this.steerY = dpadY !== 0 ? dpadY : ay;

    const trigger = axisOrButton(pad, BTN_RT);
    this.carveAnalog = trigger;

    this.edge(this.carve, trigger > TRIGGER_THRESHOLD, now);
    this.edge(this.jump, pressed(pad, BTN_A), now);
    this.edge(this.trick, pressed(pad, BTN_X) || pressed(pad, BTN_RB), now);

    if (pressed(pad, BTN_START)) this.pauseRequested = true;
    if (pressed(pad, BTN_BACK)) this.resetRequested = true;

    if (
      Math.abs(this.steerX) > 0.2 ||
      Math.abs(this.steerY) > 0.2 ||
      trigger > TRIGGER_THRESHOLD ||
      pressed(pad, BTN_A) ||
      pressed(pad, BTN_X)
    ) {
      this.active = true;
    }
  }

  private edge(tracker: ButtonTracker, down: boolean, now: number): void {
    // The Gamepad API has no events, only polled state, so edges are derived here.
    // ButtonTracker ignores redundant presses, so this is safe to call every frame.
    if (down) tracker.press(now);
    else tracker.release(now);
  }

  private currentPad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index !== null) {
      const pad = pads[this.index];
      if (pad) return pad;
    }
    // Recover if we missed the connect event (it does not fire until first input).
    for (const pad of pads) {
      if (pad) {
        this.index = pad.index;
        return pad;
      }
    }
    return null;
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
    window.removeEventListener('gamepadconnected', this.onConnected);
    window.removeEventListener('gamepaddisconnected', this.onDisconnected);
  }
}

function pressed(pad: Gamepad, index: number): boolean {
  return (pad.buttons[index]?.pressed ?? false) || (pad.buttons[index]?.value ?? 0) > 0.5;
}

/** Triggers are analog on most pads and digital on some; handle both. */
function axisOrButton(pad: Gamepad, index: number): number {
  const button = pad.buttons[index];
  if (!button) return 0;
  return button.value > 0 ? clamp(button.value, 0, 1) : button.pressed ? 1 : 0;
}

/**
 * Radial rather than per-axis deadzone.
 *
 * A per-axis deadzone leaves a cross-shaped dead region, so a gentle diagonal lean
 * registers as pure horizontal or pure vertical. On a game where steering and tuck
 * share one stick that shows up as the board refusing to tuck while turning.
 */
function applyRadialDeadzone(x: number, y: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < DEADZONE) return [0, 0];
  const scaled = Math.min((mag - DEADZONE) / (1 - DEADZONE), 1);
  const curved = Math.pow(scaled, CURVE);
  const inv = curved / mag;
  return [clamp(x * inv, -1, 1), clamp(y * inv, -1, 1)];
}
