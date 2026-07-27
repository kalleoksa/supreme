import type { BoardState } from '../sim/BoardState.js';
import { SimEventKind, type EventBuffer } from '../sim/events.js';

/**
 * The riding HUD.
 *
 * Plain DOM, not a UI framework: this is a handful of text nodes and a bar, and a
 * framework would cost bundle size and put its own render scheduler in competition
 * with requestAnimationFrame for no benefit.
 *
 * Every value is cached and only written when the rendered string actually changes.
 * Writing text nodes at 120 Hz is layout thrash in service of information no human
 * can read at that rate.
 */
export class Hud {
  readonly root: HTMLElement;

  private readonly speedEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly edgeFill: HTMLElement;
  private readonly airEl: HTMLElement;
  private readonly pumpEl: HTMLElement;

  private lastSpeed = '';
  private lastTime = '';
  private lastEdge = -1;
  private lastAir = '';
  private pumpTimer = 0;
  private pumpFrames = 0;

  /** Seconds the pump flash and its label stay up. */
  private static readonly FLASH_TIME = 0.55;
  /**
   * Minimum frames the flash survives, regardless of elapsed time.
   *
   * The duration alone is measured against real frame time, so on a machine hitching
   * at a few frames per second the whole flash can come and go inside two frames --
   * and this flash is the *only* signal that the pump exists. A frame floor costs one
   * counter and guarantees it is always seen.
   */
  private static readonly FLASH_MIN_FRAMES = 6;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud-root';
    this.root.innerHTML = `
      <div class="hud-speed"><span class="hud-speed-value">0</span><span class="hud-unit">km/h</span></div>
      <div class="hud-time">0.00</div>
      <div class="hud-air"></div>
      <div class="hud-pump">PUMP</div>
      <div class="hud-edge"><div class="hud-edge-fill"></div></div>
    `;
    parent.appendChild(this.root);

    this.speedEl = this.root.querySelector('.hud-speed-value') as HTMLElement;
    this.timeEl = this.root.querySelector('.hud-time') as HTMLElement;
    this.edgeFill = this.root.querySelector('.hud-edge-fill') as HTMLElement;
    this.airEl = this.root.querySelector('.hud-air') as HTMLElement;
    this.pumpEl = this.root.querySelector('.hud-pump') as HTMLElement;
  }

  /**
   * Drain simulation events. Called before `update`, once per frame.
   *
   * The pump flash is the entire teaching mechanism for the carve reward. Nothing
   * tells the player that releasing an edge onto the fall line pays back speed --
   * they have to notice the bar flash at the same moment the speed stops dropping,
   * and connect the two. A mechanic nobody notices does not exist, so this is not
   * decoration.
   */
  drain(events: EventBuffer): void {
    events.forEach((e) => {
      if (e.kind === SimEventKind.PumpBoost) {
        this.pumpTimer = Hud.FLASH_TIME;
        this.pumpFrames = Hud.FLASH_MIN_FRAMES;
      }
    });
  }

  update(state: BoardState, dt: number): void {
    const kmh = Math.round(Math.hypot(state.vel.x, state.vel.z) * 3.6);
    const speed = String(kmh);
    if (speed !== this.lastSpeed) {
      this.speedEl.textContent = speed;
      this.lastSpeed = speed;
    }

    const time = state.time.toFixed(2);
    if (time !== this.lastTime) {
      this.timeEl.textContent = time;
      this.lastTime = time;
    }

    // The edge meter fills while carving. Its job is to teach: a player who reads no
    // manual should still notice the bar and connect it to the speed they keep out of
    // a turn.
    const edge = Math.abs(state.edge);
    const pct = Math.round(edge * 100);
    if (pct !== this.lastEdge) {
      this.edgeFill.style.width = `${pct}%`;
      this.lastEdge = pct;
    }

    if (this.pumpTimer > 0 || this.pumpFrames > 0) {
      this.pumpTimer = Math.max(0, this.pumpTimer - dt);
      this.pumpFrames = Math.max(0, this.pumpFrames - 1);
      this.edgeFill.classList.add('pumped');
      this.pumpEl.classList.add('visible');
      this.edgeFill.classList.remove('skidding');
    } else {
      this.edgeFill.classList.remove('pumped');
      this.pumpEl.classList.remove('visible');
      // Skidding is a warning, not a reward: the colour shift is how a player learns
      // that sliding sideways costs the speed the meter otherwise earns.
      this.edgeFill.classList.toggle('skidding', state.skid > 0.45);
    }

    // Air time, shown only in the air, so it reads as an event rather than clutter.
    const air = state.grounded ? '' : `AIR ${state.airTime.toFixed(1)}s`;
    if (air !== this.lastAir) {
      this.airEl.textContent = air;
      this.lastAir = air;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
