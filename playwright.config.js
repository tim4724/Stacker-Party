// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  fullyParallel: true,
  retries: 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.PW_PORT || '4100'}`,
    actionTimeout: 5000,
  },
  webServer: {
    command: 'node scripts/generate-airconsole-html.js && node server/index.js',
    env: {
      ...process.env,
      PORT: process.env.PW_PORT || '4100',
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
      testMatch: 'airconsole.spec.js',
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
});
