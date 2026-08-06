# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                       # Unit tests (node:test) — ~2s, needs no build
npm run test:watch             # Same suite, re-run on save
node --test tests/hex-board.test.js  # Single unit test
npm run dev                    # Inner loop: individual scripts + node --watch restart
npm run build                  # esbuild: web app bundles + dist/partycore.js (native core)
npm run test:e2e:all           # BOTH Playwright projects on one shared webServer — prefer this
npm run test:e2e               # Playwright E2E lifecycle tests (runs against the prod bundle)
npm run test:e2e:airconsole    # Playwright E2E AirConsole tests
```

Running `test:e2e` and `test:e2e:airconsole` back to back rebuilds and re-boots the
test server twice; `test:e2e:all` shares one. Brotli quality on the precompressed
bundle siblings is tiered by `BUILD_COMPRESSION` (fast by default, `max` only in
the Dockerfile) — `max` roughly doubles build wall time for ~9% smaller bundles,
so leave it to the deploy path.

## Key Rules

- UI regressions are caught via the gallery (`public/gallery.html` live web review; `scripts/gallery/` cross-platform web/tvOS/Android comparison, deployed at `<preview-host>/gallery-tv/`), not visual snapshots. Gallery fixture data is single-sourced in `server/GalleryFixtures.js` (scenario map: `scripts/gallery/scenarios.json`)
- Engine modules (`server/*.js`) use UMD — must work in both Node.js and browser
- Browser script load order is single-sourced in `scripts/asset-manifest.js`; the app `index.html` files carry `<!--CONTROLLER_SCRIPTS-->` / `<!--DISPLAY_SCRIPTS-->` placeholders. Add/remove/reorder a browser script there, NOT in the HTML
- Web bundling (`scripts/build.js`, esbuild): prod (or `SERVE_BUNDLES=1`) serves one content-hashed, immutably-cached bundle per app; dev serves the individual files for instant edits. Because the bundle concatenates files into one script, mind cross-file load order: a top-level `typeof fn === 'function'` guard on a function declared in a LATER file flips to true (declarations hoist across the whole script) and can run before that file's top-level initializers — order so dependencies' initializers run first. e2e runs against the bundle via `SERVE_BUNDLES=1`. The AirConsole ZIP ships AC bundle variants (`controller-ac`/`display-ac`: web load order minus AC-dead modules, plus the AC bootstrap — derived in `scripts/asset-manifest.js`); the AC e2e suite runs against them too
- Portable native core: `server/PartyCore.js` + the engine + `server/GalleryFixtures.js` + `partyplug/RoomFlow.js` + `server/RoomCore.js` build to `dist/partycore.js` (iife `HexCore`) for tvOS/Android TV. Keep it pure (no DOM/timers/clock/IO) — gated by `tests/portable-purity.test.js` (static) and `tests/core-bundle-runtime.test.js` (runtime, bare VM)
- Room state has ONE implementation: `server/RoomCore.js` (roster, auto-naming, colour slots, host election, pause/mute/results), loaded out of the same bundle by web, tvOS and Android TV. Don't re-implement any of it per platform — that drift is what the module exists to stop. It composes `partyplug/RoomFlow.js`, which stays game-agnostic. Mutators return a `publish` hint (`'now' | 'soon' | 'none'`); the shells read the hint STRENGTH from the module too (`RoomCore.PUBLISH_RANK` / `publishRank`) and keep only the throttle timer and the batch fold, which need a clock and a closure. Cross-platform gate: `tests/fixtures/room-core-golden.json`, regenerated with `npm run build:golden`
- Engine events mean the same thing on every platform: `PartyCore.toCommands` maps them to the host-effect vocabulary (`playerState`, `gameEnd`, …) and all three displays dispatch that list — web from `stepEngine` (DisplayGame.js), the TVs from `PartyCore.frame()`. Don't hand-write a per-shell event handler for anything with a consequence off-screen; board animations stay per-shell and are driven from the raw `events`. `deliverFrame`/`deliverSnapshot` are the same idea for the JS↔native boundary (unchanged grids stripped, render-identical frames dropped via `PartyCore.sceneSig`), which is why the native bootstrap shims are marshalling only — held token-identical by `tests/room-bridge-shim-parity.test.js`
- CSP headers in `server/index.js` — update when adding external resources
- Relay URL configured in `public/shared/protocol.js`
- CI: the branch → preview slug/namespace/host mapping is `.github/actions/branch-slug` and the per-branch k8s namespace setup is `.github/actions/preview-namespace`. Never inline either again (four inlined copies had drifted into two behaviours, leaking namespaces). Node version lives in `.nvmrc`, read by every workflow via `node-version-file` and mirrored into the Dockerfile. Both gated by `tests/ci-config-parity.test.js`. Playwright's browsers are installed from the npm package (cached), never a version-pinned container image. `actionlint` (config: `.github/actionlint.yaml`) validates workflow changes locally
- Controller input uses WebRTC DataChannels (`partyplug/PartyFastlane.js`) with the relay as signaling channel and input fallback. Everything the display says about the ROOM rides one retained snapshot (`set_state`, built by `RoomCore.snapshot()`), which the relay pushes live and replays after `joined` — controllers derive their whole UI from it, screen routing included. Only per-player telemetry (`player_state`), `pong` and `error` are still messages
- Gamepads plugged into the DISPLAY machine take seats of their own (`public/display/GamepadInput.js`, web only — stripped from the AC bundle). A pad is not a second kind of player: each press is synthesized into the message a phone would have sent and fed to `handleControllerMessage`, so join/naming/colour/host/liveness/pause keep their one implementation. Local seats hold NEGATIVE peer indices (the relay owns 1..N, the display owns 0), which is what `isLocalSeat()` guards every `party.sendTo` with. Rumble and the derived "garbage applied" moment are the only pad-specific effects. Outside play the pad does NOT get a binding per action: the D-pad and left stick move a focus ring over the display's own visible `<button>`s and the bottom face button clicks the focused one, so a button added to the display is pad-reachable with no change to `GamepadInput.js` (the game toolbar is excluded in the lobby — it is operator chrome, not a player control). Only what has no on-screen control keeps a button (pause, this seat's colour and level), and a whole shoulder SIDE is always one action
- Controller buttons activate via `bindTap()` (`ControllerState.js`), never `addEventListener('click')`: phones withhold the synthesized click for the first tap after a message-driven screen swap (e.g. results arriving), silently swallowing it. Display buttons keep `click` (mouse/remote platforms)
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`. Relay/STUN config lives in `public/shared/protocol.js` and is injected into the kit at construction; the kit reads no game globals
