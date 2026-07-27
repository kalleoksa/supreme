import { expect, test } from '@playwright/test';

/**
 * Structural WebGL assertions under software GL.
 *
 * SwiftShader renders at single-digit frame rates, so anything resembling an fps
 * assertion here would be a flaky test. What this suite *can* prove is that the
 * shaders compile, the framebuffer is not blank, and the draw-call budget holds --
 * and the budget is the thing that decides whether this ever runs on a phone.
 */
test.describe('webgl', () => {
  test('stays inside the draw call budget', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
    // Let LOD settle: the first frame deliberately draws everything coarse.
    await page.waitForTimeout(1500);

    const info = await page.evaluate(() => window.__GAME?.renderInfo());
    expect(info).not.toBeNull();
    // The M1 budget is 50. Terrain alone should be well under it; when scatter,
    // the rider, particles and world hints arrive this is the number that keeps
    // them honest.
    expect(info!.calls).toBeGreaterThan(0);
    expect(info!.calls).toBeLessThan(50);
    expect(info!.triangles).toBeGreaterThan(1000);
  });

  test('compiles shaders and renders a non-blank frame', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/shader|glsl|compile|WebGL/i.test(text) && msg.type() === 'error') errors.push(text);
    });

    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
    await page.waitForTimeout(1200);

    expect(errors).toEqual([]);

    // Pixel histogram: a black or single-colour frame means nothing was drawn,
    // which is the failure mode a screenshot-only check would happily accept.
    const spread = await page.evaluate(() => window.__GAME!.framePixelStats());

    expect(spread).not.toBeNull();
    expect(spread!.lit).toBeGreaterThan(0);
    // More than a couple of distinct colours means real shading, not a clear colour.
    expect(spread!.distinct).toBeGreaterThan(3);

    await page.screenshot({ path: 'test-results/terrain.png' });
  });

  test('survives a lost context and resumes drawing on restore', async ({ page }) => {
    // Context loss is a live bug class on iOS Safari, and without a restore path
    // the canvas goes black permanently. Both halves are driven explicitly here: a
    // synthetic loss never auto-restores the way a real GPU reset does.
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
    await page.waitForTimeout(600);

    const supported = await page.evaluate(() => window.__GAME?.loseContext());
    if (!supported) test.skip(true, 'WEBGL_lose_context unavailable in this build');

    await page.waitForTimeout(400);
    // While the context is gone the game must stop simulating rather than run on
    // blind and accumulate a giant timestep to replay on return.
    expect(
      await page.evaluate(() => {
        const h = window.__GAME!;
        return { lost: h.game!.renderer.isContextLost, running: h.game!.loop.isRunning };
      }),
    ).toEqual({ lost: true, running: false });

    await page.evaluate(() => window.__GAME!.restoreContext());
    await page.waitForTimeout(1200);

    const after = await page.evaluate(() => {
      const h = window.__GAME!;
      return {
        lost: h.game!.renderer.isContextLost,
        running: h.game!.loop.isRunning,
        calls: h.renderInfo()!.calls,
      };
    });
    expect(after.lost).toBe(false);
    expect(after.running).toBe(true);
    // The real assertion: it is drawing again, not merely un-flagged.
    expect(after.calls).toBeGreaterThan(0);
  });

  test('caps the device pixel ratio', async ({ page }) => {
    // Adopted from the first commit because it is free now and a retrofit later.
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
    const ratio = await page.evaluate(() => window.__GAME!.game!.renderer.renderer.getPixelRatio());
    expect(ratio).toBeLessThanOrEqual(1.5);
  });
});
