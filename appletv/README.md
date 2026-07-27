# HexStacker for Apple TV (tvOS)

Native tvOS port of the HexStacker party game. tvOS ships no web browser and no
`WKWebView`, so the web display cannot run on Apple TV. This target rebuilds the
**display** natively while reusing everything else unchanged:

| Surface | Strategy |
| --- | --- |
| Game engine (`../server/*.js` + `../partyplug/RoomFlow.js`) | **Reused verbatim** in JavaScriptCore as a single esbuild bundle (`dist/partycore.js`), driven through the `PartyCore` facade (the native integration surface). No logic rewrite, no drift. |
| Wire protocol (`../public/shared/protocol.js`) | **Mirrored** to Swift constants (`Net/Protocol.swift`) for type-safety; the JS is not shipped to the device. |
| Phone controllers | **Unchanged** — players still join from a phone browser via QR. |
| Party-Server relay | **Unchanged** — Swift connects with `URLSessionWebSocketTask`. |
| Display rendering / audio / lobby | **Rebuilt natively**: the board is SpriteKit, all chrome (lobby, countdown, results, about/licenses, overlays) is SwiftUI, audio is AVFoundation. |

The Swift bridge drives the engine through `PartyCore.frame(nowMs)` (see
`../server/PartyCore.d.ts`): each call ticks the engine on a capped delta and
returns this frame's raw events, a value-copy snapshot, and a normalized
host-effect `commands` list (controller sends, match end). That single-sources
the event→effect mapping the display used to hand-code, so it can't drift from
the web/server. The determinism of the JS engine driven from Swift is proven by
the unit tests (`swift test`), which is what makes "reuse the engine" safe.

## Layout

```
appletv/
  Package.swift                 SwiftPM: builds + tests HexStackerKit on macOS (no Xcode needed)
  project.yml                   XcodeGen spec for the tvOS app target
  scripts/sync-engine.sh        Builds the canonical engine (npm run build:core) into the app bundle
  scripts/parity/               Ad-hoc web-vs-native pixel diff (see its README)
  Sources/
    HexStackerKit/              Platform-agnostic core (macOS + tvOS)
      Engine/                   JavaScriptCore bridge over PartyCore + Codable snapshot/command model
      Game/                     DisplayCoordinator: engine <-> net <-> view glue
      Net/                      Relay WebSocket client, fastlane netcode, protocol mirror, room/host FSM
      Render/                   Hex geometry, theme, zigzag detection (mirrors the web render math)
      Parity/                   Loads the WEB render math into JSCore, so ParityTests can diff it against Render/
    HexStackerTV/               tvOS-only app (SpriteKit board, SwiftUI chrome, audio, QR, WebRTC)
      Generated/engine/         (git-ignored) engine JS mirrored at build time
  Tests/HexStackerKitTests/     Runs the real engine via JSCore; determinism, parity, netcode, FSM
  UITests/                      Drives the app in the Simulator; captures the screenshot gallery
```

## Build & test the core on macOS (works with Command Line Tools only)

The `HexStackerKit` core needs no Xcode and no tvOS SDK, just the Command Line
Tools plus Node (the engine ships as an esbuild bundle, so the test suite runs
`npm run build:core` from the repo root first — run `npm ci` there once):

```bash
cd appletv
swift build   # compiles the kit
swift test    # the full verification tier (no Xcode required)
```

`swift test` is the single verification tier and runs under Command Line Tools
(swift-testing ships with the toolchain). It rebuilds the engine bundle from the
canonical source, runs it through the JavaScriptCore bridge, and covers engine
determinism and the full game loop (`EngineBridgeTests`, `DisplayCoordinatorTests`,
`FrameGoldenConformanceTests`), cross-engine render parity (`ParityTests`),
fastlane receiver netcode (`FastlaneTests`), room/host FSM + geometry
(`KitTests`), localization, and the real `RelayClient` over a loopback WebSocket
(`RelayClientLiveTests`).

