# Cross-platform TV screen gallery

A screenshot mechanism modelled on the web `public/gallery.html`: render every
display state with deterministic fake data on **each platform that draws the
display** (web, native tvOS, native Android TV), capture each to a PNG, and
assemble a single page with the three renders side by side so visual gaps are
easy to spot and close.

All three platforms execute the same `dist/partycore.js` engine (byte-exact per
the frame-golden conformance tests), so a difference in this gallery is a
renderer difference, never an engine difference.

## The manifest

`scenarios.json` is the single source of truth: one entry per canonical state
(`lobby`, `countdown`, `game-lv8`, `results`, ...) mapping to how each platform
reaches it:

- `web` — display-test-harness URL params for `capture-web.mjs`
- `tvos` — `HEXSHOT`/`HEXPLAYERS` env for `capture-tvos.sh` (the same states
  `appletv/UITests/ScreenshotTests.swift` captures in CI)
- `android` — the Roborazzi PNG name emitted by the `:tv` screenshot tests
  (`android/tv/src/test/.../screenshot/`), normalized by `collect-shots.mjs`

A platform without a mapping shows "no equivalent yet" in the gallery; a
mapping without a captured PNG shows "not captured". Add new states to the
manifest first, then teach each platform to render them.

## Regenerate locally

```bash
# web reference shots (needs the server running + Playwright)
PORT=8770 node server/index.js &                 # from the repo root
node scripts/gallery/capture-web.mjs http://localhost:8770

# Android TV shots (headless JVM via Robolectric/Roborazzi, no emulator)
npm run build:core                                # :tv preBuild needs dist/partycore.js
(cd android && ./gradlew :tv:recordRoborazziDebug)
# fresh worktrees have no android/local.properties — prefix with
# ANDROID_HOME="$HOME/Library/Android/sdk" if the SDK isn't found
node scripts/gallery/collect-shots.mjs android

# tvOS shots (builds, installs to the Apple TV sim, captures all states)
bash scripts/gallery/capture-tvos.sh
#    reuse an existing build with: HEX_SKIP_BUILD=1
#    pick a sim with:              HEX_SIM=<udid>

# assemble the page
node scripts/gallery/gen-gallery.mjs
# view via the dev server (nav links resolve there; plain `open` works too)
open http://localhost:8770/gallery-tv/
```

Any subset works — the page renders explicit gaps for platforms you skipped.
Captured PNGs and `gallery.html` are git-ignored (regenerable artifacts).

## CI

The `TV Gallery` workflow (`.github/workflows/tv-gallery.yml`) assembles the
same page on every PR that touches TV-relevant code: it runs whenever the
`Android TV` or `tvOS` workflow finishes, downloads their
screenshot artifacts, captures fresh web references, and assembles the page.
Whichever platform workflow finishes last produces the complete three-column
page.

It ships two ways (the PR's preview comment carries the links):

- **Browsable deployment**: `https://<preview-host>/gallery-tv/` (i.e.
  `preview-<branch>.hexstacker.com/gallery-tv/`, `main.hexstacker.com/gallery-tv/`
  for main). A tiny static nginx image (`Dockerfile` here) path-routed onto
  the preview host from the same `cg-<branch>` Kubernetes namespace, so builds
  stay decoupled from the app image. Torn down with the namespace by the
  `Preview Cleanup` workflow on branch delete.
- **Artifact fallback**: the `tv-gallery` artifact (unzip, open
  `gallery.html`), for when the deploy is unavailable or expired runs are
  being compared.

That nginx image also hosts the LIVE web gallery entry pages (`public/gallery*`,
served at `/gallery` on the same host), which `.dockerignore` excludes from the
game image so production ships no review tooling. Their iframes use absolute
paths that route to the app preview pod, so they still drive the real display
app. (The display test harness itself does ship in the app bundle: it is inert
without its URL params, and e2e depends on it.) Hence the workflow runs on plain
web pushes too, not just after the TV screenshot workflows. Locally nothing
changes: the dev server serves `public/gallery*` from disk.
