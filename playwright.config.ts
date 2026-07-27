import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Which Chromium to launch.
 *
 * Some development containers ship a preinstalled Chromium whose revision does not
 * match the one this @playwright/test version would download. Pointing at that
 * binary avoids a pointless download, and the structural assertions in this suite
 * do not care about the exact build.
 *
 * But CI runners have no such binary, so a hardcoded path would fail there. Resolve
 * it only if it actually exists and otherwise fall through to Playwright's own
 * resolution, which is what `playwright install chromium` populates.
 */
function findChromium(): string | undefined {
  const candidates = [process.env.WHITEOUT_CHROMIUM, '/opt/pw-browsers/chromium'];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return undefined;
}

const CHROMIUM = findChromium();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',

  /**
   * 90 s per test, not Playwright's default 30.
   *
   * This suite is explicitly documented as asserting structure and never performance --
   * SwiftShader renders at single-digit frame rates, so any fps assertion here is a flaky
   * test. The default timeout was smuggling one in anyway. On a shared CI runner boot
   * under software GL is roughly three times slower than locally: the context-loss test
   * spent its entire 30 s budget before reaching its first assertion, and the
   * shader-compilation test on the same run came in at 23 s, one slow patch from the same
   * failure. Boot itself was measured and had not regressed -- the progress-field bake
   * costs 38 ms against terrain generation's 325 ms.
   */
  timeout: 90_000,

  /**
   * One retry on CI.
   *
   * Retries normally hide real failures, and the reason they are acceptable here is
   * specific: every assertion in this suite is structural and deterministic -- draw
   * counts, shader compilation, a non-blank framebuffer, a restored context. A genuinely
   * broken one fails identically both times. The only thing a retry can mask is timing
   * variance on a shared runner, which is exactly the thing that is not a bug.
   */
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Omitted entirely when no preinstalled binary was found, so Playwright
          // uses whatever `playwright install chromium` put in place.
          ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
          args: [
            // Software GL: enough to validate structure (draw calls, shader
            // compilation, non-blank framebuffer). Never assert fps here.
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
