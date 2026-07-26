# Cross-engine visual parity (web canvas vs. native tvOS)

Ad-hoc pixel check: render one fixed engine snapshot with **both** renderers and
compare the on-screen block colors cell by cell. The web side reuses the
production modules (`server/constants.js`, `public/shared/theme.js`,
`public/shared/CanvasUtils.js`, `public/display/BoardRenderer.js`); the native
side draws the same fixture at `cellSize = 40` via `HEXSNAP=1`.

This is a debugging aid, not a gate. Continuous coverage lives elsewhere:
`ParityTests` (`swift test`) pins the native render math to the web's, and
`scripts/gallery/` diffs full screens across web, tvOS, and Android TV.

## Files

| File | Role |
| --- | --- |
| `fixture.json` | The shared snapshot. 15x9 grid, all zeros except the bottom row (14) = `[1,2,3,4,5,6,9,1,2]`. No active/ghost/hold piece. Mirrored by `VisualParityFixture` in Swift and inlined in `render-web.html`. |
| `render-web.html` | Standalone page; draws the fixture onto a `360x691` canvas with `new BoardRenderer(ctx, 0, 0, 40, 0)`, then sets `window.__READY = true`. |
| `visual-compare.mjs` | Two-PNG diff. Samples each bottom-row cell center, classifies to the nearest `PIECE_COLOR`, exits `1` on any misclassification. |
| `compare-samples.mjs` | Same check with the web pixels passed in as JSON, for when the browser's filesystem is isolated (the Playwright MCP bridge). |
| `content-bounds.mjs` | Bounding box of non-background content in a screenshot, against the tvOS title-safe area. Detects clipping. |

## Geometry — `computeHexGeometry(9, 15, 40)`

The native side must reproduce these for `cellSize = 40` to line up:

```
hexSize     = 25.714285714285715      (= 360/14)
hexH        = 44.53844933748542       (= sqrt(3) * hexSize)
colW        = 38.57142857142857       (= 1.5 * hexSize)
boardWidth  = 360                     -> canvas 360
boardHeight = 690.345964731024        -> canvas 691
```

Cell centers are `x = colW*col + hexSize`, `y = hexH*(row + 0.5*(col&1)) + hexH/2`
— odd columns sit half a hex lower (flat-top zigzag). `PIECE_COLORS`:
`1=#FF6B6B 2=#4ECDC4 3=#FFE066 4=#A78BFA 5=#7BED6F 6=#F178D8 9=#808080`.

## Running it

Dependencies: `npm i` here (pngjs).

1. **Serve the repo root** on a free port (`python3 -m http.server 8753`) so
   `render-web.html`'s `../../../` script paths resolve. The app server won't do:
   it exposes the engine at `/engine/`, not `/server/`.
2. **Capture the web render** at `deviceScaleFactor: 1`, screenshotting the
   `#board` element only, once `window.__READY === true`.
3. **Capture the native render**: `SIMCTL_CHILD_HEXSNAP=1 xcrun simctl launch
   <device> com.hexstacker.HexStackerTV`, screenshot, downscale x0.5 to scale 1.
4. **Compare** — both PNGs must be in the same pixel space (board top-left at the
   origin), since one mapping is applied to both:

```bash
# from the repo root: <webPng> <nativePng> <cellSize> <originX> <originY> <scale>
node appletv/scripts/parity/visual-compare.mjs web.png native.png 40 0 0 1
```

Output is per-cell `PASS/FAIL` with the sampled RGB and classified id for each
engine, plus an overall percentage. Passing `web.png` as both arguments
self-checks the mapping before a native capture exists.
