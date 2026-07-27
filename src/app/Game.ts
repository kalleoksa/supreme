import * as THREE from 'three';
import { Loop, type LoopHandlers } from './Loop.js';
import { RealClock } from './Clock.js';
import { Renderer } from '../render/Renderer.js';
import { Environment } from '../render/Environment.js';
import { TerrainMesh } from '../render/TerrainMesh.js';
import { FlyCamera } from '../dev/FlyCamera.js';
import { buildTestSlope, type TestSlope } from '../track/testSlope.js';
import type { Heightfield } from '../sim/Heightfield.js';
import { createContact, type Contact } from '../sim/Terrain.js';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  /** Show the frame/terrain readout and enable the fly camera. */
  debug?: boolean;
}

/**
 * Wires everything together and owns the loop.
 *
 * Phase 1 scope: terrain, environment and a free-fly camera. The `step` hook is
 * already the fixed-timestep seam the board simulation drops into next -- the loop
 * shape does not change when a rider arrives.
 */
export class Game implements LoopHandlers {
  readonly renderer: Renderer;
  readonly environment: Environment;
  readonly terrain: TerrainMesh;
  readonly field: Heightfield;
  readonly slope: TestSlope;
  readonly loop: Loop;

  private readonly flyCamera: FlyCamera;
  private readonly debugEl: HTMLElement | undefined;
  private readonly probe: Contact = createContact();
  private lastDebugText = '';
  private debugAccum = 0;

  constructor(private readonly options: GameOptions) {
    this.renderer = new Renderer(options.canvas, {
      onContextLost: () => {
        // Stop simulating while there is nothing to draw into, and re-anchor the
        // clock on restore so the gap is not replayed as a giant timestep.
        this.loop.stop();
      },
      onContextRestored: () => {
        this.loop.resync();
        this.loop.start();
      },
    });

    this.environment = new Environment(this.renderer.scene);

    this.slope = buildTestSlope();
    this.field = this.slope.field;

    this.terrain = new TerrainMesh(this.field, this.environment);
    this.renderer.scene.add(this.terrain.group);

    this.flyCamera = new FlyCamera(this.renderer.camera, options.canvas);
    this.flyCamera.enabled = options.debug ?? false;

    const startY = this.field.height(this.slope.startX, this.slope.startZ);
    this.flyCamera.lookFrom(this.slope.startX, startY + 22, this.slope.startZ - 40, Math.PI);

    if (options.debug) {
      const el = document.createElement('div');
      el.id = 'debug';
      options.hud.appendChild(el);
      this.debugEl = el;
    }

    this.loop = new Loop(new RealClock(), this);
  }

  step(_tick: number, _dt: number): void {
    // Phase 2 attaches Board.step / Trick.step / Race.step here.
  }

  render(_alpha: number, frameDt: number): void {
    this.flyCamera.update(frameDt);

    const cam = this.renderer.camera.position;
    this.terrain.update(cam.x, cam.z);
    this.renderer.render();

    if (this.debugEl) this.updateDebug(frameDt);
  }

  private updateDebug(frameDt: number): void {
    // Throttle: rewriting text every frame is layout thrash for information a
    // human cannot read at 120 Hz anyway.
    this.debugAccum += frameDt;
    if (this.debugAccum < 0.1) return;
    this.debugAccum = 0;

    const cam = this.renderer.camera.position;
    const info = this.renderer.info;
    const inBounds = this.field.contains(cam.x, cam.z);
    if (inBounds) this.field.support(cam.x, cam.z, cam.y, 0, this.probe);

    const text = [
      `fps      ${(1 / Math.max(frameDt, 1e-6)).toFixed(0)}  steps ${this.loop.stats.steps}${
        this.loop.stats.starved ? ' STARVED' : ''
      }`,
      `tick     ${this.loop.stats.tick}`,
      `draws    ${info.calls}   tris ${info.triangles.toLocaleString('en-US')}`,
      `chunks   ${this.terrain.chunkCount}`,
      `cam      ${cam.x.toFixed(1)} ${cam.y.toFixed(1)} ${cam.z.toFixed(1)}`,
      inBounds
        ? `ground   ${this.probe.y.toFixed(2)} m  n.y ${this.probe.ny.toFixed(3)}  surf ${this.probe.surface}`
        : 'ground   (outside field)',
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

  /** Advance exactly one frame. Used by the e2e input tests. */
  frameStep(): void {
    this.loop.advance();
  }

  /** Place the camera explicitly. Used for capturing diagnostic views. */
  setView(x: number, y: number, z: number, yaw: number, pitch = -0.2): void {
    this.flyCamera.setPose(x, y, z, yaw, pitch);
  }

  dispose(): void {
    this.loop.stop();
    this.flyCamera.dispose();
    this.terrain.dispose();
    this.renderer.dispose();
    this.debugEl?.remove();
    void this.options;
  }

  /** For the e2e mesh/sampler cross-check: raycast the drawn terrain. */
  raycastTerrain(x: number, z: number): number | null {
    const raycaster = new THREE.Raycaster();
    const from = new THREE.Vector3(x, this.field.maxHeight + 50, z);
    raycaster.set(from, new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(this.terrain.group, true);
    return hits.length > 0 ? hits[0].point.y : null;
  }
}
