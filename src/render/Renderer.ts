import * as THREE from 'three';
import { MAX_PIXEL_RATIO, VIEW_DISTANCE } from '../app/config.js';

export interface RendererEvents {
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/**
 * Owns the WebGL renderer, the scene and the camera.
 *
 * Two pieces of housekeeping here are not optional, and both are cheaper to do
 * now than to retrofit when the game reaches a phone:
 *
 *  - `webglcontextlost` / `webglcontextrestored`. Context loss is a live bug
 *    class on iOS Safari; without a handler the canvas silently goes black and
 *    stays black.
 *  - A *debounced* resize. Resizing a WebGL canvas frequently leaks memory on
 *    iOS (WebKit 219780), so we never resize per frame.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSize = { w: 0, h: 0 };
  private contextLost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: RendererEvents = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // A stencil buffer we never use is memory we cannot spare later.
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    // No shadow maps anywhere in M1: a shadow pass doubles the geometry draw
    // calls, and air height is communicated by a blob shadow decal instead.
    this.renderer.shadowMap.enabled = false;
    this.renderer.setClearColor(0x0a0d12, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, VIEW_DISTANCE * 1.2);
    this.camera.position.set(0, 10, 20);

    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    window.addEventListener('resize', this.handleResize);

    this.applySize(window.innerWidth, window.innerHeight);
  }

  private handleContextLost = (e: Event): void => {
    // Must preventDefault, otherwise the browser will not fire a restore event.
    e.preventDefault();
    this.contextLost = true;
    this.events.onContextLost?.();
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
    // three.js re-uploads its own resources; we only need to reassert the state
    // we set outside of it.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.applySize(this.pendingSize.w, this.pendingSize.h);
    this.events.onContextRestored?.();
  };

  private handleResize = (): void => {
    this.pendingSize.w = window.innerWidth;
    this.pendingSize.h = window.innerHeight;
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.applySize(this.pendingSize.w, this.pendingSize.h);
    }, 120);
  };

  private applySize(w: number, h: number): void {
    const width = Math.max(1, w);
    const height = Math.max(1, h);
    this.pendingSize.w = width;
    this.pendingSize.h = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    if (this.contextLost) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Draw-call and triangle counters, asserted by the e2e budget test. */
  get info(): THREE.WebGLInfo['render'] {
    return this.renderer.info.render;
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  dispose(): void {
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.renderer.dispose();
  }
}
