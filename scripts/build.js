#!/usr/bin/env node
'use strict';

// Build step (esbuild). Currently bundles the portable native core; the web
// controller/display app bundles are added here as those shells are modularized.
//
// Run directly (`npm run build`) to write artifacts to disk. The build options
// are also required() by tests so the runtime gate bundles with the exact same
// config the artifact ships with, and can't drift.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const esbuild = require('esbuild');
const { ROOT, CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS, CONTROLLER_STYLES, DISPLAY_STYLES, resolveAsset } = require('./asset-manifest.js');
const { writeCompressed } = require('./write-compressed.js');

// Portable native core: server/core-entry.js -> dist/partycore.js as an iife
// exposing globalThis.HexCore. platform:'neutral' so esbuild assumes neither
// Node nor browser globals (the target is a bare JS engine); target es2017 keeps
// the output within JavaScriptCore (tvOS) / QuickJS (Android TV) support.
function coreOptions(extra) {
  return Object.assign({
    entryPoints: [path.join(ROOT, 'server', 'core-entry.js')],
    bundle: true,
    format: 'iife',
    globalName: 'HexCore',
    platform: 'neutral',
    target: 'es2017',
    legalComments: 'none',
  }, extra || {});
}

async function buildCore() {
  await esbuild.build(coreOptions({
    outfile: path.join(ROOT, 'dist', 'partycore.js'),
    sourcemap: true,
  }));
}

// Web app bundle: concatenate the app's scripts in load order, then run the
// result through esbuild.transform (whitespace + syntax minify only). Identifier
// minification is OFF on purpose: the shells are global-scope scripts whose
// names are reached from OUTSIDE the bundle (inline HTML handlers and cross-file
// references), and transform (vs build) keeps everything at top-level script
// scope so those globals survive. Output is content-hashed so it can be cached
// immutably. `appDir` is the public/ directory the bundle is emitted into —
// same as `name` for the web bundles, the parent app dir for the AC variants
// ('controller-ac' lives in public/controller/).
async function buildApp(appDir, name, scripts) {
  let source = '';
  for (const urlPath of scripts) {
    source += '// ==== ' + urlPath + ' ====\n'
      + fs.readFileSync(resolveAsset(urlPath), 'utf8') + '\n';
  }
  const result = await esbuild.transform(source, {
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    target: 'es2017',
    // 'eof', not 'none': third-party sources whose licence requires the notice
    // to travel with the code (currently /shared/qrcode-generator.js, MIT) mark
    // it with `/*!` + `@license`, and esbuild re-emits those at the end of the
    // bundle. First-party comments carry no such marker and are still stripped.
    legalComments: 'eof',
    sourcemap: 'external',
    sourcefile: name + '.bundle.src.js',
  });
  // Hash the code only (NOT the trailing sourceMappingURL, which references the
  // hash — that would be circular). The .map sits beside the bundle so a prod
  // stack trace resolves into source instead of minified output; the server
  // serves both immutably (content-hashed names).
  const hash = crypto.createHash('sha256').update(result.code).digest('hex').slice(0, 10);
  const file = name + '.' + hash + '.js';
  // Bundles live beside their source dir so the existing /controller/, /display/
  // static routes serve them with no new route.
  const dir = path.join(ROOT, 'public', appDir);
  // Sweep stale content-hashed bundles (+ .map) so repeated local builds don't
  // leave orphans behind. The un-prefixed regex matches both `<name>.<hash>.js`
  // and its `.map`; the source files `<name>.js` lack the hash segment and are
  // untouched, as are sibling bundles sharing the dir ('controller-ac.…' has no
  // dot after 'controller', so the 'controller' sweep skips it and vice versa).
  // (CI/Docker start from a clean tree, so this only matters locally.)
  const stale = new RegExp('^' + name + '\\.[0-9a-f]{10}\\.js');
  for (const f of fs.readdirSync(dir)) {
    if (stale.test(f)) fs.rmSync(path.join(dir, f));
  }
  const js = result.code + '\n//# sourceMappingURL=' + file + '.map\n';
  const jsPath = path.join(dir, file);
  // writeCompressed emits the .js plus `.br`/`.gz` siblings (brotli 11 / gzip 9
  // — a build-time one-shot on a content-hashed artifact). server/index.js
  // negotiates the siblings via Accept-Encoding, so a browser downloads ~1/4
  // the bytes with zero per-request CPU. Only the .js is compressed — the .map
  // is a rare, devtools-only fetch. The stale-sweep regex above already matches
  // the siblings (they share the `<name>.<hash>.js` prefix), so old ones are
  // cleaned on rebuild alongside the .js/.map.
  writeCompressed(jsPath, Buffer.from(js));
  fs.writeFileSync(jsPath + '.map', result.map);
  return file;
}

