import * as THREE from 'three';
import { Loop, type LoopHandlers } from './Loop.js';
import { RealClock } from './Clock.js';
import { FIXED_DT, TRACK_ID } from './config.js';
import { createInputState } from '../input/InputState.js';

import { Renderer } from '../render/Renderer.js';
import { Environment } from '../render/Environment.js';
import { TerrainMesh } from '../render/TerrainMesh.js';
import { RiderView } from '../render/RiderView.js';
import { ChaseCamera, type CameraComfort } from '../render/ChaseCamera.js';
import { Spray } from '../render/Spray.js';
import { WorldHints } from '../render/WorldHints.js';
import { RaceMarkers } from '../render/RaceMarkers.js';
import { timeToGround } from '../sim/Ollie.js';
import { SimEventKind } from '../sim/events.js';
import type { DebugPanel } from '../hud/DebugPanel.js';
import { FlyCamera } from '../dev/FlyCamera.js';
import { buildTestSlopeTrack, type TestSlope } from '../track/testSlope.js';
import type { GeneratedTrack } from '../track/generate.js';
import { Scatter } from '../render/Scatter.js';
import type { Heightfield } from '../sim/Heightfield.js';
import { v3 } from '../core/vec3.js';
import {
  copyBoardState,
  createBoardState,
  groundSpeed,
  resetBoardState,
  type BoardState,
} from '../sim/BoardState.js';
import { createStepContext, stepBoard, type BoardStepContext } from '../sim/Board.js';
import { DEFAULT_TUNING, cloneTuning, type BoardTuning } from '../sim/boardTuning.js';
import { InputRouter } from '../input/InputRouter.js';
import { KeyboardSource } from '../input/KeyboardSource.js';
import { GamepadSource } from '../input/GamepadSource.js';
import { ProgressField } from '../race/ProgressField.js';
import { Race, type BestRun } from '../race/Race.js';
import { GhostRecorder } from '../race/GhostRecorder.js';
import { loadBestRun, saveBestRun } from './bestRun.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';
import { SettingsPanel } from '../hud/SettingsPanel.js';
import { Audio } from '../audio/Audio.js';
import { Hud } from '../hud/Hud.js';
import '../hud/hud.css';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  /** Show the diagnostic readout and allow toggling the free-fly camera. */
  debug?: boolean;
}

/** Scripted input for `Game.simulate`, used by diagnostics and e2e tests. */
export interface ScriptedInput {
  steerX?: number;
  steerY?: number;
  carve?: boolean;
  jump?: boolean;
  trick?: boolean;
  carveAnalog?: number;
  /**
   * Fire a carve *release* edge on the first simulated step.
   *
   * Held state alone cannot express this, and without it the pump -- the entire reward
   * half of the carve model -- is unreachable from a scripted run, so nothing outside
   * the unit tests could ever exercise it.
   */
  carveReleased?: boolean;
  /** Fire a jump press edge on the first step, to begin charging (or break a trick). */
  jumpPressed?: boolean;
  /** Fire a trick press edge on the first step, starting a trick. */
  trickPressed?: boolean;
  /** Latched trick direction, which selects which trick starts. */
  trickDirX?: -1 | 0 | 1;
  trickDirY?: -1 | 0 | 1;
  /** Fire a jump release edge on the first step: the pop. */
  jumpReleased?: boolean;
}

/**
 * Wires everything together and owns the loop.
 *
 * The interesting part is `step` versus `render`. `step` runs the pure simulation at
 * a fixed timestep and nothing else; `render` interpolates between the last two
 * simulated states and draws. That split is what lets a 30 fps display show smooth
 * motion while playing exactly the same game as a 144 Hz one.
 */
export class Game implements LoopHandlers {
  readonly renderer: Renderer;
  readonly environment: Environment;
  readonly terrain: TerrainMesh;
  readonly field: Heightfield;
  readonly slope: TestSlope;
  /** The full generator output: launch features, scatter and obstacles as well as the field. */
  readonly track: GeneratedTrack;
  readonly loop: Loop;

