'use strict';

// Canonical browser script load order for each web app entry, single-sourced so
// the build (concatenation) and the server (dev-mode injection of individual
// tags) can never disagree. These lists ARE the order; the app index.html files
// just carry a <!--CONTROLLER_SCRIPTS--> / <!--DISPLAY_SCRIPTS--> placeholder.
//
// The per-app test harness is included here in its load-order position (the
// display's must precede display.js, which reads window.__TEST__ at init). It is
// URL-param-gated, so it's inert for real players, and the e2e suite drives the
// display through that harness against the bundle, so it has to ship in it. The
// AirConsole generator strips it from the AC entry via its TestHarness.js regex.
//
// Paths are browser URL paths. resolveAsset() maps them to disk:
//   /engine/*    -> server/*      (UMD engine, also used by node --test)
//   /partyplug/* -> partyplug/*
//   /shared/*, /controller/*, /display/*  -> public/*

const path = require('path');
const ROOT = path.join(__dirname, '..');

const CONTROLLER_SCRIPTS = [
  '/engine/constants.js',
  '/engine/Piece.js',
  '/partyplug/PartyConnection.js',
  '/partyplug/PartyFastlane.js',
  '/partyplug/AirConsoleAdapter.js',
  '/partyplug/AirConsoleStorage.js',
  '/shared/protocol.js',
  '/shared/i18n.js',
  '/shared/i18n-fallback.js',
  // CanvasUtils before theme: theme.js eagerly calls ghostColor() (defined here)
  // under a `typeof ghostColor === 'function'` guard. As separate <script>s that
  // guard is false in the controller (CanvasUtils loaded later) and GHOST_COLORS
  // is filled lazily; concatenated, the function declaration hoists so the guard
  // passes and runs before CanvasUtils' _ghostColorCache Map is initialized. This
  // dependency-correct order (the one the display already uses) avoids that.
  '/shared/CanvasUtils.js',
  '/shared/theme.js',
  '/shared/WelcomeBackground.js',
  '/shared/share-helper.js',
  '/controller/TouchInput.js',
  '/controller/Audio.js',
  '/controller/Settings.js',
  '/controller/ControllerState.js',
  '/controller/ControllerConnection.js',
  '/controller/ControllerGame.js',
  // Couch Games shell bootstrap (Android TV launcher WebView). Self-gated on
  // ?cgv=1 so it's inert everywhere else. Must follow ControllerConnection/
  // ControllerGame (wraps connect/bailToWelcome at load time) and precede
  // controller.js (whose init reads skipNameScreen). The AirConsole generator
  // strips it from the AC entry.
  '/controller/controller-couchgames.js',
  '/controller/controller.js',
  // Gallery/test harness, kept last (as it was a separate tag). Self-gated on
  // ?scenario= so it's inert for real players; folded in for one atomic bundle.
  // The AirConsole generator strips it from the AC entry.
  '/controller/ControllerTestHarness.js',
];

const DISPLAY_SCRIPTS = [
  '/engine/constants.js',
  '/engine/Randomizer.js',
  '/engine/GarbageManager.js',
  '/engine/Piece.js',
  '/engine/PlayerBoard.js',
  '/engine/Game.js',
  '/engine/PartyCore.js',
  '/engine/GalleryFixtures.js',
  '/partyplug/PartyConnection.js',
  '/partyplug/PartyFastlane.js',
  '/partyplug/AirConsoleAdapter.js',
  '/partyplug/AirConsoleStorage.js',
  '/partyplug/RoomFlow.js',
  '/shared/protocol.js',
  '/shared/i18n.js',
  '/shared/i18n-fallback.js',
  '/shared/CanvasUtils.js',
  '/shared/theme.js',
  '/shared/WelcomeBackground.js',
  '/shared/share-helper.js',
  // Client-side QR encoder (display only — the controller renders no QR). Must
  // precede DisplayConnection.js, which calls its global `qrcode` in buildQRMatrix.
  '/shared/qrcode-generator.js',
  '/display/BoardRenderer.js',
  '/display/UIRenderer.js',
  '/display/Animations.js',
  '/display/Music.js',
  '/display/DisplayState.js',
  '/display/DisplayUI.js',
  '/display/DisplayConnection.js',
  '/display/DisplayAudio.js',
  '/display/DisplayGame.js',
  '/display/DisplayLiveness.js',
  '/display/DisplayInput.js',
  '/display/DisplayRender.js',
  // Must precede display.js: its bottom-of-file init reads window.__TEST__
  // (set here under ?test/?scenario/?adclip) synchronously to choose
  // scenario-vs-relay. Inert for real users; AC generator strips it.
  '/display/DisplayTestHarness.js',
  '/display/display.js',
];

