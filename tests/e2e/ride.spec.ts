import { expect, test } from '@playwright/test';

/**
 * End-to-end riding, driven through the shipped bundle.
 *
 * The physics itself is covered far more thoroughly in Node (`board.test.ts`), where
 * it runs in milliseconds. What only this suite can prove is that the assembled game
 * -- input router, loop, simulation, camera, HUD -- actually moves a rider down a
 * mountain, and that the build did not break the wiring between them.
 *
 * Everything here uses `simulate()` rather than real key presses and wall-clock time.
 * Under software GL the loop renders at a handful of frames per second and correctly
 * clamps at MAX_STEPS, degrading to slow motion -- so a real-time run covers almost
 * no ground and would tell us nothing.
 */
test.describe('riding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__GAME?.ready === true);
  });

  test('descends the mountain and stays on the surface', async ({ page }) => {
    const result = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      const start = h.riderState()!;
      // 12 s of simulated time, tucked.
      h.simulate(120 * 12, { steerY: 1 });
      const end = h.riderState()!;
      return {
        start,
        end,
        surfaceGap: end.y - h.sampleHeight(end.x, end.z)!,
      };
    });

    // Went downhill, which on this slope means +Z and falling y.
    expect(result.end.z).toBeGreaterThan(result.start.z + 150);
    expect(result.end.y).toBeLessThan(result.start.y - 30);

    // A real cruise, in the band the grade profile was designed around.
    expect(result.end.kmh).toBeGreaterThan(50);
    expect(result.end.kmh).toBeLessThan(160);

    // Neither sunk into the surface nor floating above it.
    expect(result.surfaceGap).toBeGreaterThan(-0.05);
    expect(result.surfaceGap).toBeLessThan(1.5);
  });

  test('the chase camera stays behind, above and near the rider', async ({ page }) => {
    // A camera that drifts is the failure this catches. It was measured at 29 m above
    // the rider after a respawn, because nothing snapped its smoothed height when the
    // rider teleported.
    const geometry = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      h.simulate(120 * 8, { steerY: 1 });
      const g = h.game!;
      const cam = g.renderer.camera.position;
      const b = g.board;
      return {
        above: cam.y - b.pos.y,
        behind: Math.hypot(cam.x - b.pos.x, cam.z - b.pos.z),
      };
    });

    expect(geometry.above).toBeGreaterThan(0.5);
    expect(geometry.above).toBeLessThan(8);
    expect(geometry.behind).toBeGreaterThan(3);
    expect(geometry.behind).toBeLessThan(14);
  });

  test('a carve costs speed but the rider recovers and keeps descending', async ({ page }) => {
    // Guards the spin-out spiral: a yaw rate that falls with speed makes turning scrub
    // speed, which raises the rate, which scrubs more. One held input used to leave the
    // board stationary and facing uphill with no way back.
    const run = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      h.simulate(120 * 8, { steerY: 1 });
      const before = h.riderState()!;
      h.simulate(120 * 3, { steerX: 1, carve: true });
      const during = h.riderState()!;
      // Steer back toward the fall line, then tuck -- what a player does. Three
      // seconds of full lock leaves the board traversing across the hill, and a
      // traverse holds its altitude by design: it is not a stuck state, it just is
      // not descending, and only steering changes that.
      h.simulate(120 * 2, { steerX: 0.6 });
      h.simulate(120 * 5, { steerY: 1 });
      const after = h.riderState()!;
      return { before, during, after };
    });

    // Carving hard scrubs speed -- it should cost something.
    expect(run.during.kmh).toBeLessThan(run.before.kmh);
    // But never into a standstill.
    expect(run.during.kmh).toBeGreaterThan(8);
    // And steering out of it gets the rider descending again.
    expect(run.after.kmh).toBeGreaterThan(20);
    expect(run.after.z).toBeGreaterThan(run.during.z + 20);
  });

  test('the HUD reports the speed the simulation is actually carrying', async ({ page }) => {
    const shown = await page.evaluate(async () => {
      const h = window.__GAME!;
      h.respawn();
      h.simulate(120 * 9, { steerY: 1 });
      // One frame so the HUD reads the new state.
      h.frameStep();
      const el = document.querySelector('.hud-speed-value');
      return { text: el?.textContent ?? '', kmh: h.riderState()!.kmh };
    });

    const displayed = Number(shown.text);
    expect(Number.isFinite(displayed)).toBe(true);
    // The HUD renders an interpolated pose, so allow a step's worth of difference.
    expect(Math.abs(displayed - shown.kmh)).toBeLessThan(3);
  });

  test('respawn returns the rider to the start gate', async ({ page }) => {
    const result = await page.evaluate(() => {
      const h = window.__GAME!;
      h.respawn();
      const gate = h.riderState()!;
      h.simulate(120 * 10, { steerY: 1 });
      const away = h.riderState()!;
      h.respawn();
      return { gate, away, back: h.riderState()! };
    });

    expect(result.away.z).toBeGreaterThan(result.gate.z + 100);
    expect(result.back.z).toBeCloseTo(result.gate.z, 1);
    expect(result.back.kmh).toBeCloseTo(result.gate.kmh, 1);
  });
});