  readonly board: BoardState;
  readonly tuning: BoardTuning;
  readonly progressField: ProgressField;
  readonly race: Race;
  readonly ghost = new GhostRecorder();

  private readonly prevBoard: BoardState;
  /** Interpolated pose handed to the renderer; never fed back into the sim. */
  private readonly viewBoard: BoardState;

  private readonly stepCtx: BoardStepContext;
  private readonly input: InputRouter;
  private readonly gamepad: GamepadSource;
  private readonly riderView: RiderView;
  private readonly chase: ChaseCamera;
  private readonly spray: Spray;
  private readonly hints: WorldHints;
  readonly markers: RaceMarkers;
  readonly scatter: Scatter;
  private readonly hud: Hud;
  private readonly flyCamera: FlyCamera;
  private tuningPanel: DebugPanel | undefined;

  private readonly debugEl: HTMLElement | undefined;
  private lastDebugText = '';
  private debugAccum = 0;
  private paused = false;
  private readonly scriptInput = createInputState();
  private best: BestRun | undefined;
  readonly settings: Settings;
  readonly audio: Audio;
  private readonly settingsPanel: SettingsPanel;
  private snapCamera = false;

  constructor(options: GameOptions) {
    this.renderer = new Renderer(options.canvas, {
      onContextLost: () => {
        // Stop simulating while there is nothing to draw into, so the gap does not
        // come back as one enormous timestep to replay.
        this.loop.stop();
      },
      onContextRestored: () => {
        this.loop.resync();
        this.loop.start();
      },
    });

    this.environment = new Environment(this.renderer.scene);

    this.track = buildTestSlopeTrack();
    this.slope = this.track;
    this.field = this.slope.field;

    this.terrain = new TerrainMesh(this.field, this.environment);
    this.renderer.scene.add(this.terrain.group);

    this.tuning = cloneTuning(DEFAULT_TUNING);
    this.stepCtx = createStepContext(this.tuning);
    this.stepCtx.obstacles = this.track.obstacles;

    // Baked once at load, from the same heightfield the physics reads. A few
    // milliseconds, and it is what makes progress, splits, bounds and the return arrow
    // all work on whatever line the player picks.
    this.progressField = new ProgressField(this.field, { finish: this.slope.finish });
    this.race = new Race(this.progressField, {
      x: this.slope.startX,
      y: this.field.height(this.slope.startX, this.slope.startZ) + this.tuning.RIDE_HEIGHT,
      z: this.slope.startZ,
      yaw: this.slope.startYaw,
    });
    this.best = loadBestRun(TRACK_ID);

    this.board = createBoardState();
    this.prevBoard = createBoardState();
    this.viewBoard = createBoardState();

    this.gamepad = new GamepadSource();
    this.input = new InputRouter([new KeyboardSource(), this.gamepad]);

    this.riderView = new RiderView(this.environment);
    this.renderer.scene.add(this.riderView.group);

    // Built before the first respawn, because respawn() snaps the camera and would
    // otherwise have nothing to snap.
    this.chase = new ChaseCamera(this.renderer.camera, this.field);
    this.respawn();

    this.spray = new Spray(this.environment);
    this.renderer.scene.add(this.spray.points);

    this.hints = new WorldHints(this.field, this.tuning);
    this.renderer.scene.add(this.hints.group);

    this.markers = new RaceMarkers(
      this.field,
      this.environment,
      this.progressField,
      this.slope.finish,
      this.race.rules.splits,
    );
    this.renderer.scene.add(this.markers.group);

    // Instanced: one draw call per species, whatever the tree count. That discipline is why
    // a populated mountain fits the fifty-draw budget at all.
    this.scatter = new Scatter(
      this.environment,
      this.track.spec.scatter?.species ?? [],
      this.track.scatter,
    );
    this.renderer.scene.add(this.scatter.group);

    this.settings = loadSettings();
    // The camera owns the knobs; the panel and storage only move them.
    this.chase.comfort = this.settings.comfort;

    this.audio = new Audio(this.settings.audio);

    this.hud = new Hud(options.hud);
    this.settingsPanel = new SettingsPanel(this.hud.root, this.settings, () => {
      saveSettings(this.settings);
      this.audio.applySettings();
      // Moving the volume slider is itself a gesture, so it is a fine moment to start audio
      // for a player who has not otherwise touched the keyboard.
      this.audio.resume();
    });

    // Browsers refuse to start an AudioContext without a user gesture, and one created at boot
    // is born suspended. Listening for the first real interaction is the only reliable way in
    // -- and this is easy to miss in development, because after a hot reload the page has
    // already been interacted with and audio just works.
    window.addEventListener('keydown', this.onFirstGesture, { once: true });
    window.addEventListener('pointerdown', this.onFirstGesture, { once: true });

    this.flyCamera = new FlyCamera(this.renderer.camera, options.canvas);
    this.flyCamera.enabled = false;

    if (options.debug) {
      const el = document.createElement('div');
      el.id = 'debug';
      options.hud.appendChild(el);
      this.debugEl = el;
      window.addEventListener('keydown', this.onDebugKey);

      // `import.meta.env.DEV` is tested directly here, not just via options.debug.
      // Vite substitutes it literally, so Rollup can see `false && ...` and drop the
      // import entirely; routing the same information through an object property
      // leaves the chunk in the output, emitted but never fetched.
      if (import.meta.env.DEV) {
        void import('../hud/DebugPanel.js').then(({ DebugPanel }) => {
          this.tuningPanel = new DebugPanel(options.hud, this.tuning);
        });
      }
    }

    this.loop = new Loop(new RealClock(), this);
  }

