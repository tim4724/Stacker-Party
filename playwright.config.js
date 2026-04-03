// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  fullyParallel: true,
  retries: 0,
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
      testDir: './tests/visual',
      testMatch: 'display.spec.js',
      use: { viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'hex-display',
      testDir: './tests/visual',
      testMatch: 'hex-display.spec.js',
      use: { viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'controller',
      testDir: './tests/visual',
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
    {
      name: 'e2e',
      testDir: './tests/e2e',
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
});
