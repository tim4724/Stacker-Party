'use strict';

// Dev mode (no SERVE_BUNDLES) serves every script/stylesheet in the canonical
// asset manifest as its own file. The prod bundle concatenates the same list, so
// a path the server refuses to serve is invisible there. That is exactly how
// /engine/RoomCore.js shipped 404ing in dev while prod stayed green, silently
// turning every gallery web capture (which drives the plain dev server) into a
// welcome-screen shot.
//
// Boots the real server on an ephemeral port and fetches each asset.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS,
  CONTROLLER_STYLES, DISPLAY_STYLES,
} = require('../scripts/asset-manifest.js');
const { server } = require('../server/index.js');

const ASSETS = [...new Set([].concat(
  CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS,
  CONTROLLER_STYLES, DISPLAY_STYLES
))];

let base;

before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.closeIdleConnections();
  server.close(resolve);
}));

test('every manifest asset is served in dev mode', async () => {
  const broken = [];
  for (const asset of ASSETS) {
    const res = await fetch(base + asset);
    // Drain the body so the connection is reusable and close() can settle.
    await res.arrayBuffer();
    if (res.status !== 200) broken.push(`${asset} -> ${res.status}`);
  }
  assert.deepEqual(broken, [], 'assets in the manifest that the server will not serve');
});
