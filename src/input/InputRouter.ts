import { clamp } from '../core/math.js';
import { clearEdges, createInputState, quantizeDir, type InputState } from './InputState.js';
import type { InputSource } from './InputSource.js';

/**
 * Merges the active backends into one `InputState` per simulation tick.
 *
 * This is the seam. `sampleForTick` is the single place the simulation gets input,
 * so substituting a recorded ghost or a touch backend changes nothing downstream --
 * not the physics, not the camera, not the HUD.
 */
export class InputRouter {
  private readonly state = createInputState();
  private readonly sources: InputSource[] = [];
  /** Tick index at which the current batch began, for time-window gating. */
  private batchStart = 0;
  private lastActiveId = 'keyboard';

  constructor(sources: InputSource[]) {
    this.sources.push(...sources);
  }

  add(source: InputSource): void {
    this.sources.push(source);
  }

  /** Read hardware once per frame, before any steps run. */
  poll(now: number): void {
    this.batchStart = now;
    for (const source of this.sources) source.poll(now);
  }

  /**
   * Resolve input for one tick.
   *
   * `tickIndexInBatch` positions the tick inside the frame so a button edge lands in
   * the correct sub-frame slot rather than being rounded to the frame boundary --
   * which is what makes the ollie's release timing feel sharp on a slow display.
   */
  sampleForTick(tickIndexInBatch: number, dt: number): InputState {
    const state = this.state;
    clearEdges(state);

    const tickEnd = this.batchStart + (tickIndexInBatch + 1) * dt;

    // Axes: sum across sources and clamp, so a player can hold a stick and tap a
    // key without one silently winning. Buttons are OR-ed by the trackers below.
    let steerX = 0;
    let steerY = 0;
    let pause = false;
    let reset = false;

    let carveHeld = false;
    let carvePressed = false;
    let carveReleased = false;
    let jumpHeld = false;
    let jumpPressed = false;
    let jumpReleased = false;
    let trickHeld = false;
    let trickPressed = false;
    let trickReleased = false;

    const scratch = { held: false, pressed: false, released: false };

    for (const source of this.sources) {
      steerX += source.steerX;
      steerY += source.steerY;
      if (source.active) this.lastActiveId = source.id;

      source.carve.sampleForTick(scratch, tickEnd);
      carveHeld = carveHeld || scratch.held;
      carvePressed = carvePressed || scratch.pressed;
      carveReleased = carveReleased || scratch.released;

      source.jump.sampleForTick(scratch, tickEnd);
      jumpHeld = jumpHeld || scratch.held;
      jumpPressed = jumpPressed || scratch.pressed;
      jumpReleased = jumpReleased || scratch.released;

      source.trick.sampleForTick(scratch, tickEnd);
      trickHeld = trickHeld || scratch.held;
      trickPressed = trickPressed || scratch.pressed;
      trickReleased = trickReleased || scratch.released;

      if (source.takePause()) pause = true;
      if (source.takeReset()) reset = true;
    }

    state.steerX = clamp(steerX, -1, 1);
    state.steerY = clamp(steerY, -1, 1);

    state.carve.held = carveHeld;
    state.carve.pressed = carvePressed;
    state.carve.released = carveReleased;
    state.jump.held = jumpHeld;
    state.jump.pressed = jumpPressed;
    state.jump.released = jumpReleased;
    state.trick.held = trickHeld;
    state.trick.pressed = trickPressed;
    state.trick.released = trickReleased;

    // Latch the trick direction at the moment the modifier engages, and hold it.
    // Sampling continuously instead would let the steer axis drifting back toward
    // centre mid-air silently change which trick is being performed -- which is
    // precisely the kind of invisible state change that made the original's trick
    // system feel arbitrary.
    if (state.trick.pressed) {
      state.trickDirX = quantizeDir(state.steerX);
      state.trickDirY = quantizeDir(state.steerY);
    } else if (!state.trick.held) {
      state.trickDirX = 0;
      state.trickDirY = 0;
    }

    state.meta.pause = pause;
    state.meta.reset = reset;

    return state;
  }

  /** Which backend the player last actually used, for HUD prompts. */
  get activeSourceId(): string {
    return this.lastActiveId;
  }

  dispose(): void {
    for (const source of this.sources) source.dispose();
    this.sources.length = 0;
  }
}
