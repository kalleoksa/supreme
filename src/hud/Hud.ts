import type { BoardState } from '../sim/BoardState.js';

/**
 * The riding HUD.
 *
 * Plain DOM, not a UI framework: this is eight text nodes and a couple of bars, and
 * a framework would cost bundle size and put its own render scheduler in
 * competition with requestAnimationFrame for no benefit.
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

  private lastSpeed = '';
  private lastTime = '';
  private lastEdge = -1;
  private lastAir = '';
  private edgeFlashUntil = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud-root';
    this.root.innerHTML = `
      <div class="hud-speed"><span class="hud-speed-value">0</span><span class="hud-unit">km/h</span></div>
      <div class="hud-time">0.00</div>
      <div class="hud-air"></div>
      <div class="hud-edge"><div class="hud-edge-fill"></div></div>
    `;
    parent.appendChild(this.root);

    this.speedEl = this.root.querySelector('.hud-speed-value') as HTMLElement;
    this.timeEl = this.root.querySelector('.hud-time') as HTMLElement;
    this.edgeFill = this.root.querySelector('.hud-edge-fill') as HTMLElement;
    this.airEl = this.root.querySelector('.hud-air') as HTMLElement;
  }

  update(state: BoardState): void {
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

    // The edge meter fills while carving. Its job is to teach: a player who never
    // reads a manual should still notice the bar and connect it to the speed they
    // keep out of a turn.
    const edge = Math.abs(state.edge);
    const pct = Math.round(edge * 100);
    if (pct !== this.lastEdge) {
      this.edgeFill.style.width = `${pct}%`;
      this.lastEdge = pct;
    }
    const skidding = state.skid > 0.45;
    this.edgeFill.classList.toggle('skidding', skidding);

    // Air time, shown only in the air, so it reads as an event rather than clutter.
    const air = state.grounded ? '' : `AIR ${state.airTime.toFixed(1)}s`;
    if (air !== this.lastAir) {
      this.airEl.textContent = air;
      this.lastAir = air;
    }

    void this.edgeFlashUntil;
  }

  dispose(): void {
    this.root.remove();
  }
}
