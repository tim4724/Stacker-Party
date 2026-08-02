#!/usr/bin/env node
'use strict';

/**
 * Generate the AirConsole HTML entry points (display/screen.html,
 * controller/controller.html) from the canonical index.html files. See
 * `transform` below for the individual rewrites.
 *
 * WHICH scripts load (and their order) is not decided here: the AC script
 * sets are derived in scripts/asset-manifest.js (AC_CONTROLLER_SCRIPTS /
 * AC_DISPLAY_SCRIPTS — web list minus AC-dead modules, plus the AC
 * bootstrap). The AC markers are expanded by server/index.js at serve time
 * (dev: individual file tags; SERVE_BUNDLES: the hashed AC bundle) and by
 * finalize-airconsole-html.js at ZIP-build time (relative AC bundle tag).
 * The <!--*_STYLES--> markers pass through untouched for the same treatment.
 *
 * Usage:
 *   node scripts/generate-airconsole-html.js [--sdk-version 1.10.0]
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

const SDK_VERSION = getArg('--sdk-version') || '1.11.0';
const SDK_TAG = `<script src="https://www.airconsole.com/api/airconsole-${SDK_VERSION}.js"></script>`;

function transform(html, { scriptsMarker, acScriptsMarker }) {
  html = html.replace('<body>', '<body class="airconsole">');

  // Strip iframe-irrelevant <meta> and <link> tags. Cross-origin iframes
  // can't surface theme-color or PWA-install hints to the host browser, OG /
  // Twitter cards are never crawled, favicons and home-screen icons belong to
  // the top document, and cp-accent-color is a CouchPad shell hint the AC
  // iframe never uses.
  html = html.replace(/^\s*<meta\s+(property="og:|name="twitter:|name="description"|name="theme-color"|name="cp-accent-color"|name="apple-mobile-web-app-capable"|name="mobile-web-app-capable")[^>]*>\n/gm, '');
  html = html.replace(/^\s*<link\s+rel="(icon|apple-touch-icon)"[^>]*>\n/gm, '');

  // Strip the controller name-screen legal-links footer (dead DOM in AC).
  html = html.replace(/^\s*<div class="legal-links">[\s\S]*?<\/div>\n/m, '');

  // Strip <picture> inside the device-choice overlay. The /artwork/*
  // sources aren't bundled into the AC zip; without this the browser
  // would still resolve and fetch them (returning 404) even though the
  // overlay itself is CSS-hidden in AC.
  html = html.replace(/^\s*<picture>[\s\S]*?<\/picture>\n/m, '');

  // Convert absolute paths to relative in src/href attributes. The zip
  // serves screen.html/controller.html from its root; the web server keeps
  // them working by rewriting /screen.html -> /display/screen.html while the
  // browser URL stays at the root, so the relative paths resolve either way.
  html = html.replace(/(src|href)="\/(?!\/)/g, '$1="');

  // The SDK tag must precede the AC scripts marker: the AC bootstrap
  // constructs `new AirConsole(...)` at load time.
  html = html.replace(scriptsMarker, SDK_TAG + '\n  ' + acScriptsMarker);

  return html;
}

const displaySrc = fs.readFileSync(path.join(PUBLIC, 'display', 'index.html'), 'utf8');
const screenHtml = transform(displaySrc, {
  scriptsMarker: '<!--DISPLAY_SCRIPTS-->',
  acScriptsMarker: '<!--AC_DISPLAY_SCRIPTS-->',
});
fs.writeFileSync(path.join(PUBLIC, 'display', 'screen.html'), screenHtml);

const ctrlSrc = fs.readFileSync(path.join(PUBLIC, 'controller', 'index.html'), 'utf8');
const ctrlHtml = transform(ctrlSrc, {
  scriptsMarker: '<!--CONTROLLER_SCRIPTS-->',
  acScriptsMarker: '<!--AC_CONTROLLER_SCRIPTS-->',
});
fs.writeFileSync(path.join(PUBLIC, 'controller', 'controller.html'), ctrlHtml);

console.log('Generated display/screen.html and controller/controller.html (SDK %s)', SDK_VERSION);

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}
