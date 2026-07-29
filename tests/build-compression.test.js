'use strict';

// Brotli quality is tiered (scripts/write-compressed.js): the fast tier keeps
// local builds and the Playwright webServer snappy, and BUILD_COMPRESSION=max
// buys the last ~9% off the wire for the bytes real users actually download.
//
// The tier is invisible at runtime — every quality decompresses identically — so
// a Dockerfile that quietly lost the opt-in would ship fatter bundles forever
// with every test still green. This is the guard for that, in the same spirit as
// tests/dockerfile-assets.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

test('Dockerfile builds the shipped bundles with max brotli quality', () => {
  assert.match(
    dockerfile,
    /RUN\s+BUILD_COMPRESSION=max\s+npm run build/,
    'the deployed image is the only consumer of the .br siblings — it must opt into BUILD_COMPRESSION=max'
  );
});

// The tier is read once at module load, so re-require under the env a given build
// path would set. Restores the ambient value so these assertions neither depend on
// nor leak into how this process was invoked.
const MODULE = require.resolve(path.join(ROOT, 'scripts', 'write-compressed.js'));
function qualityWith(value) {
  const saved = process.env.BUILD_COMPRESSION;
  if (value === undefined) delete process.env.BUILD_COMPRESSION;
  else process.env.BUILD_COMPRESSION = value;
  try {
    delete require.cache[MODULE];
    return require(MODULE).BROTLI_QUALITY;
  } finally {
    if (saved === undefined) delete process.env.BUILD_COMPRESSION;
    else process.env.BUILD_COMPRESSION = saved;
    delete require.cache[MODULE];
  }
}

test('the fast tier is the default, so no other build path pays for quality 11', () => {
  assert.equal(qualityWith(undefined), 5, 'default builds must take the fast brotli tier');
});

test('BUILD_COMPRESSION=max selects quality 11', () => {
  assert.equal(qualityWith('max'), 11, 'the deploy tier must still be max effort');
});