## Build & run the tvOS app (needs full Xcode)

Requires Xcode (Mac App Store) for the tvOS SDK and Simulator:

```bash
brew install xcodegen          # one time
cd appletv
xcodegen generate              # produces HexStacker.xcodeproj from project.yml
open HexStacker.xcodeproj
# pick an Apple TV Simulator and Run
```

### Testing the full loop on your Mac

Only the display is native; controllers stay web pages. So you can test
end-to-end without extra hardware:

1. Run the app in the tvOS Simulator. It connects to the live relay.
2. Open the controller URL in a browser tab (or scan the on-screen QR with a
   phone) and join.

The Simulator is faithful for logic and connectivity; it is **not**
representative of real Apple TV GPU performance or Siri-Remote feel. Validate
those on hardware before shipping.

## CI

`.github/workflows/tvos.yml` runs two parallel jobs: `kit-tests` (`swift test`)
and `build-test-screenshots`, which builds the app for the Simulator SDK (the
app-target sources are not in the SwiftPM package) and captures the per-state
screenshot gallery that the `TV Gallery` workflow assembles.

## Verification & capture modes

| Variable | Effect |
| --- | --- |
| `HEXDEMO=1` | Self-playing game (synthetic input, no relay) |
| `HEXLOBBY=1` | Lobby with fake players (no relay) |
| `HEXSNAP=1` | Static fixture render for visual parity (`scripts/parity/`) |
| `HEXSHOT=<state>` | One display state frozen with fake data; `HEXPLAYERS=<n>` sets the roster |
| `HEXLICENSES=1` | Opens straight to the licenses page (the Simulator has no Siri-Remote CLI to navigate there) |
| `HEXGALLERY=1` | All gallery states in one launch, Play/Pause advances (drives `ScreenshotTests`) |
| `HEXFPS=1` | Debug FPS/node overlay |
| `HEXHOST=<origin>` | Point the QR / join URL at another origin, e.g. `preview-<branch>.hexstacker.com` (see below) |

### Testing against a branch preview

The web display gets its QR origin from `window.location`, so a preview deploy
retargets its own QR for free. The TV app has no origin to read, so it carries an
explicit knob: set `HEXHOST` in the Run scheme (Product > Scheme > Edit Scheme >
Run > Arguments > Environment Variables) to

```
HEXHOST = preview-<branch>.hexstacker.com     # bare host, https:// and a full join URL also work
```

and relaunch. The lobby then shows the preview host next to the room code, so
you can see which build the phones are about to load. Scheme env vars don't exist
on a TestFlight/App Store launch, so a shipped build is always production.

Only the controller page moves: both ends still meet on the production relay
(`RELAY_URL` is the same constant in the preview bundle), which is what makes a
preview phone and a prod-relay TV land in the same room. To test a *relay*
change, point `Protocol.relayURL` at it as well; nothing reads that from the
environment yet.

The web/tvOS/Android screenshot gallery lives at the repo root in
`scripts/gallery/` (`capture-tvos.sh` locally; the `HEXGALLERY` carousel in CI).

## Brand assets

App Icon & Top Shelf art are generated: `node artwork/generate-tvos-icons.js`
and `node artwork/generate-tvos-topshelf.js`. Orbitron ships in
`Sources/HexStackerTV/Resources/fonts/`, wired via `project.yml`.

## Shipping / TestFlight

The Simulator runs unsigned. Manual App Store distribution signing is
committed in `project.yml` (see the comment there; local archives need the
"HexStacker tvOS App Store" profile in the login keychain). Pushing a
bare-semver tag runs `.github/workflows/release.yml`, which archives and
uploads straight to TestFlight.

## Remaining validation (needs real hardware)

- [ ] Full match on a real Apple TV (live relay + phone controllers).
- [ ] Render profiling on real hardware (Simulator GPU numbers aren't representative).
- [ ] WebRTC fastlane handshake with a real phone (the relay fallback covers input if it fails).
