// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4100',
    actionTimeout: 5000,
  },
  webServer: {
    command: 'node server/index.js',
    env: {
      ...process.env,
      PORT: '4100',
    },
    port: 4100,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'display',
      testMatch: 'display.spec.js',
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'controller',
      testMatch: 'controller.spec.js',
      use: {
        viewport: devices['iPhone 14'].screen,
        deviceScaleFactor: devices['iPhone 14'].deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
      },
      expect: {
        toHaveScreenshot: { scale: 'device' },
      },
    },
  ],
});
