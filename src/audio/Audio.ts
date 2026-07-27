import { clamp01, invLerp01, lerp } from '../core/math.js';
import type { BoardState } from '../sim/BoardState.js';
import { SimEventKind, type EventBuffer } from '../sim/events.js';
import { LandQuality } from '../sim/BoardState.js';

/**
 * The whole audio layer.
 *
 * ## Why this exists in M1 at all
 *
 * Edge hiss pitched by skid and wind pitched by speed are roughly 40% of the *perceived*
 * feel of carving. Two continuous, procedural voices reacting to two numbers the simulation
 * already computes -- the highest feel-per-hour item on the plan, above any remaining visual
 * work. A snowboarding game where carving is silent feels wrong in a way no amount of spray
 * particles fixes.
 *
 * It also closes the ollie's feedback loop. The charged ollie is built on timing a release
 * against a terrain crest, and a player learns that timing far faster when a good pop and a
 * bad one are distinguishable *by ear* as well as by eye -- which is feel-gate criterion #2,
 * and unreachable without this.
 *
 * ## No audio assets
 *
 * Every voice is synthesised: white noise generated into a buffer at construction, shaped by
 * filters. Same reasoning as the rider being built from primitives -- an asset pipeline must
 * not be able to block work on how the game feels, and "wind" and "snow hiss" are filtered
 * noise anyway, which is what they physically are.
 *
 * ## The autoplay rule
 *
 * Browsers refuse to start an AudioContext without a user gesture, and a context created at
 * boot is born `suspended`. So construction never assumes it can make sound: `resume()` is
 * called from the first real key press or click, and everything before that is silent but
 * fully wired. Getting this wrong is the classic "audio works on my machine" bug, because it
 * works fine after a hot reload where the page has already been interacted with.
 *
 * ## Tuning
 *
 * The mix constants below are starting values, chosen conservatively -- quiet rather than
 * loud, because the failure mode of too quiet is "I turned it up" and the failure mode of too
 * loud is "I turned it off". They have not been heard by anyone; the balance is a listening
 * job and this file is arranged so it is a one-line job per voice.
 */

/** Master ceiling. Everything else is a fraction of this. */
const MASTER_GAIN = 0.55;

/** Wind: rises with speed, and is the main continuous speed cue. */
const WIND_GAIN_LO = 0.0;
const WIND_GAIN_HI = 0.42;
const WIND_SPEED_LO = 6;
const WIND_SPEED_HI = 40;
const WIND_FILTER_LO = 320;
const WIND_FILTER_HI = 1500;

/** Edge hiss: the carve voice. Driven by skid, not by speed. */
const HISS_GAIN_MAX = 0.5;
const HISS_FILTER_LO = 900;
const HISS_FILTER_HI = 5200;
const HISS_Q = 1.4;

/** How fast the continuous voices follow their targets, as a time constant in seconds. */
const FOLLOW_TAU = 0.08;

export interface AudioSettings {
  enabled: boolean;
  /** 0..1, applied on top of the internal mix. */
  volume: number;
}

export const DEFAULT_AUDIO: AudioSettings = { enabled: true, volume: 0.8 };

export class Audio {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private windGain: GainNode | undefined;
  private windFilter: BiquadFilterNode | undefined;
  private hissGain: GainNode | undefined;
  private hissFilter: BiquadFilterNode | undefined;
  private noise: AudioBuffer | undefined;
  private started = false;
  private failed = false;

  constructor(readonly settings: AudioSettings = { ...DEFAULT_AUDIO }) {}

  /** True once the context exists and is running. */
  get running(): boolean {
    return this.started && this.ctx?.state === 'running';
  }

  get contextState(): string {
    return this.ctx?.state ?? 'none';
  }

  /**
   * Create the graph and start the continuous voices.
   *
   * Safe to call repeatedly: the first call builds everything, later ones only nudge a
   * suspended context back to running (which is what happens when a tab is backgrounded).
   */
  resume(): void {
    if (this.failed) return;
    try {
      if (!this.ctx) this.build();
      void this.ctx?.resume();
    } catch {
      // No Web Audio, or it refused to start. The game must not care.
      this.failed = true;
    }
  }

  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;

    // One second of white noise, looped. A short loop is audible as a loop; a second of it
    // through a moving filter is not.
    const frames = Math.floor(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Presentation-only, so Math.random is fine here -- this is the one place in the codebase
    // where an unseeded RNG is correct rather than a determinism bug, because nothing about a
    // recorded run depends on which noise sample was played.
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterTarget();
    this.master.connect(ctx.destination);

    // --- Wind: lowpassed noise, gain and cutoff by speed.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = WIND_FILTER_LO;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain).connect(this.master);
    this.loop(buffer, this.windFilter);

    // --- Edge hiss: bandpassed noise, gain by skid. A bandpass rather than a lowpass because
    // snow under a sliding edge is a narrow band of noise, and a lowpass reads as more wind.
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'bandpass';
    this.hissFilter.frequency.value = HISS_FILTER_LO;
    this.hissFilter.Q.value = HISS_Q;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissFilter.connect(this.hissGain).connect(this.master);
    this.loop(buffer, this.hissFilter);

    this.started = true;
  }

