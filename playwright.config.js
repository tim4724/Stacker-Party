// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.PW_PORT || '4100'}`,
    actionTimeout: 5000,
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.001 },
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
      name: 'style-comparison',
      testDir: './tests/visual',
      testMatch: 'style-comparison.spec.js',
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
        toHaveScreenshot: { maxDiffPixelRatio: 0.001, scale: 'device' },
      },
    },
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
