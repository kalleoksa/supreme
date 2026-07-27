import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH. Its revision will not
// always match the one this @playwright/test version wants to download, so point
// at the binary explicitly rather than running `playwright install` -- the
// structural assertions in this suite do not care about the exact Chromium build.
// Override with WHITEOUT_CHROMIUM if a machine keeps Chromium somewhere else.
const CHROMIUM = process.env.WHITEOUT_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
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
          executablePath: CHROMIUM,
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
