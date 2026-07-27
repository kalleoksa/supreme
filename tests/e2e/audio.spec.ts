import { expect, test } from '@playwright/test';

/**
 * The audio layer, in a real browser.
 *
 * **What this cannot test is whether it sounds good.** That is a listening job, and the mix
 * constants in `Audio.ts` are conservative starting values nobody has heard yet. What it can
 * test is everything around that, and those are the parts that break silently:
 *
 *  - the AudioContext actually reaches `running` after a gesture, which is the classic
 *    "audio works on my machine" bug -- it works fine after a hot reload, because the page has
 *    already been interacted with;
 *  - wind rises with speed and edge hiss with skid, so the two voices are wired to the two
 *    numbers they are supposed to track rather than to each other;
 *  - muting reaches the master gain, rather than only setting a checkbox.
 */
test.describe('audio', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
  });

  test('does not start before a user gesture, and starts after one', async ({ page }) => {
    // Before: the graph must not even exist. A context created at boot is born suspended and
    // some browsers log a warning; more importantly, building it eagerly hides the bug.
    const before = await page.evaluate(() => window.__GAME!.audioState());
    expect(before).not.toBeNull();
    expect(before!.state).toBe('none');
    expect(before!.running).toBe(false);

    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => window.__GAME!.audioState()!.state !== 'none');

    const after = await page.evaluate(() => window.__GAME!.audioState());
    expect(['running', 'suspended']).toContain(after!.state);
  });

  test('starts from a pointer gesture too', async ({ page }) => {
    await page.mouse.click(400, 300);
    await page.waitForFunction(() => window.__GAME!.audioState()!.state !== 'none');
    expect(await page.evaluate(() => window.__GAME!.audioState()!.state)).not.toBe('none');
  });

  test('wind rises with speed', async ({ page }) => {
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => window.__GAME!.audioState()!.running === true, undefined, {
      timeout: 15_000,
    });

    const readings = await page.evaluate(async () => {
      const h = window.__GAME!;
      // A frame is needed between each sample, because the gain follows from `update()`.
      const sample = async (): Promise<{ wind: number; cutoff: number }> => {
        h.frameStep();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const a = h.audioState()!;
        return { wind: a.wind, cutoff: a.windCutoff };
      };
      h.respawn();
      h.simulate(1);
      const slow = await sample();
      // Well up to speed.
      h.simulate(120 * 12, { steerY: 1 });
      const fast = await sample();
      return { slow, fast, kmh: h.riderState()!.kmh };
    });

    expect(readings.kmh).toBeGreaterThan(50);
    expect(readings.fast.wind).toBeGreaterThan(readings.slow.wind);
    // The filter opens up with speed too, which is what stops it reading as a volume knob.
    expect(readings.fast.cutoff).toBeGreaterThan(readings.slow.cutoff);
  });

  test('edge hiss tracks skid rather than speed', async ({ page }) => {
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => window.__GAME!.audioState()!.running === true, undefined, {
      timeout: 15_000,
    });

    const readings = await page.evaluate(async () => {
      const h = window.__GAME!;
      const sample = async (): Promise<number> => {
        h.frameStep();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return h.audioState()!.hiss;
      };
      h.respawn();
      // Straight and tucked: fast, but barely sliding.
      h.simulate(120 * 8, { steerY: 1 });
      const straightSkid = h.riderState()!.skid;
      const straight = await sample();
      // Hard across the hill with no edge, which is the definition of a skid.
      h.simulate(120 * 2, { steerX: 1 });
      const slidingSkid = h.riderState()!.skid;
      const sliding = await sample();
      return { straight, sliding, straightSkid, slidingSkid };
    });

    // Sanity: the manoeuvre really did produce more skid.
    expect(readings.slidingSkid).toBeGreaterThan(readings.straightSkid);
    expect(readings.sliding).toBeGreaterThan(readings.straight);
  });

  test('muting reaches the master gain', async ({ page }) => {
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => window.__GAME!.audioState()!.running === true, undefined, {
      timeout: 15_000,
    });
    expect(await page.evaluate(() => window.__GAME!.audioState()!.master)).toBeGreaterThan(0);

    await page.locator('.settings-button').click();
    // The second checkbox is the sound toggle; the first is the field-of-view one.
    await page.locator('.settings-row input[type="checkbox"]').nth(1).uncheck();

    await page.waitForFunction(() => window.__GAME!.audioState()!.master < 0.01, undefined, {
      timeout: 5000,
    });
    expect(await page.evaluate(() => window.__GAME!.audioState()!.master)).toBeLessThan(0.01);
  });

  test('the sound setting survives a reload', async ({ page }) => {
    await page.locator('.settings-button').click();
    await page.locator('.settings-row input[type="checkbox"]').nth(1).uncheck();

    await page.reload();
    await page.waitForFunction(() => window.__GAME?.ready === true);
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('whiteout.settings.v1');
      return raw === null ? null : (JSON.parse(raw) as { audio?: { enabled?: boolean } });
    });
    expect(stored?.audio?.enabled).toBe(false);
  });

  test('a browser with no Web Audio does not stop the game booting', async ({ page }) => {
    // Audio is the least important thing on screen and must never be able to take the game
    // down with it. Locked-down browsers and some embedded webviews really do lack this.
    await page.addInitScript(() => {
      // @ts-expect-error deliberately removing a global for the test
      delete window.AudioContext;
      // @ts-expect-error ditto the prefixed alias
      delete window.webkitAudioContext;
    });
    await page.reload();
    await page.waitForFunction(() => window.__GAME?.ready === true);
    await page.keyboard.press('KeyP');

    expect(await page.evaluate(() => window.__GAME?.error)).toBeNull();
    // And the rider still rides.
    const moved = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      const start = h.riderState()!.z;
      h.simulate(120 * 5, { steerY: 1 });
      return h.riderState()!.z - start;
    });
    expect(moved).toBeGreaterThan(20);
  });
});
