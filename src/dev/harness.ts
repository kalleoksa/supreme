import type { Game } from '../app/Game.js';

/**
 * Test surface exposed on `window.__GAME`.
 *
 * Playwright drives the real bundle through this rather than through synthetic
 * screenshots, which is what lets the e2e suite assert structural facts -- draw
 * call counts, shader compilation, sub-frame input edges -- on a machine with no
 * GPU.
 */
export interface GameHarness {
  ready: boolean;
  error: string | null;
  game: Game | null;
  /** Draw calls and triangles from the most recent frame. */
  renderInfo(): { calls: number; triangles: number } | null;
  /** Advance exactly one frame, for deterministic input-edge assertions. */
  frameStep(): void;
  /**
   * Place the camera explicitly, for capturing diagnostic views of a track.
   *
   * Worth having beyond tests: judging terrain from one fixed vantage is
   * misleading, and the useful question is always "what does this look like from
   * where the player will be".
   */
  setView(x: number, y: number, z: number, yaw: number, pitch?: number): void;
  /** Height of the terrain surface plus an offset, for placing a view on the snow. */
  viewFromSurface(x: number, z: number, above: number, yaw: number, pitch?: number): void;
  /** Terrain height under (x, z) as the *sampler* sees it. */
  sampleHeight(x: number, z: number): number | null;
  /** Terrain height under (x, z) as the *drawn mesh* sees it. */
  raycastHeight(x: number, z: number): number | null;
  /**
   * Render one frame and sample the framebuffer in the same synchronous block,
   * returning a coarse colour histogram.
   *
   * The synchronicity is the whole point. WebGL clears the drawing buffer once it
   * is composited, so a `readPixels` from a later task sees all zeros -- which
   * looks exactly like "the game rendered nothing". Setting
   * `preserveDrawingBuffer` would fix that at a real cost to every frame players
   * ever see, so instead the read happens before the browser gets a chance to
   * composite.
   */
  framePixelStats(): { distinct: number; lit: number } | null;
  /** Force a context loss, to verify the loss path. */
  loseContext(): boolean;
  /**
   * Force a restore. A synthetic `loseContext()` never auto-restores -- a real GPU
   * reset does -- so both halves have to be driven explicitly to test the path.
   */
  restoreContext(): boolean;
}

declare global {
  interface Window {
    __GAME?: GameHarness;
  }
}

export function installHarness(): GameHarness {
  // Cached deliberately: once the context is lost, getExtension() returns null,
  // so re-fetching it would leave no way to ask for a restore.
  let cachedLoseExt: WEBGL_lose_context | null = null;
  const loseContextExtension = (): WEBGL_lose_context | null => {
    if (cachedLoseExt) return cachedLoseExt;
    const gl = harness.game?.renderer.renderer.getContext();
    cachedLoseExt = gl?.getExtension('WEBGL_lose_context') ?? null;
    return cachedLoseExt;
  };

  const harness: GameHarness = {
    ready: false,
    error: null,
    game: null,
    renderInfo() {
      if (!harness.game) return null;
      const info = harness.game.renderer.info;
      return { calls: info.calls, triangles: info.triangles };
    },
    frameStep() {
      harness.game?.frameStep();
    },
    setView(x, y, z, yaw, pitch) {
      harness.game?.setView(x, y, z, yaw, pitch);
    },
    viewFromSurface(x, z, above, yaw, pitch) {
      const game = harness.game;
      if (!game) return;
      game.setView(x, game.field.height(x, z) + above, z, yaw, pitch);
    },
    sampleHeight(x, z) {
      if (!harness.game) return null;
      return harness.game.field.height(x, z);
    },
    raycastHeight(x, z) {
      if (!harness.game) return null;
      return harness.game.raycastTerrain(x, z);
    },
    framePixelStats() {
      const game = harness.game;
      if (!game) return null;
      const gl = game.renderer.renderer.getContext();

      game.frameStep();

      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      const buckets = new Set<number>();
      let lit = 0;
      // Stride over a prime number of pixels: a cheap way to sample the whole
      // frame without walking millions of bytes or aligning with any pattern in it.
      for (let i = 0; i < px.length; i += 4 * 97) {
        const r = px[i] >> 4;
        const g = px[i + 1] >> 4;
        const b = px[i + 2] >> 4;
        buckets.add((r << 8) | (g << 4) | b);
        if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
      }
      return { distinct: buckets.size, lit };
    },
    loseContext() {
      const ext = loseContextExtension();
      if (!ext) return false;
      ext.loseContext();
      return true;
    },
    restoreContext() {
      const ext = loseContextExtension();
      if (!ext) return false;
      ext.restoreContext();
      return true;
    },
  };

  window.__GAME = harness;
  return harness;
}
