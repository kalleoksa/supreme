/**
 * The one input shape the simulation understands.
 *
 * Keyboard, gamepad, a recorded ghost and a future touch backend all collapse into
 * this struct, so the sim has exactly one input path and nothing downstream knows
 * where a frame's input came from.
 *
 * Three action buttons, one 2D axis. That is the whole verb set and it is a design
 * constraint, not an accident: the minimal control scheme with a high expressive
 * ceiling is the thing most worth preserving from the game this one descends from.
 * In particular, tuck is *not* a fourth button -- it is the vertical steer axis,
 * which is how the original's arrow keys worked and which gets partial tuck for
 * free from an analog stick.
 */
export interface ButtonLatch {
  /** Physically down as of this tick. */
  held: boolean;
  /** A press edge landed on this tick. */
  pressed: boolean;
  /** A release edge landed on this tick. */
  released: boolean;
}

export interface InputState {
  /** -1 = left, +1 = right. */
  steerX: number;
  /** -1 = scrub/brake, +1 = tuck. */
  steerY: number;
  /** Verb 1: the edge state. Held = on edge. */
  carve: ButtonLatch;
  /** Verb 2: hold to charge, release to pop, tap in the air to break a trick. */
  jump: ButtonLatch;
  /** Verb 3: trick modifier; combines with the steer axis to pick a trick. */
  trick: ButtonLatch;
  /** Steer direction sampled when the trick modifier engaged. */
  trickDirX: -1 | 0 | 1;
  trickDirY: -1 | 0 | 1;
  /** Not simulated: these drive the app, not the board. */
  meta: {
    pause: boolean;
    reset: boolean;
  };
}

export function createInputState(): InputState {
  return {
    steerX: 0,
    steerY: 0,
    carve: { held: false, pressed: false, released: false },
    jump: { held: false, pressed: false, released: false },
    trick: { held: false, pressed: false, released: false },
    trickDirX: 0,
    trickDirY: 0,
    meta: { pause: false, reset: false },
  };
}

export function copyInputState(out: InputState, src: InputState): InputState {
  out.steerX = src.steerX;
  out.steerY = src.steerY;
  copyLatch(out.carve, src.carve);
  copyLatch(out.jump, src.jump);
  copyLatch(out.trick, src.trick);
  out.trickDirX = src.trickDirX;
  out.trickDirY = src.trickDirY;
  out.meta.pause = src.meta.pause;
  out.meta.reset = src.meta.reset;
  return out;
}

function copyLatch(out: ButtonLatch, src: ButtonLatch): void {
  out.held = src.held;
  out.pressed = src.pressed;
  out.released = src.released;
}

/** Clear the per-tick edges, keeping held state. */
export function clearEdges(state: InputState): void {
  state.carve.pressed = false;
  state.carve.released = false;
  state.jump.pressed = false;
  state.jump.released = false;
  state.trick.pressed = false;
  state.trick.released = false;
}

export function quantizeDir(v: number, deadzone = 0.4): -1 | 0 | 1 {
  if (v > deadzone) return 1;
  if (v < -deadzone) return -1;
  return 0;
}