// Web CSS bundle: concatenate the app's stylesheets in cascade order, minify
// (esbuild's css loader), content-hash, and emit `.br`/`.gz` siblings — the
// exact treatment buildApp() gives the JS, and for the same reasons. CSS is
// render-blocking and, unlike the JS, ships uncompressed from this server today
// (only hashed bundles are Accept-Encoding-negotiated), so bundling both cuts
// the request count and finally compresses it. No sourcemap: concatenated,
// minified CSS has little debugging value and the map would be a rare fetch.
async function buildStyles(name, styles) {
  let source = '';
  for (const urlPath of styles) {
    source += '/* ==== ' + urlPath + ' ==== */\n'
      + fs.readFileSync(resolveAsset(urlPath), 'utf8') + '\n';
  }
  const result = await esbuild.transform(source, {
    loader: 'css',
    minify: true,
    legalComments: 'none',
  });
  const hash = crypto.createHash('sha256').update(result.code).digest('hex').slice(0, 10);
  const file = name + '.' + hash + '.css';
  const dir = path.join(ROOT, 'public', name);
  // Sweep stale hashed CSS bundles (+ their .br/.gz) so local rebuilds don't
  // orphan them. Prefix match (no `$`) also catches the compressed siblings;
  // the un-hashed source `<name>.css` lacks the hash segment and is untouched.
  const stale = new RegExp('^' + name + '\\.[0-9a-f]{10}\\.css');
  for (const f of fs.readdirSync(dir)) {
    if (stale.test(f)) fs.rmSync(path.join(dir, f));
  }
  writeCompressed(path.join(dir, file), Buffer.from(result.code));
  return file;
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

  await buildCore();
  console.log('build: dist/partycore.js');

  // `--core` (npm run build:core): the native ports need only the portable core
  // bundle. Stop here so the tvOS pre-build phase / swift tests don't also
  // sweep and rewrite the git-ignored public/ hashed web bundles.
  if (process.argv.includes('--core')) return;

  // Independent (different output files, no shared state), so build the JS and
  // CSS bundles for both apps — plus the AirConsole JS variants — concurrently;
  // `npm start` runs this on boot. The AC variants share the web CSS bundles
  // (same style lists), so only the JS differs.
  const [controller, display, controllerAc, displayAc, controllerCss, displayCss] = await Promise.all([
    buildApp('controller', 'controller', CONTROLLER_SCRIPTS),
    buildApp('display', 'display', DISPLAY_SCRIPTS),
    buildApp('controller', 'controller-ac', AC_CONTROLLER_SCRIPTS),
    buildApp('display', 'display-ac', AC_DISPLAY_SCRIPTS),
    buildStyles('controller', CONTROLLER_STYLES),
    buildStyles('display', DISPLAY_STYLES),
  ]);
  const manifest = {
    controller: { js: controller, css: controllerCss },
    display: { js: display, css: displayCss },
    'controller-ac': { js: controllerAc },
    'display-ac': { js: displayAc },
  };
  fs.writeFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('build: public/controller/' + manifest.controller.js + ' + ' + manifest.controller.css);
  console.log('build: public/display/' + manifest.display.js + ' + ' + manifest.display.css);
  console.log('build: public/controller/' + manifest['controller-ac'].js + ' + public/display/' + manifest['display-ac'].js + ' (AirConsole)');
  // The prod HTML pages are rendered + cached at server boot (server/index.js
  // HTML_CACHE), not here — the version label they carry is per-deployment and
  // only known at runtime.
}

if (require.main === module) {
  main().catch(function (err) { console.error(err); process.exit(1); });
}

// Only coreOptions is part of the surface (tests/core-bundle-runtime.test.js
// bundles the core with the exact shipped config). The build steps run via the
// CLI entry above.
module.exports = { coreOptions: coreOptions };
