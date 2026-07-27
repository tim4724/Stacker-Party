// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  fullyParallel: true,
  // One retry on CI only: the first test on each worker can time out while the
  // shared webServer is still bundling and four workers cold-start Chromium on
  // a 4-core runner (the same tests pass on a quiet re-run every time). Local
  // runs stay strict at 0.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.PW_PORT || '4100'}`,
    actionTimeout: 5000,
  },
  webServer: {
    // Build first and force bundle serving (SERVE_BUNDLES=1) so both projects
    // run against the real content-hashed bundles, exercising the concatenation
    // (strict-mode flattening, cross-file hoisting) that ships to users — the
    // e2e project gets the web bundles, e2e-airconsole the AC variants that go
    // into the AirConsole ZIP. SERVE_BUNDLES (not APP_ENV=production) keeps the
    // dev CSP the AC mock's http.airconsole.com framing needs.
    command: 'npm run build && node server/index.js',
    env: {
      ...process.env,
      PORT: process.env.PW_PORT || '4100',
      SERVE_BUNDLES: '1',
    },
    port: Number(process.env.PW_PORT || 4100),
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'e2e',
      testDir: './tests/e2e',
      testIgnore: /airconsole.*\.spec\.js/,
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'e2e-airconsole',
      testDir: './tests/e2e',
      testMatch: /airconsole.*\.spec\.js/,
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
});
