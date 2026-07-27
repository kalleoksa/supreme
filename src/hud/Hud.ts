import { FailReason, LandQuality, TrickState, type BoardState } from '../sim/BoardState.js';
import { SimEventKind, type EventBuffer } from '../sim/events.js';
import { FAIL_REASON_TEXT, LAND_QUALITY_TEXT } from '../sim/Landing.js';
import { completedHalfSpins, isRotational, TRICK_NAMES } from '../sim/Trick.js';

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
  private readonly popEl: HTMLElement;
  private readonly ttgEl: HTMLElement;
  private readonly ttgFill: HTMLElement;
  private readonly chargeEl: HTMLElement;
  private readonly chargeFill: HTMLElement;
  private readonly ribbonEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerReason: HTMLElement;
  private readonly scoreEl: HTMLElement;

  private lastSpeed = '';
  private lastTime = '';
  private lastEdge = -1;
  private lastAir = '';
  private lastPop = '';
  private lastTtg = -1;
  private lastCharge = -1;
  private lastRibbon = '';
  private lastScore = '';
  private bannerTimer = 0;
  private bannerFrames = 0;
  private pumpTimer = 0;
  private pumpFrames = 0;
  private popTimer = 0;
  private popFrames = 0;

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
      <div class="hud-pop"></div>
      <div class="hud-ttg"><div class="hud-ttg-fill"></div></div>
      <div class="hud-charge"><div class="hud-charge-fill"></div></div>
      <div class="hud-ribbon"></div>
      <div class="hud-banner"><div class="hud-banner-title"></div><div class="hud-banner-reason"></div></div>
      <div class="hud-score">0</div>
      <div class="hud-edge"><div class="hud-edge-fill"></div></div>
    `;
    parent.appendChild(this.root);

    this.speedEl = this.root.querySelector('.hud-speed-value') as HTMLElement;
    this.timeEl = this.root.querySelector('.hud-time') as HTMLElement;
    this.edgeFill = this.root.querySelector('.hud-edge-fill') as HTMLElement;
    this.airEl = this.root.querySelector('.hud-air') as HTMLElement;
    this.pumpEl = this.root.querySelector('.hud-pump') as HTMLElement;
    this.popEl = this.root.querySelector('.hud-pop') as HTMLElement;
    this.ttgEl = this.root.querySelector('.hud-ttg') as HTMLElement;
    this.ttgFill = this.root.querySelector('.hud-ttg-fill') as HTMLElement;
    this.chargeEl = this.root.querySelector('.hud-charge') as HTMLElement;
    this.chargeFill = this.root.querySelector('.hud-charge-fill') as HTMLElement;
    this.ribbonEl = this.root.querySelector('.hud-ribbon') as HTMLElement;
    this.bannerEl = this.root.querySelector('.hud-banner') as HTMLElement;
    this.bannerTitle = this.root.querySelector('.hud-banner-title') as HTMLElement;
    this.bannerReason = this.root.querySelector('.hud-banner-reason') as HTMLElement;
    this.scoreEl = this.root.querySelector('.hud-score') as HTMLElement;
  }

  /**
   * Describe a pop in terms the player can act on.
   *
   * The number that matters is not the height -- it is *where the height came from*.
   * Telling someone "PERFECT LIP" when they released on a crest with no charge, versus
   * "CHARGED" when they crouched for it, is the whole feedback loop for learning the
   * timing. A bare height reading teaches nothing, which is precisely how the original
   * ended up feeling arbitrary.
   */
  private static describePop(lipQuality: number, charge: number): string {
    if (lipQuality >= 0.8) return `PERFECT LIP · ${Math.round(lipQuality * 100)}`;
    if (lipQuality >= 0.45) return `GOOD LIP · ${Math.round(lipQuality * 100)}`;
    if (lipQuality >= 0.15) return 'EARLY';
    return charge > 0.6 ? 'CHARGED' : 'FLAT POP';
  }

  /**
   * The trick currently being performed, named the way a snowboarder would name it.
   *
   * Rotations are reported in degrees of *completed* half-revolution, so the number on
   * screen is what the player has actually banked -- not what they are attempting. That
   * distinction is what makes the readout trustworthy enough to make a decision from.
   */
  private static describeTrick(state: BoardState): string {
    if (state.trickState === TrickState.Breaking) return 'BREAK';
    if (state.trickState !== TrickState.Tricking) return '';

    const name = TRICK_NAMES[state.trickId] ?? '';
    if (!isRotational(state.trickId)) {
      return state.trickHoldTime > 0.15 ? `${name} ${state.trickHoldTime.toFixed(1)}s` : name;
    }
    const halves = completedHalfSpins(state);
    return halves > 0 ? `${name} ${halves * 180}` : name;
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
      } else if (e.kind === SimEventKind.Land) {
        // The landing banner, and the whole reason this phase exists. Naming the failure
        // is what separates a system a player can learn from one that feels arbitrary:
        // UNDER-ROTATED and SIDEWAYS are opposite corrections, and being told which one
        // you made is the difference between improving and guessing.
        const quality = e.a as LandQuality;
        const reason = e.b as FailReason;
        const points = e.c;

        this.bannerTitle.textContent = LAND_QUALITY_TEXT[quality] ?? '';
        // Points only when there were any: "+0" on every plain landing is noise.
        const suffix = points > 0 ? `  +${points}` : points < 0 ? `  ${points}` : '';
        if (suffix) this.bannerTitle.textContent += suffix;

        // A reason is only shown when something actually went wrong. A clean landing
        // needs no explanation, and captioning it would train players to ignore the line.
        this.bannerReason.textContent =
          quality <= LandQuality.Sketchy ? (FAIL_REASON_TEXT[reason] ?? '') : '';

        this.bannerEl.classList.toggle('crash', quality === LandQuality.Crash);
        this.bannerEl.classList.toggle('perfect', quality === LandQuality.Perfect);
        this.bannerTimer = Hud.FLASH_TIME * 2.4;
        this.bannerFrames = Hud.FLASH_MIN_FRAMES;
      } else if (e.kind === SimEventKind.TrickBreak) {
        // Showing the forfeited number is what teaches the risk/reward. A silent bail
        // just looks like the trick stopped working.
        const forfeited = Math.round(e.a);
        this.bannerTitle.textContent = 'BREAK';
        this.bannerReason.textContent =
          forfeited > 0 ? `landing saved · ${forfeited} forfeited` : 'landing saved';
        this.bannerEl.classList.remove('crash', 'perfect');
        this.bannerTimer = Hud.FLASH_TIME * 1.6;
        this.bannerFrames = Hud.FLASH_MIN_FRAMES;
      } else if (e.kind === SimEventKind.Pop && e.a > 0) {
        const label = Hud.describePop(e.b, e.c);
        if (label !== this.lastPop) {
          this.popEl.textContent = label;
          this.lastPop = label;
        }
        this.popEl.classList.toggle('great', e.b >= 0.8);
        this.popTimer = Hud.FLASH_TIME * 1.6;
        this.popFrames = Hud.FLASH_MIN_FRAMES;
      }
    });
  }

  /**
   * @param timeToGround Predicted seconds until the board meets the surface, or 0 when
   *   grounded. Passed in rather than computed here because the prediction needs the
   *   terrain, and the HUD has no business knowing about it.
   */
  update(state: BoardState, dt: number, timeToGround = 0): void {
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

    if (this.popTimer > 0 || this.popFrames > 0) {
      this.popTimer = Math.max(0, this.popTimer - dt);
      this.popFrames = Math.max(0, this.popFrames - 1);
      this.popEl.classList.add('visible');
    } else {
      this.popEl.classList.remove('visible');
    }

    // Charge meter.
    //
    // On screen rather than on the snow. A ring decal at the rider's feet was built
    // first, per the original design, and could not be seen: from a camera 3.4 m up and
    // 8 m back a ground ring is nearly edge-on and mostly behind the rider. The crouch
    // animation carries the same information diegetically; this carries the precision.
    const chargePct = Math.round(state.jumpCharge * 100);
    const showCharge = chargePct > 1;
    this.chargeEl.classList.toggle('visible', showCharge);
    if (chargePct !== this.lastCharge) {
      this.chargeFill.style.width = `${chargePct}%`;
      this.lastCharge = chargePct;
    }
    // Full charge is worth signalling: past it, holding longer buys nothing.
    this.chargeFill.classList.toggle('full', state.jumpCharge >= 0.999);

    // The trick ribbon: the name assembling live as the player inputs it.
    //
    // Showing what is *currently* being performed, mid-air, is the other half of the
    // legibility fix. The original's trick system was called illegible largely because
    // you could not tell what you had asked for until you had already landed it.
    const ribbon = Hud.describeTrick(state);
    if (ribbon !== this.lastRibbon) {
      this.ribbonEl.textContent = ribbon;
      this.lastRibbon = ribbon;
    }
    this.ribbonEl.classList.toggle('visible', ribbon !== '');

    if (this.bannerTimer > 0 || this.bannerFrames > 0) {
      this.bannerTimer = Math.max(0, this.bannerTimer - dt);
      this.bannerFrames = Math.max(0, this.bannerFrames - 1);
      this.bannerEl.classList.add('visible');
    } else {
      this.bannerEl.classList.remove('visible');
    }

    const score = state.score > 0 ? state.score.toLocaleString('en-US') : '';
    if (score !== this.lastScore) {
      this.scoreEl.textContent = score;
      this.lastScore = score;
    }

    // Air time, shown only in the air, so it reads as an event rather than clutter.
    const air = state.grounded ? '' : `AIR ${state.airTime.toFixed(1)}s`;
    if (air !== this.lastAir) {
      this.airEl.textContent = air;
      this.lastAir = air;
    }

    // Time to ground. This is the piece that lets a player see whether a rotation will
    // finish before impact, instead of finding out when they land -- the single most
    // direct answer to "it was far too easy to get it wrong".
    const showTtg = !state.grounded && timeToGround > 0.05;
    this.ttgEl.classList.toggle('visible', showTtg);
    if (showTtg) {
      // Normalized against 2 s, which is a big air; longer just pins the bar full.
      const ttgPct = Math.round(Math.min(timeToGround / 2, 1) * 100);
      if (ttgPct !== this.lastTtg) {
        this.ttgFill.style.width = `${ttgPct}%`;
        this.lastTtg = ttgPct;
      }
      // Red when impact is imminent: that is when a rotation still in progress becomes
      // a crash rather than a landing.
      this.ttgFill.classList.toggle('imminent', timeToGround < 0.35);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