  private loop(buffer: AudioBuffer, destination: AudioNode): void {
    const src = this.ctx!.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(destination);
    src.start();
  }

  private masterTarget(): number {
    return this.settings.enabled ? MASTER_GAIN * clamp01(this.settings.volume) : 0;
  }

  /** Apply a settings change. */
  applySettings(): void {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.masterTarget(), this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Follow the rider. Called once per rendered frame, with real frame time.
   *
   * Presentation, so it is allowed to be frame-rate dependent in a way the simulation is not.
   * `setTargetAtTime` does the smoothing in the audio thread rather than here, which is what
   * keeps a dropped frame from producing a click.
   */
  update(state: BoardState, _dt: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const speed = Math.hypot(state.vel.x, state.vel.z);
    const speed01 = invLerp01(WIND_SPEED_LO, WIND_SPEED_HI, speed);

    // Airborne, the wind is all there is: no edge, no snow. Lifting it slightly is also the
    // cheapest possible cue that the board has left the ground.
    const airLift = state.grounded ? 1 : 1.25;
    this.windGain!.gain.setTargetAtTime(
      lerp(WIND_GAIN_LO, WIND_GAIN_HI, speed01) * airLift,
      now,
      FOLLOW_TAU,
    );
    this.windFilter!.frequency.setTargetAtTime(
      lerp(WIND_FILTER_LO, WIND_FILTER_HI, speed01),
      now,
      FOLLOW_TAU,
    );

    // Edge hiss only exists on the ground, and its whole job is to make grip audible: a clean
    // carve is quiet and a slide is loud, so the player hears the speed they are losing before
    // the numbers show it.
    const skid = state.grounded ? clamp01(state.skid) : 0;
    // Squared, so a slight slide is nearly silent and a real one is unmistakable. A linear
    // ramp puts hiss under every ordinary turn and stops meaning anything.
    this.hissGain!.gain.setTargetAtTime(skid * skid * HISS_GAIN_MAX, now, FOLLOW_TAU);
    this.hissFilter!.frequency.setTargetAtTime(
      lerp(HISS_FILTER_LO, HISS_FILTER_HI, skid * 0.6 + speed01 * 0.4),
      now,
      FOLLOW_TAU,
    );
  }

  /**
   * Drain simulation events into one-shot voices.
   *
   * The pop is the one that matters. Pitching it by lip quality is what makes a well-timed
   * release audibly different from a mistimed one, and that is the difference between a player
   * internalising the ollie's timing and finding it arbitrary.
   */
  drain(events: EventBuffer): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    events.forEach((e) => {
      switch (e.kind) {
        case SimEventKind.Pop: {
          if (e.a <= 0) return;
          const quality = clamp01(e.b);
          // A good lip rings higher and longer. Deliberately a wide spread: the whole point is
          // that the two are not easily confused.
          this.blip(320 + quality * 520, 0.16 + quality * 0.14, 0.3, 'triangle');
          break;
        }
        case SimEventKind.Land: {
          const quality = e.a as LandQuality;
          if (quality === LandQuality.Crash) return; // the crash voice covers it
          // A thud, brighter for a better landing.
          this.blip(110 + quality * 26, 0.12, 0.34, 'sine');
          if (quality === LandQuality.Perfect) this.blip(880, 0.2, 0.12, 'triangle');
          break;
        }
        case SimEventKind.Crash:
          this.burst(0.45, 0.5);
          break;
        case SimEventKind.PumpBoost:
          // The audible half of the pump reward. The HUD flash teaches that it happened; this
          // makes it feel like it happened.
          this.blip(560, 0.18, 0.22, 'triangle');
          break;
        case SimEventKind.Checkpoint:
          this.blip(760, 0.12, 0.16, 'square');
          break;
        case SimEventKind.Finish:
          this.blip(520, 0.5, 0.22, 'triangle');
          break;
        case SimEventKind.OutOfBounds:
          if (e.a === 1) this.burst(0.3, 0.35);
          break;
        default:
          break;
      }
    });
  }

  /** A short pitched tone with an exponential decay. */
  private blip(
    frequency: number,
    seconds: number,
    gain: number,
    type: OscillatorType = 'sine',
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    const env = ctx.createGain();
    // Ramp up over a couple of milliseconds rather than starting at full gain: a step in
    // amplitude is an audible click on every single note.
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    osc.connect(env).connect(this.master);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
  }

  /** A filtered noise burst, for impacts. */
  private burst(seconds: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.frequency.exponentialRampToValueAtTime(220, now + seconds);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    src.connect(filter).connect(env).connect(this.master);
    src.start(now);
    src.stop(now + seconds + 0.02);
  }

  /** Diagnostic snapshot, for the browser tests. */
  levels(): { master: number; wind: number; hiss: number; windCutoff: number } {
    return {
      master: this.master?.gain.value ?? 0,
      wind: this.windGain?.gain.value ?? 0,
      hiss: this.hissGain?.gain.value ?? 0,
      windCutoff: this.windFilter?.frequency.value ?? 0,
    };
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = undefined;
    this.started = false;
  }
}