// AirConsole variants: the same load order minus modules that are dead inside
// the AC iframe, with the AC bootstrap spliced in just before the app entry
// (the bootstrap wraps globals like connect/showScreen at load time and must
// run after everything it wraps, before the entry's init reads them). These
// lists feed the AC bundles (scripts/build.js) and the expansion of the
// <!--AC_*_SCRIPTS--> markers that generate-airconsole-html.js leaves in
// screen.html / controller.html (server: dev tags or the AC bundle;
// finalize-airconsole-html.js: the relative AC bundle tag for the ZIP).
const AC_DEAD = [
  // The AC bootstrap replaces the global PartyConnection with an
  // AirConsoleAdapter factory before any caller constructs one, and
  // PartyFastlane is gated on !window.airconsole at both call sites.
  '/partyplug/PartyConnection.js',
  '/partyplug/PartyFastlane.js',
  // Only caller is the device-choice share banner, CSS-hidden in AC mode.
  '/shared/share-helper.js',
  // AC players join from the AirConsole app, never by scanning: the AC display
  // bootstrap stubs buildQRMatrix to return null, so the encoder is never
  // called. Dropping it also keeps third-party (MIT) code out of the AC ZIP.
  '/shared/qrcode-generator.js',
  // Couch Games shell bootstrap, self-gated on ?cgv=1 — never set in AC.
  '/controller/controller-couchgames.js',
  // Gallery/Playwright-only harnesses, gated on URL params AC never carries.
  '/controller/ControllerTestHarness.js',
  '/display/DisplayTestHarness.js',
];

function airconsoleVariant(scripts, bootstrap, entry) {
  const out = scripts.filter(function (s) { return AC_DEAD.indexOf(s) === -1; });
  const at = out.indexOf(entry);
  if (at === -1) throw new Error('airconsoleVariant: entry ' + entry + ' missing from script list');
  out.splice(at, 0, bootstrap);
  return out;
}

const AC_CONTROLLER_SCRIPTS = airconsoleVariant(CONTROLLER_SCRIPTS, '/controller/controller-airconsole.js', '/controller/controller.js');
const AC_DISPLAY_SCRIPTS = airconsoleVariant(DISPLAY_SCRIPTS, '/display/display-airconsole.js', '/display/display.js');

// Canonical CSS load order per app, bundled the same way as the scripts above.
// The two @font-face stylesheets (/shared/fonts/*.css) are deliberately NOT
// here: they carry relative url() references to their woff2 siblings that a
// concatenated bundle served from /controller/ or /display/ would resolve
// against the wrong directory. They stay as their own <link>s in the HTML
// (tiny, effectively immutable). Every file below is url()-free (display.css's
// lone url() is a self-contained data: SVG), so concatenation is path-safe.
// Order preserves the cascade: theme -> results -> (device-choice) -> app.
const CONTROLLER_STYLES = [
  '/shared/theme.css',
  '/shared/results.css',
  '/controller/controller.css',
];

const DISPLAY_STYLES = [
  '/shared/theme.css',
  '/shared/results.css',
  '/shared/device-choice.css',
  '/display/display.css',
];

// Every HTML page the server renders + caches at boot in PROD (server/index.js
// HTML_CACHE). Single-sourced here so the set is defined once. Each is fully
// build-deterministic EXCEPT the version label (per-deployment: same image runs
// prod and preview with different APP_ENV/GIT_SHA), which is why these are
// finalized at boot rather than baked at build time.
//
// EXCLUDED: the gallery pages. In prod Traefik routes /gallery* to a separate
// static pod (nginx), so this server never serves them there; they stay on the
// dev-only per-request rewrite path. Keys are the post-routing urlPath (see the
// '/' -> /display/index.html and room-code -> /controller/index.html mapping).
const PRERENDERED_PAGES = [
  '/display/index.html',
  '/controller/index.html',
  '/display/screen.html',        // AirConsole display entry
  '/controller/controller.html', // AirConsole controller entry
];

function resolveAsset(urlPath) {
  if (urlPath.indexOf('/engine/') === 0) {
    return path.join(ROOT, 'server', urlPath.slice('/engine/'.length));
  }
  if (urlPath.indexOf('/partyplug/') === 0) {
    return path.join(ROOT, urlPath.slice(1));
  }
  return path.join(ROOT, 'public', urlPath.slice(1));
}

module.exports = {
  ROOT: ROOT,
  CONTROLLER_SCRIPTS: CONTROLLER_SCRIPTS,
  DISPLAY_SCRIPTS: DISPLAY_SCRIPTS,
  AC_CONTROLLER_SCRIPTS: AC_CONTROLLER_SCRIPTS,
  AC_DISPLAY_SCRIPTS: AC_DISPLAY_SCRIPTS,
  CONTROLLER_STYLES: CONTROLLER_STYLES,
  DISPLAY_STYLES: DISPLAY_STYLES,
  PRERENDERED_PAGES: PRERENDERED_PAGES,
  resolveAsset: resolveAsset,
};
