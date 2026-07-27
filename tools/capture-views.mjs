// Capture diagnostic views of the terrain from several vantage points.
//
//   npm run build && npm run preview &      # then, in another shell:
//   node tools/capture-views.mjs            # writes view-*.png to OUT (default .)
//
// Why this exists: judging terrain from a single fixed camera is actively
// misleading. An early pass here looked like a rendering bug -- a dark band across
// the mountain -- which turned out to be the camera sitting 22 m above a slope that
// drops 300 m, compressing the whole valley edge-on. The useful question is always
// "what does this look like from where the player will be", and that means several
// vantage points at rider height.
//
// It complements the numeric checks in tests/unit/terrainGeneration.test.ts rather
// than replacing them: measure first, then look.
import { chromium } from '@playwright/test';

const VIEWS = [
  // [label, x, z, metresAboveSurface, yaw, pitch]
  // Rider's eye: low, on the snow, looking downhill. The only view that matters.
  ['rider-top', 0, 40, 2.5, Math.PI, -0.06],
  ['rider-mid', 0, 360, 2.5, Math.PI, -0.06],
  ['rider-chute', 0, 780, 2.5, Math.PI, -0.08],
  // Approaching the big mellow booter at z=700.
  ['roller-700', 6, 660, 3, Math.PI, -0.05],
  // Chase-camera standoff, roughly where Phase 2's camera will sit.
  ['chase', 0, 180, 9, Math.PI, -0.22],
  // Overview from the side, to read the whole cross-section. Yaw +PI/2 looks along
  // -X: rotating the base forward (0,0,-1) about Y by theta gives
  // (-sin theta, 0, -cos theta), so theta = PI/2 points at (-1, 0, 0).
  ['cross-section', 190, 420, 120, Math.PI / 2, -0.5],
];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(process.env.URL ?? 'http://127.0.0.1:4173/');
await page.waitForFunction(() => window.__GAME?.ready === true);

const outDir = process.env.OUT ?? '.';
for (const [label, x, z, above, yaw, pitch] of VIEWS) {
  await page.evaluate(
    ([x, z, above, yaw, pitch]) => window.__GAME.viewFromSurface(x, z, above, yaw, pitch),
    [x, z, above, yaw, pitch],
  );
  // Let LOD settle around the new position, then draw a few frames.
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => window.__GAME.renderInfo());
  console.log(`${label}: draws=${info.calls} tris=${info.triangles}`);
  await page.screenshot({ path: `${outDir}/view-${label}.png` });
}

await browser.close();
