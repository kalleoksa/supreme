import { expect, test } from '@playwright/test';

/**
 * A whole run, in the shipped bundle.
 *
 * The race logic is covered far more thoroughly in Node (`race.test.ts`, `botRun.test.ts`).
 * What only this suite can prove is that the assembled game -- progress field baked from
 * the real heightfield at load, race stepped from the real loop, HUD wired to the real
 * events -- gets a rider from the gate to the finish and puts a time on screen.
 *
 * `simulate()` again rather than wall-clock time: under software GL the loop correctly
 * degrades to slow motion, so a real-time run covers no ground.
 */
test.describe('racing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
  });

  test('bakes a progress field the start can finish from', async ({ page }) => {
    const info = await page.evaluate(() => {
      const field = window.__GAME!.game!.progressField;
      const slope = window.__GAME!.game!.slope;
      return {
        reachable: field.reachable,
        maxDistance: field.maxDistance,
        atStart: field.progressAt(slope.startX, slope.startZ),
        atFinish: field.progressAt(0, slope.finish[0].z),
      };
    });

    expect(info.reachable).toBe(true);
    // Geodesic length of a 1.2 km course: longer than the straight line, not absurdly so.
    expect(info.maxDistance).toBeGreaterThan(1000);
    expect(info.maxDistance).toBeLessThan(2000);
    expect(info.atStart).toBeLessThan(0.1);
    expect(info.atFinish).toBeGreaterThan(0.98);
  });

  test('holds the rider on the gate until the count ends', async ({ page }) => {
    const result = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      const before = h.riderState()!;
      // One frame of the real loop: the count is running, so nothing should move.
      h.frameStep();
      const race = h.raceState()!;
      const after = h.riderState()!;
      return { before, after, race };
    });

    expect(result.race.state).toBe(0);
    expect(result.race.countdown).toBeGreaterThan(0);
    expect(result.race.time).toBe(0);
    expect(result.after.z).toBeCloseTo(result.before.z, 6);
    expect(result.after.speed).toBeCloseTo(result.before.speed, 6);
  });

  test('rides from the gate to the finish and reports a time', async ({ page }) => {
    const result = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      // Tucked and straight. The bare test slope's cross profile keeps the rider in the
      // corridor without steering, which is what makes this a clean end-to-end check
      // rather than a test of a bot.
      h.simulate(120 * 150, { steerY: 1 });
      return { race: h.raceState()!, rider: h.riderState()! };
    });

    expect(result.race.state).toBe(2);
    expect(result.race.finishTime).toBeGreaterThan(25);
    expect(result.race.finishTime).toBeLessThan(120);
    expect(result.race.splits.every((t) => t >= 0)).toBe(true);
    expect(result.race.flaggedJumps).toBe(0);
    // Made it down the mountain, not merely to the far edge of the field.
    expect(result.rider.z).toBeGreaterThan(1100);
  });

  test('shows the finish time on the HUD', async ({ page }) => {
    await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      h.simulate(120 * 150, { steerY: 1 });
      // simulate() draws nothing, so give the HUD a frame to catch up.
      h.frameStep();
    });

    const results = page.locator('.hud-results');
    await expect(results).toHaveClass(/visible/);
    // `0:41.23` shape: the run took tens of seconds, not zero.
    await expect(page.locator('.hud-results-time')).toHaveText(/^0:[0-9]{2}\.[0-9]{2}$/);
    await expect(page.locator('.hud-time')).toHaveText(/^0:[0-9]{2}\.[0-9]{2}$/);
  });

  test('stores the run as a personal best and compares the next one to it', async ({ page }) => {
    const stored = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      h.simulate(120 * 150, { steerY: 1 });
      h.frameStep();
      const raw = localStorage.getItem('whiteout.best.v1.testslope');
      return { raw, finishTime: h.raceState()!.finishTime };
    });

    expect(stored.raw).not.toBeNull();
    const best = JSON.parse(stored.raw!) as { time: number; splits: number[] };
    expect(best.time).toBeCloseTo(stored.finishTime, 6);
    expect(best.splits).toHaveLength(3);

    // A second, identical run ties rather than beats, and the panel says so.
    await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      h.simulate(120 * 150, { steerY: 1 });
      h.frameStep();
    });
    await expect(page.locator('.hud-results-best')).toHaveText(/PERSONAL BEST|best 0:/);
  });

  test('warns and recovers when the rider leaves the course', async ({ page }) => {
    const result = await page.evaluate(() => {
      const h = window.__GAME!;
      const game = h.game!;
      h.respawn();

      // Hold the rider outside the bounds for longer than the grace window. It has to be
      // re-placed between batches because the containment shoulder is doing its job and
      // pushing them back toward the course -- which is the point of the shoulder, and
      // exactly why steering out here and waiting would take longer than the recovery.
      const park = (): void => {
        game.board.pos.x = 175;
        game.board.pos.z = 400;
        game.board.pos.y = game.field.height(175, 400) + 0.06;
      };
      park();
      h.simulate(30);
      const warned = h.raceState()!;
      for (let i = 0; i < 10 && h.raceState()!.resets === 0; i++) {
        park();
        h.simulate(60);
      }
      return { warned, after: h.raceState()!, rider: h.riderState()! };
    });

    expect(result.warned.oob).toBe(true);
    expect(result.warned.oobDistance).toBeLessThan(0);
    expect(result.after.resets).toBeGreaterThanOrEqual(1);
    // Back inside, and the clock never stopped.
    expect(Math.abs(result.rider.x)).toBeLessThan(140);
    expect(result.after.time).toBeGreaterThan(3);
  });

  test('draws the finish and split markers without blowing the draw budget', async ({ page }) => {
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const game = window.__GAME!.game!;
      let markerMeshes = 0;
      game.markers.group.traverse((o) => {
        if ((o as { isMesh?: boolean }).isMesh) markerMeshes++;
      });
      return { markerMeshes, calls: window.__GAME!.renderInfo()!.calls };
    });

    // One curtain for the finish, one merged mesh for all three splits.
    expect(info.markerMeshes).toBe(2);
    expect(info.calls).toBeLessThan(50);
  });
});
