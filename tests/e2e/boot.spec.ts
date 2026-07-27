import { expect, test } from '@playwright/test';

test.describe('boot', () => {
  test('loads with no console errors and reports ready', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true, undefined, {
      timeout: 30_000,
    });

    expect(await page.evaluate(() => window.__GAME?.error)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('hides the boot overlay and sets the title', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
    await expect(page.locator('#boot')).toHaveClass(/hidden/);
    expect(await page.title()).toBe('Whiteout');
  });

  test('the drawn mesh and the physics sampler describe one surface', async ({ page }) => {
    // The unit suite proves this against generated geometry; this proves it again
    // against the geometry the *shipped bundle* actually uploaded, so a build-time
    // transform cannot silently break the agreement.
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);

    const worst = await page.evaluate(() => {
      const h = window.__GAME!;
      let max = 0;
      let checked = 0;
      for (let k = 0; k < 200; k++) {
        const x = -120 + (240 * k) / 200;
        const z = 40 + (1000 * ((k * 37) % 200)) / 200;
        const sampled = h.sampleHeight(x, z);
        const drawn = h.raycastHeight(x, z);
        if (sampled === null || drawn === null) continue;
        max = Math.max(max, Math.abs(sampled - drawn));
        checked++;
      }
      return { max, checked };
    });

    expect(worst.checked).toBeGreaterThan(150);
    // Looser than the unit test's 1e-4: the raycast here may land on a coarser LOD
    // chunk away from the camera, which legitimately deviates from the full-res
    // surface. The point is that it is centimetres, not metres.
    expect(worst.max).toBeLessThan(2.5);
  });
});