  /**
   * The camera's live comfort settings.
   *
   * Exposed because these are the one part of the game that has to work for someone who is
   * already feeling ill, so the browser tests assert that moving a knob actually reaches the
   * camera rather than only updating a checkbox.
   */
  get chaseComfort(): CameraComfort {
    return this.chase.comfort;
  }

  /** Place the rider at the start gate, on the surface, facing downhill. */
  respawn(): void {
    const { startX, startZ, startYaw } = this.slope;
    const y = this.field.height(startX, startZ) + this.tuning.RIDE_HEIGHT;
    // Project the spawn velocity onto the slope, otherwise the rider starts a moment
    // airborne on any real pitch.
    this.field.normal(startX, startZ, spawnNormal);
    // A small initial speed rather than a standing start: a rider with no velocity on
    // a shallow section takes an age to get moving, and the whole run is 90 seconds.
    resetBoardState(this.board, startX, y, startZ, startYaw, 6, spawnNormal);
    copyBoardState(this.prevBoard, this.board);

    // Snap the camera rather than letting it smooth. A respawn teleports the rider,
    // and the camera's height tracking has a 0.3 s time constant -- without this it
    // sails down the mountain from wherever it was, which was measured at 29 m above
    // the rider after a jump of a hundred metres.
    this.chase.reset(this.board);

    // A respawn is a new run: back to the start gate and the 3-2-1.
    this.race.reset();
    this.ghost.reset();
  }

  private onFirstGesture = (): void => {
    this.audio.resume();
    // Whichever listener did not fire is now redundant.
    window.removeEventListener('keydown', this.onFirstGesture);
    window.removeEventListener('pointerdown', this.onFirstGesture);
  };

