import { expect, test } from '@playwright/test';

/**
 * Comfort settings, end to end in a real browser.
 *
 * These ship in production, unlike the tuning panel, and they are the one part of the game
 * that has to work for someone who is already feeling ill -- so the things worth asserting
 * are that the panel is reachable without a menu, that moving a knob reaches the camera
 * immediately, and that the choice survives a reload. A setting that silently forgets itself
 * is worse than no setting, because the player has to rediscover it every session.
 */
test.describe('comfort settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
  });

  test('is reachable from the riding HUD, with no menu', async ({ page }) => {
    const panel = page.locator('.settings-panel');
    await expect(panel).not.toHaveClass(/visible/);

    await page.locator('.settings-button').click();
    await expect(panel).toHaveClass(/visible/);

    await page.locator('.settings-close').click();
    await expect(panel).not.toHaveClass(/visible/);
  });

  test('is actually rendered when open, not merely classed', async ({ page }) => {
    // The assertion that would have caught the bug this file was written alongside. The panel
    // originally faded in via opacity and visibility, and under software GL it never appeared:
    // CSS transitions advance on the document timeline, and a frame that takes hundreds of
    // milliseconds starves it -- the transitions sat at currentTime 0 more than a second after
    // the class changed. The panel was interactive and invisible.
    //
    // `toBeVisible()` does not catch that: Playwright's visibility rules ignore `opacity: 0`.
    // Only reading the computed style does. And a player on a weak GPU is the most likely
    // person to need comfort settings, so this is the worst possible element to get wrong.
    await page.locator('.settings-button').click();
    const style = await page.evaluate(() => {
      const panel = document.querySelector('.settings-panel')!;
      const cs = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return {
        display: cs.display,
        opacity: cs.opacity,
        visibility: cs.visibility,
        height: rect.height,
        rows: panel.querySelectorAll('.settings-row').length,
      };
    });
    expect(style.display).not.toBe('none');
    expect(Number(style.opacity)).toBe(1);
    expect(style.visibility).toBe('visible');
    expect(style.height).toBeGreaterThan(50);
    // Four knobs: fov toggle, shake, distance, roll.
    expect(style.rows).toBe(4);
  });

  test('opens on the keyboard shortcut too', async ({ page }) => {
    await page.keyboard.press('KeyC');
    await expect(page.locator('.settings-panel')).toHaveClass(/visible/);
    await page.keyboard.press('KeyC');
    await expect(page.locator('.settings-panel')).not.toHaveClass(/visible/);
  });

  test('does not hijack Escape, which is pause', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-panel')).not.toHaveClass(/visible/);
  });

  test('moving a knob reaches the camera immediately', async ({ page }) => {
    await page.locator('.settings-button').click();

    const before = await page.evaluate(() => ({ ...window.__GAME!.game!.chaseComfort }));
    expect(before.fovWithSpeed).toBe(true);

    // The first row is the field-of-view toggle.
    await page.locator('.settings-row input[type="checkbox"]').first().uncheck();

    const after = await page.evaluate(() => ({ ...window.__GAME!.game!.chaseComfort }));
    expect(after.fovWithSpeed).toBe(false);
  });

  test('a slider reaches the camera and is clamped to its range', async ({ page }) => {
    await page.locator('.settings-button').click();
    const shake = page.locator('.settings-row input[type="range"]').first();
    await shake.fill('0');

    const comfort = await page.evaluate(() => ({ ...window.__GAME!.game!.chaseComfort }));
    expect(comfort.shakeScale).toBe(0);
  });

  test('survives a reload', async ({ page }) => {
    await page.locator('.settings-button').click();
    await page.locator('.settings-row input[type="checkbox"]').first().uncheck();
    await page.locator('.settings-row input[type="range"]').first().fill('0.25');

    const stored = await page.evaluate(() => localStorage.getItem('whiteout.settings.v1'));
    expect(stored).not.toBeNull();

    await page.reload();
    await page.waitForFunction(() => window.__GAME?.ready === true);

    const comfort = await page.evaluate(() => ({ ...window.__GAME!.game!.chaseComfort }));
    expect(comfort.fovWithSpeed).toBe(false);
    expect(comfort.shakeScale).toBeCloseTo(0.25, 5);
  });

  test('falls back to the defaults when storage holds nonsense', async ({ page }) => {
    // Storage is user-editable text that may have been written by an older version. A corrupt
    // blob must not stop the game booting -- least of all for the settings someone who gets
    // motion sick has already had to find once.
    await page.evaluate(() => {
      localStorage.setItem('whiteout.settings.v1', '{"comfort":{"distanceScale":"orbit"');
    });
    await page.reload();
    await page.waitForFunction(() => window.__GAME?.ready === true);

    expect(await page.evaluate(() => window.__GAME?.error)).toBeNull();
    const comfort = await page.evaluate(() => ({ ...window.__GAME!.game!.chaseComfort }));
    expect(comfort.distanceScale).toBe(1);
  });

  test('clamps a wild stored value instead of trusting it', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem(
        'whiteout.settings.v1',
        JSON.stringify({ comfort: { distanceScale: 500, rollDegrees: -90 } }),
      );
    });
    await page.reload();
    await page.waitForFunction(() => window.__GAME?.ready === true);

    const comfort = await page.evaluate(() => ({ ...window.__GAME!.game!.chaseComfort }));
    expect(comfort.distanceScale).toBeLessThanOrEqual(1.8);
    expect(comfort.rollDegrees).toBeGreaterThanOrEqual(0);
  });
});