  private onDebugKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyF') {
      // Toggle between the chase camera and free flight, for inspecting the track.
      this.flyCamera.enabled = !this.flyCamera.enabled;
      if (this.flyCamera.enabled) {
        const cam = this.renderer.camera.position;
        this.flyCamera.setPose(cam.x, cam.y, cam.z, this.board.yaw, -0.2);
      } else {
        this.chase.reset(this.board);
      }
    }
  };

  beginFrame(now: number): void {
    // Poll the backends and anchor the frame's time origin. Without this call the
    // router has no frame start, so every button edge's timestamp fails its
    // tick-window comparison and no input reaches the simulation at all.
    this.input.poll(now);
  }

  step(_tick: number, dt: number, indexInBatch: number): void {
    // `indexInBatch`, not the loop's step counter: that counter only updates once the
    // batch finishes, so using it here would place every edge in the previous
    // frame's time window.
    const input = this.input.sampleForTick(indexInBatch, dt);

    if (input.meta.reset) this.respawn();
    if (input.meta.pause) this.paused = !this.paused;
    if (this.paused) return;

    // The gamepad's analog trigger travel rides alongside the digital latch, so
    // partial edge engagement is available without adding a fourth input verb.
    this.stepCtx.carveAnalog =
      this.input.activeSourceId === 'gamepad' ? this.gamepad.carveAnalog : 1;

    // The race owns the clock and decides whether the board is released. During the
    // count and after the finish nothing simulates at all -- freezing the board rather
    // than zeroing the input keeps the gate honest, because a rider cannot pre-load a
    // charge against a simulation that is not running.
    const held = this.race.prepare(dt);

    copyBoardState(this.prevBoard, this.board);
    if (!held) stepBoard(this.board, input, this.field, dt, this.stepCtx);

    const resetsBefore = this.race.resets;
    this.race.observe(this.board, this.field, dt, this.stepCtx.events);
    if (this.race.resets !== resetsBefore) {
      // A recovery teleports the board. Interpolating across it would draw one frame of
      // the rider smeared back up the mountain, and the camera would sail after them.
      copyBoardState(this.prevBoard, this.board);
      this.snapCamera = true;
    }

    // Recorded from the simulation step rather than the frame, so a 30 fps display captures
    // exactly the same ghost a 144 Hz one does.
    if (!held) this.ghost.record(this.board, this.race.time, dt);

    // Fell off the world entirely. The race's own out-of-bounds recovery handles
    // wandering off the course; this is the case where there is no terrain to sample.
    if (!this.field.contains(this.board.pos.x, this.board.pos.z)) this.respawn();
  }

  render(alpha: number, frameDt: number): void {
    // Interpolate the pose so a 30 fps display still moves smoothly. Only the
    // continuous quantities are blended; discrete state comes from the newest step,
    // because a half-grounded board is not a meaningful thing to draw.
    copyBoardState(this.viewBoard, this.board);
    this.viewBoard.pos.x = lerpScalar(this.prevBoard.pos.x, this.board.pos.x, alpha);
    this.viewBoard.pos.y = lerpScalar(this.prevBoard.pos.y, this.board.pos.y, alpha);
    this.viewBoard.pos.z = lerpScalar(this.prevBoard.pos.z, this.board.pos.z, alpha);
    this.viewBoard.yaw = lerpAngle(this.prevBoard.yaw, this.board.yaw, alpha);

    this.riderView.update(this.viewBoard, frameDt);
    this.spray.update(this.viewBoard, frameDt);
    this.hints.update(this.viewBoard);

    if (this.snapCamera) {
      this.chase.reset(this.board);
      this.snapCamera = false;
    }
    if (this.flyCamera.enabled) this.flyCamera.update(frameDt);
    else this.chase.update(this.viewBoard, frameDt);

    // The best time as it stood *before* this frame. Both the split deltas and the
    // results panel compare against it, so it has to be read before a finish in this
    // same frame overwrites it -- otherwise every run reports itself as dead even with
    // its own best.
    const reference = this.best;

    // Drain before clearing: events are the only channel from the simulation to
    // presentation, and a 30 fps display must not miss one that happened on an
    // intermediate substep.
    this.stepCtx.events.forEach((e) => {
      if (e.kind === SimEventKind.Finish) {
        const result = this.race.result(this.board);
        if (result) this.best = saveBestRun(TRACK_ID, result, this.best);
      } else if (e.kind === SimEventKind.Crash) {
        // Shake only on a crash. Anywhere else it costs readability for nothing.
        this.chase.shake();
      } else if (e.kind === SimEventKind.Land && e.a >= 2) {
        // A clean or perfect landing gets the same FOV punch a pop does.
        this.chase.kick();
      } else if (e.kind === SimEventKind.Pop && e.a > 0) {
        // A pop or a landing punches the field of view briefly. Cheaper than a camera
        // move and it does not disturb the framing the player is reading.
        this.chase.kick();
        // Feed the timing back so the lip-band assist fades as the player improves.
        this.hints.recordPop(e.b);
      }
    });
    this.audio.drain(this.stepCtx.events);
    this.hud.drain(this.stepCtx.events, reference?.splits);
    this.hud.updateRace(this.race, this.board, frameDt, reference);
    this.hud.update(
      this.viewBoard,
      frameDt,
      this.board.grounded
        ? 0
        : timeToGround(this.board, this.field, 9.81 * this.tuning.AIR_GRAVITY_SCALE),
    );
    this.stepCtx.events.clear();

    // Continuous voices follow the interpolated pose, like everything else on the render side.
    this.audio.update(this.viewBoard, frameDt);

    const cam = this.renderer.camera.position;
    this.terrain.update(cam.x, cam.z);
    this.renderer.render();

    if (this.debugEl) this.updateDebug(frameDt);
  }

  private updateDebug(frameDt: number): void {
    this.debugAccum += frameDt;
    if (this.debugAccum < 0.1) return;
    this.debugAccum = 0;

    const b = this.board;
    const info = this.renderer.info;
    const text = [
      `fps    ${(1 / Math.max(frameDt, 1e-6)).toFixed(0)}  steps ${this.loop.stats.steps}${
        this.loop.stats.starved ? ' STARVED' : ''
      }`,
      `draws  ${info.calls}  tris ${info.triangles.toLocaleString('en-US')}`,
      `pos    ${b.pos.x.toFixed(1)} ${b.pos.y.toFixed(1)} ${b.pos.z.toFixed(1)}`,
      `speed  ${groundSpeed(b).toFixed(1)} m/s  (${(groundSpeed(b) * 3.6).toFixed(0)} km/h)`,
      `vLong  ${b.vLong.toFixed(1)}  vLat ${b.vLat.toFixed(2)}  skid ${b.skid.toFixed(2)}`,
      `yaw    ${((b.yaw * 180) / Math.PI).toFixed(0)}deg  rate ${b.yawRate.toFixed(2)}`,
      `edge   ${b.edge.toFixed(2)}  hold ${b.edgeHoldTime.toFixed(2)}s`,
      b.grounded
        ? `ground slope ${((b.slopeAngle * 180) / Math.PI).toFixed(0)}deg  surf ${b.ground.surface}  grip ${b.ground.grip.toFixed(2)}`
        : `AIR    ${b.airTime.toFixed(2)}s  apex ${b.apexHeight.toFixed(1)}m`,
      `race   ${RACE_STATE_TEXT[this.race.state]} t=${this.race.time.toFixed(2)}  p=${(this.race.progress * 100).toFixed(1)}%  oob ${this.race.oobDistance.toFixed(0)}m  resets ${this.race.resets}`,
      this.flyCamera.enabled ? 'camera FLY (F to return)' : 'camera CHASE (F to fly)',
    ].join('\n');

    if (text !== this.lastDebugText) {
      this.debugEl!.textContent = text;
      this.lastDebugText = text;
    }
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** Advance exactly one frame. Used by the e2e tests. */
  frameStep(): void {
    this.loop.advance();
  }

  /** Place the camera explicitly, for capturing diagnostic views. */
  setView(x: number, y: number, z: number, yaw: number, pitch = -0.2): void {
    this.flyCamera.enabled = true;
    this.flyCamera.setPose(x, y, z, yaw, pitch);
  }

  /**
   * Advance the simulation by `steps` fixed timesteps with scripted input, ignoring
   * the wall clock entirely.
   *
   * Needed because the real loop is wall-clock driven and clamps at MAX_STEPS, so on
   * a software renderer running at a handful of frames per second it correctly
   * degrades to slow motion -- covering a fraction of a second of simulated time per
   * real second. That is the right behaviour for a player on a slow machine and
   * useless for driving the rider somewhere in a diagnostic capture.
   */
  simulate(steps: number, script: ScriptedInput = {}): void {
    const input = this.scriptInput;
    input.steerX = script.steerX ?? 0;
    input.steerY = script.steerY ?? 0;
    input.carve.held = script.carve ?? false;
    input.jump.held = script.jump ?? false;
    input.trick.held = script.trick ?? false;
    input.carve.pressed = false;
    input.trick.released = false;
    // Press edges fire once, on the first step only.
    input.jump.pressed = script.jumpPressed ?? false;
    input.trick.pressed = script.trickPressed ?? false;
    // The router latches these when the modifier engages; scripted runs set them
    // directly, and they must persist so the trick keeps its identity.
    input.trickDirX = script.trickDirX ?? 0;
    input.trickDirY = script.trickDirY ?? 0;
    // Release edges fire once, on the first step only -- an edge that persisted across
    // every step would pay the pump out repeatedly.
    input.carve.released = script.carveReleased ?? false;
    input.jump.released = script.jumpReleased ?? false;

    this.stepCtx.carveAnalog = script.carveAnalog ?? 1;

    // Release the start gate. Everything that calls this -- diagnostic captures, the
    // browser tests, the headless bot -- wants the rider moving, and sitting out a
    // three-second count in a harness that deliberately ignores the wall clock would
    // just be 360 steps of nothing.
    this.race.releaseGate();

    for (let i = 0; i < steps; i++) {
      copyBoardState(this.prevBoard, this.board);
      // Stops at the finish rather than riding on past it.
      if (this.race.prepare(FIXED_DT)) break;
      stepBoard(this.board, input, this.field, FIXED_DT, this.stepCtx);
      this.race.observe(this.board, this.field, FIXED_DT, this.stepCtx.events);
      this.ghost.record(this.board, this.race.time, FIXED_DT);
      // Consume the release edges after the first step, matching how the real input
      // router delivers exactly one edge per physical release.
      input.carve.released = false;
      input.jump.released = false;
      input.jump.pressed = false;
      input.trick.pressed = false;
      if (!this.field.contains(this.board.pos.x, this.board.pos.z)) {
        this.respawn();
        break;
      }
    }
    // No frames were drawn during those steps, so the camera's smoothed state refers
    // to wherever the rider used to be. Snap it, and re-anchor the clock so the loop
    // does not treat the elapsed wall time as simulation it still owes.
    copyBoardState(this.prevBoard, this.board);
    this.chase.reset(this.board);
    this.loop.resync();
  }

  dispose(): void {
    this.loop.stop();
    window.removeEventListener('keydown', this.onDebugKey);
    this.input.dispose();
    this.flyCamera.dispose();
    this.tuningPanel?.dispose();
    window.removeEventListener('keydown', this.onFirstGesture);
    window.removeEventListener('pointerdown', this.onFirstGesture);
    this.audio.dispose();
    this.settingsPanel.dispose();
    this.hud.dispose();
    this.spray.dispose();
    this.scatter.dispose();
    this.markers.dispose();
    this.hints.dispose();
    this.riderView.dispose();
    this.terrain.dispose();
    this.renderer.dispose();
    this.debugEl?.remove();
  }

  /** For the e2e mesh/sampler cross-check: raycast the drawn terrain. */
  raycastTerrain(x: number, z: number): number | null {
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(x, this.field.maxHeight + 50, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(this.terrain.group, true);
    return hits.length > 0 ? hits[0].point.y : null;
  }
}

/** Reused across respawns; nothing in the render path allocates. */
const spawnNormal = v3();

const RACE_STATE_TEXT = ['COUNT', 'RUN', 'DONE'];

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angle interpolation, so crossing +/-PI does not spin the rider. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}
