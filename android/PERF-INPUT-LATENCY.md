# Android TV input latency: measurements and review

Measured on a **Google TV Streamer (kirkwood, Android 14)** over ADB, against the
shipping `dist/partycore.js`. Reproduce with:

```bash
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew :tv:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.package=com.hexstacker.tv.perf
adb logcat -d -s HexPerf:I
```

Benchmarks live in `tv/src/androidTest/java/com/hexstacker/tv/perf/`:

| file | what it measures |
| --- | --- |
| `InputLatencyTest` | end-to-end: inbound INPUT callback → `renderSnapshot` carrying that input |
| `EnginePerfTest` | per-call cost of every QuickJS/marshalling step, plus A/B of the proposed fixes |
| `RenderPerfTest` | `BoardSurfaceView.drawFrame` on a real hardware canvas |

**Caveats.** These run in an instrumentation process, so absolute figures move with CPU
governor and core placement; the A/B comparisons and the relative shape are the solid
part. `InputLatencyTest` stops at `renderSnapshot`, so it excludes the render thread's
wake, its draw, and SurfaceFlinger present — it is a **floor**, not the full photon path.

---

## 1. The headline number

Input arriving → a snapshot containing that input reaching the renderer, **before any
fix** (warmed harness; see 5.4 for the after column and the method):

| seats | p50 | p95 |
| --- | --- | --- |
| 1 | 9.4–9.9 ms | 11.1–12.9 |
| 4 | 10.54 ms | 14.14 |
| 8 | 11.37 ms | 20.40 |
| 8, 7 seats also sending input | 11.15 ms | **35.31** |

The web display does the equivalent in a **direct function call** — microseconds — and
then waits for the next `requestAnimationFrame`. So the honest comparison is:

```
web      : input → (0–16.7 ms rAF wait) → draw → present
Android  : input → 9–35 ms of engine + marshalling → (0–8 ms render-thread wake)
                 → 2.6–7.1 ms draw → present
```

That extra 9–35 ms, growing with player count, is the "not as snappy".

## 2. Where the time goes

`public/display/DisplayInput.js:onInput` is three lines: state guard, action guard,
`displayGame.processInput(...)`. It never pulls a snapshot — the rAF loop does that
in-process with `getSnapshot()` returning **live refs** (no copy, no JSON).

`DisplayCoordinator.handleInput` (`DisplayCoordinator.kt:734`) does the same
`processInput`, then also pulls a **whole-room snapshot** through QuickJS. Per input
that is: a deep copy of every board (`PartyCore.copyPlayer`), `JSON.stringify`,
a JNI/coroutine round trip, and a kotlinx decode.

Measured per call, 8 seats:

| step | p50 |
| --- | --- |
| `evaluate()` binding floor (any trivial expression) | **~0.65 ms** |
| `Bridge.processInput` | 0.70 ms |
| `core.snapshot()` deep copy, no JSON | 2.87 ms |
| `+ JSON.stringify` | 5.59 ms |
| kotlinx decode, grid-stripped payload (3050 B) | 3.19 ms |
| kotlinx decode, full payload (5522 B) | 8.28 ms |
| `reattachGrids` | 0.17 ms |
| `withContext` hop (the bridge does 2–3 per snapshot) | 0.50–0.70 ms each |

Two structural facts fall out:

- **The `evaluate` floor is ~0.65 ms and is paid per call regardless of the work.**
  quickjs-kt has no call-with-arguments API, so every engine call is a JS source string
  that QuickJS re-parses. At a full party the coordinator makes ~10 of these per frame.
- **Grid stripping is earning its keep.** Full 8-seat snapshot 5522 B / 8.28 ms decode
  vs stripped 3050 B / 3.19 ms. Keep it.

### Per-frame budget at 8 busy seats

```
frame()                 6.02 ms   (of which ~3.3 ms is the always-on deep copy)
8 × processInput        5.91 ms   (of which ~5.2 ms is pure per-evaluate overhead)
1 × snapshot pull       9.19 ms   (coalesced to one per frame already)
                       --------
                       21.12 ms   vs a 16.67 ms frame
```

Over budget — so at a full party the loop cannot hold 60 Hz, and `tick()` (which
`MainActivity` **awaits** before requesting the next frame, `MainActivity.kt:225`)
starts missing vsyncs. That is the p95 blowing out from 17.8 ms to 36.4 ms.

## 3. Render side

`BoardSurfaceView.drawFrame` on a real hardware canvas at 1920×1080:

| boards | p50 | p95 |
| --- | --- | --- |
| 1 | 2.63 ms | 5.96 |
| 4 | 5.49 ms | 8.14 |
| 8 | 7.08 ms | 9.92 |

Fine, and on its own thread. But the render thread polls:

```kotlin
if (contentVersion == lastDrawnVersion && !animating) { sleep(8); continue }
```

`BoardSurfaceView.kt:280`. A snapshot submitted just after that check waits up to
**8 ms (mean 4 ms)** before drawing starts, and during quiet play `animating` is false
(it is only true while a pulse/anim/garbage-fx is live), so the idle path is the common
one mid-game. The thread is also free-running rather than vsync-aligned, so the buffer
it posts lands at an arbitrary point in SurfaceFlinger's cycle.

## 4. The other three platforms

Checked for the same three defects. The engine/marshalling problems are **native-only**,
and one of them is Android-only:

| | web | AirConsole | tvOS | Android TV |
| --- | --- | --- | --- | --- |
| whole-room snapshot pulled per input | no | no | **yes** | **yes** (fixed) |
| JS source re-parsed per engine call | n/a | n/a | no | **yes** (fixed) |
| `PartyCore.frame()` always deep-copies | n/a | n/a | **yes** | **yes** (open) |
| render thread idle-polls | no | no | no | **yes** (fixed) |

- **Web** never marshals: `DisplayInput.js:onInput` is a direct `displayGame.processInput`
  call, and the rAF loop reads `displayGame.getSnapshot()` — live refs, no copy, no JSON.
  It also drives `Game` directly, not `PartyCore`, so it never pays `copyPlayer` at all.
  Nothing to fix here.
- **AirConsole** is the same web display with the transport swapped for `AirConsoleAdapter`
  (`display-airconsole.js` touches bootstrap/ads/locale only). It inherits web's
  characteristics. Its extra latency is the AirConsole SDK's own message path, which is
  not ours to change.
- **tvOS** shares the render-on-input whole-room pull (`DisplayCoordinator.swift:720`, same
  `renderedInputSinceTick` guard) and the always-deep-copy `frame()`. It does **not** have
  the per-call parse problem — JavaScriptCore has a real call API
  (`bridge.invokeMethod(_:withArguments:)`), so its calls cost a fraction of Android's —
  and SpriteKit's `update(_:)` drives its render loop on vsync, so no idle poll.
  **`PartyCore.snapshotPlayer` is now available to it**; adopting it is a small change to
  `EngineBridge.swift` + its shim and is the one cross-platform follow-up worth doing.

## 5. What was changed, each A/B measured

Three fixes shipped. `PartyCore.snapshotPlayer()` is additive (all 588 JS tests and the
frame/room goldens pass untouched); the rest is Android-only.

### 5.1 Render-on-input pulls one seat (`PartyCore.snapshotPlayer`)

An input moves exactly one board; the pull copied, serialized and decoded all eight. The
coordinator now merges the one seat into the snapshot already on screen.

Through the real `EngineBridge`, warmed, same process (`EnginePerfTest.inputPathBeforeAfter`):

| | 1 seat | 4 seats | 8 seats |
| --- | --- | --- | --- |
| old: `processInput` + whole-room `snapshot` | 7.67 ms | 8.87 | 10.83 |
| new: `processInputs` + `snapshotPlayer` | **6.93 ms** | **5.38** | **5.07** |

The new cost is essentially flat in player count, which is the point.

### 5.2 A frame's inputs go over in one `evaluate`

The per-call parse floor (~0.65 ms) dominated the input itself. Inputs now queue and flush
as one batch; `flushInputs()` runs ahead of every other engine call so a soft-drop, frame
or snapshot can never observe a board that queued input has already moved past.

| | 4 seats | 8 seats |
| --- | --- | --- |
| one eval per input | 4.86 ms | 5.91 ms |
| one batched eval | **1.24 ms** | **1.05 ms** |

### 5.3 The render thread is signalled, not polled

`sleep(8)` replaced with a `ReentrantLock`/`Condition` that every ingress method signals
(`BoardSurfaceView.bumpContent`). The 50 ms timeout is a liveness backstop, not the wake
path, so the loop cannot stall even if a signal is ever missed.

### 5.4 End-to-end effect, same harness before and after

`InputLatencyTest`, warmed, on the device. "Before" was measured by stashing the
production changes and rebuilding, so both sides ran identical test code:

| case | before p50 / p95 | after p50 / p95 |
| --- | --- | --- |
| 1 seat | 9.42–9.93 / 11.1–12.9 | 12.4–13.4 / 20.8–21.3 |
| 4 seats | 10.54 / 14.14 | 11.21 / 16.08 |
| 8 seats | 11.37 / 20.40 | **7.52 / 11.42** |
| 8 seats, 7 busy | 11.15 / 35.31 | **6.07 / 29.12** |

**The 1-seat case got ~3 ms slower, and that is a deliberate trade.** It comes from input
batching: an input that arrives when this frame's repaint has already happened waits for
the next tick instead of being applied on arrival. Bypassing the batch restores 1-seat to
~10.1–10.8 ms but costs the 8-seat case (p50 8.61, p95 15.31) and 8-busy (p50 7.12, p95
30.21). Both variants beat the baseline at 8 seats; batching wins where the complaint
actually is, and 3 ms at one player is a fifth of a frame on a path that was never the
problem.

Caveat worth keeping: this harness has ~1–3 ms of run-to-run spread at p50, so read the
p95/p99 columns and the component A/B in 5.1–5.2 as the load-bearing evidence.

## 6. Still open

- **`PartyCore.frame()` always deep-copies the snapshot**, and the delivery path then
  discards it on 95% of frames when the scene signature matches. Computing that signature
  from `Game.getSnapshot()`'s cached live refs first would save 6.02 → 1.69 ms per frame at
  8 seats (measured).

  NOTE: `origin/main` (commit 33e48689, not yet merged into this branch) already moved
  `sceneSig`, grid stripping and frame delivery out of the two hand-synced native shims into
  `PartyCore.sceneSig` / `_stripUnchangedGrids` / `deliverFrame`. That makes this fix
  *easier*, not done — upstream `deliverFrame` still calls `this.frame()`, which still
  deep-copies unconditionally. Do it inside `deliverFrame`, where it is now one place for
  all three platforms.
- **tvOS adopting `snapshotPlayer`** for its render-on-input path (see section 4).
- **`CellSerializer`** (`Cell.kt:24`) decodes each `[col,row]` through
  `ListSerializer(Int.serializer())`: an `ArrayList` plus two boxed `Integer`s per cell,
  ~12 per player per snapshot.

## 7. Check this first on the real device

Before chasing anything further, confirm the fast lane is actually up — a controller that
fell back to the relay pays a server round trip and would feel exactly like this:

```bash
adb logcat -s Fastlane:I | grep -E "first input over P2P|iceConnectionState|watchdog"
```

`peer N: first input over P2P` per controller means P2P is live. `iceConnectionState=FAILED`
means that controller is on the relay fallback and its latency is a network problem, not
this one.

## 8. Maximum performance: where the time actually goes

Measured directly (`TransportPerfTest.whereFrameTimeGoes`), one warmed QuickJS, one
thread, so the variants are comparable. Each row adds one stage to the row above.

**8 seats** (the 1-seat block in the log ran first and is JIT-contaminated; trust 4 and 8):

| stage | p50 | delta |
| --- | --- | --- |
| simulation only (`update` + `drainEvents` + `toCommands`) | 1.20 ms | — |
| + `copyPlayer` deep copy | 3.00 ms | +1.80 |
| + `JSON.stringify` — **what crosses today** | 5.65 ms | +2.65 |
| native decode (kotlinx JSON) | 8.37 ms | +8.37 |
| **total to get one frame into Kotlin** | **14.0 ms** | |

Against a packed alternative — same data, encoded straight off `getSnapshot()`'s live
refs as one integer per UTF-16 code unit, no deep copy and no JSON on either side:

| stage | p50 |
| --- | --- |
| produce packed payload (sim included) | 2.06 ms |
| native decode (flat `IntArray` reads) | **0.064 ms** |
| **total** | **2.13 ms** |

Payload: 5490 chars of JSON vs 1211 packed.

Three things fall out, and they redirect the whole effort:

1. **The game simulation is ~0.5 ms.** The 1.20 ms "sim only" row still contains the
   ~0.65 ms per-`evaluate` floor. Actual physics for eight boards is roughly 4% of a
   frame. **The engine is not the problem and never was** — optimizing game logic, or
   porting it off JS, would buy almost nothing.
2. **Native JSON decode is the single most expensive thing in the product**: 8.37 ms,
   ~60% of the whole pipeline, and **131× more expensive than reading the same data as
   packed ints**. Every millisecond of it is spent rebuilding `List<List<Int>>` grids
   (135 boxed `Integer`s per board) that the renderer immediately flattens again.
3. **The deep copy is pure waste on this path.** `copyPlayer` exists so a host can
   *retain* a snapshot across frames. A payload being serialized on the spot never
   retains anything — and the packed encoder reading live refs (2.06 ms) is cheaper
   than the deep copy alone (1.80 ms) plus everything after it.

### A constraint worth writing down

The bridge marshals JS strings as C strings, so a `\u0000` code unit **truncates the
payload**. Zero is the most common value in this data (every empty grid cell), so a
packed encoding must bias every value (+1 is free) or use a real binary channel. The
first prototype came back one character long, which is how this was found.

The bias has a second edge, and it bites at the *other* end: `String.fromCharCode`
takes its argument mod `0x10000`, so a raw `0xffff` biases to `0x10000` and comes back
out as the very NUL the bias exists to avoid. The usable wire range is therefore
`0..0xfffe`, and values wider than one code unit must cross as **15-bit** halves — a
16-bit half is exactly the one that can land on `0xffff`. With 16-bit halves `elapsed`
hit it 65.5s into every match (and every 65.5s after), truncating that frame on both
TVs; roughly one four-minute match in five. `encodeInts` now asserts the range, so a
future field that outgrows it fails in the packer rather than on a TV.

## 9. The clean end state

Four changes, in dependency order. Together they take the 8-seat frame from ~14 ms of
boundary cost to ~2 ms.

1. **One packed integer payload per frame, generated in `PartyCore.js`.** A fixed,
   versioned, struct-of-arrays layout emitted by one function, pinned by a golden
   fixture exactly like `partycore-frame-golden.json`. This replaces per-platform JSON
   models (`Snapshot.kt` + `FrameParsing.swift` + kotlinx/JSONSerialization) with one
   schema and two ~40-line readers. Composes with the existing `gridVersion` stripping:
   a steady-state 8-seat frame becomes ~128 ints.
2. **Serialize from live refs; stop deep-copying on the delivery path.** Keep
   `snapshot()` as the retaining value-copy for hosts that need one; `deliverFrame`
   should not use it.
3. **One `evaluate` per frame.** Input batching (already shipped) plus folding the
   snapshot pull into the same call amortizes the ~0.65 ms floor that Android pays per
   call. tvOS doesn't need this — JavaScriptCore has a real call API.
4. **Run the engine on the coordinator thread.** ~1.5 ms per frame is currently spent in
   `withContext` hops that exist to keep the 168 ms bundle *parse* off the UI thread.
   Keep bootstrap off-main; once a frame costs ~2 ms, the steady-state calls belong
   inline, which is the model tvOS already uses ("everything on .main").

After that the dominant remaining cost is the canvas draw (7.1 ms for 8 boards), which
becomes the next thing worth attacking — per-board cached layers and redrawing only
boards whose `gridVersion` moved.

### Per platform

- **Web / AirConsole: do nothing.** They have no boundary — `getSnapshot()` returns live
  refs into the same heap the renderer reads. The packed encoder must stay opt-in for the
  natives; forcing web through it would *add* work that platform doesn't currently do.
- **tvOS: the same four apply**, except (3). Its decode is already cheaper than Android's
  (hand-rolled `FrameParsing`, not `JSONDecoder`), so its win is smaller than 6.6× but
  the same shape. JavaScriptCore also exposes typed arrays directly, so it could skip the
  UTF-16 bias trick and share an `ArrayBuffer` outright.
- **Android TV: all four.**

### On reverting `origin/main`

Don't. Commit `33e48689` moved `sceneSig`, grid stripping and frame delivery out of the
two hand-synced native shims into `PartyCore.deliverFrame`. That refactor **costs
nothing** — it relocated existing work — and `deliverFrame` is precisely the single site
where changes 1 and 2 belong. Reverting it would mean implementing the packed encoder
twice, in a Kotlin string and a Swift string, and keeping them in sync by hand. It makes
this plan easier, not harder.


## 10. Shipped: the packed native wire format

`PartyCore.packFrame` / `unpackFrame` (server/PartyCore.js) with readers on both
natives (`PackedFrame.kt`, `PackedFrame.swift`). Web and AirConsole are untouched by
design — they have no boundary to cross.

### What it measures, on device

Decoding the SAME eight-seat snapshot, warmed, one process:

| decoder | p50 | vs JSON |
| --- | --- | --- |
| kotlinx JSON -> boxed model | 9.28 ms | — |
| **packed -> boxed model (shipped)** | **1.60 ms** | **5.8x** |
| packed -> flat `IntArray` (not shipped) | 0.064 ms | 145x |

Payload at eight seats: 5490 chars of JSON against 1211 packed.

### What that is worth in the real path, and why it is less than 5.8x

`EngineBridge.snapshot()` at eight seats went **8.48 ms -> 5.32 ms** (-37%), not -83%,
and `frame()` did not improve. Both have the same cause and it is worth being precise
about:

* **Grid stripping had already removed most of the JSON cost.** The 9.28 ms row above
  is a snapshot carrying full grids. The live path only sends a grid when its
  `gridVersion` moved, so the steady-state JSON decode was ~3.2 ms, not 9.3 ms — the
  packed format is competing against an already-optimised payload.
* **Most frames carry no snapshot at all.** `deliverFrame` omits it when the scene is
  render-identical (measured: 668 of 900 frames at eight seats), and there is nothing
  to decode either way. `frame()` therefore has little room to move; the ~0.6 ms
  difference between runs is inside this harness's noise.
* **What is left is not decode.** After the change the per-pull cost is the ~0.65 ms
  per-`evaluate` floor, the JS-side pack, two coroutine hops (~1.5 ms) and
  `reattachGrids` — none of which the wire format touches.

### The object model is NOT worth flattening — measured

An earlier draft of this section claimed the remaining 25x (packed -> boxed 1.60 ms
against packed -> flat 0.064 ms) was the biggest win left. That was wrong, and wrong in
an instructive way: **that ratio was measured on a payload carrying full grids**, and
the delivery filter strips a grid whose `gridVersion` has not moved — 24 of 900 frames
at eight seats carried one. A ratio from the rare case was quoted as if it were the
common one.

The steady-state payload (grid stripped, ~97% of frames), eight seats:

| decoder | p50 |
| --- | --- |
| packed -> boxed objects (shipped) | 0.155 ms |
| packed -> flat ints | 0.021 ms |

**0.13 ms per frame, 0.8% of a frame**, plus ~0.05 ms amortised over the rare
grid-carrying frames. Flattening `PlayerState.grid` to an `IntArray` is a *small*
change — three call sites in `BoardRenderer` plus `reattachGrids`, and the models are
no longer JSON-decoded in production — it simply is not a *valuable* one. Left alone
deliberately.

### Correctness gates

* `tests/partycore-packed.test.js` — round-trips every delivered frame of a driven
  corpus (1/2/8 seats, 1200 frames each) through pack -> unpack, plus hand-built
  snapshots for the shapes the engine does not reliably reach (clearing cells, absent
  piece/ghost, empty next queue, values past the split, negative coordinates).
* The same file asserts the payload never contains a NUL at any board state — the
  invariant the +1 bias exists for, since both bridges marshal JS strings as C strings —
  and pins every split field on the `0xffff` boundary and either side of it, plus a
  match walked across all four `elapsed` boundary crossings.
* `tests/fixtures/partycore-packed-golden.json` pins packed payloads and the frames
  they must decode to. BOTH ports replay it — `PackedFrameTest` (Kotlin) and
  `PackedGoldenConformanceTests` (Swift) — so a layout change landing on one side only
  fails a build rather than a TV. The fixture ends with three synthetic steps that
  drive the 15-bit split with a non-zero high half: a driven match never gets there
  (a few seconds of `elapsed`, single-digit `gridVersion`s), and with a zero high half
  every shift width decodes identically, so without them a port using 16-bit halves
  replayed the whole corpus byte-for-byte and the gate proved nothing.
* `tests/room-bridge-shim-parity.test.js` drives the packed surface through the real
  bundle in a bare VM for BOTH shims, and holds their ENGINE-API token-identical.

### Also folded in

* `processInputs` and the per-seat pull are now on **both** platforms (they were
  Android-only), so tvOS gets the render-on-input fix too.
* `elapsed` crosses at whole-ms precision. Its only readers floor it to seconds (the
  match timer, `sceneSig`), so the fraction has no consumer; documented at the codec
  and asserted in the round-trip test rather than left as a silent lossy edge.


## 11. Shipped: fused crossings, and where this now stands

Two more changes, both on **both** natives.

### 11.1 A frame's input rides into the read

`framePacked(now, batch)` and `snapshotPlayerPacked(pid, batch)` apply the queued input
before they read, so a tick — or a render-on-input pull — is ONE crossing instead of
two. `processInputs` stays for the paths with no read to fuse into (pause, rekey,
soft-drop ordering). The batch is applied first in every case, so nothing observes a
board that queued input has already moved past.

Worth ~0.65 ms per frame on Android, which is the per-`evaluate` floor, not engine work.
tvOS pays no parse floor (JavaScriptCore has a real call API) but still saves a crossing.

### 11.2 The decode hop is gone

`decodePacked` ran inside `withContext(Dispatchers.Default)` — inherited from the JSON
path, where a ~3 ms parse was worth moving off the caller's thread. The packed decode is
~0.16 ms at eight seats, and a dispatcher round trip on this hardware measures
0.5–0.7 ms: **the hop cost more than the work it was protecting the caller from.** Now
inline on the dispatcher the call is already running on.

### 11.3 tvOS is now actually wired

An earlier commit message claimed tvOS had picked up `processInputs` and the per-seat
pull. It had not — only the *bridge* methods existed; `DisplayCoordinator.swift` still
called `processInput` per message and pulled a whole-room `snapshot()` per input. It is
wired now: queue, per-seat pull fused with the batch, merge into the retained snapshot
(carrying `elapsed` from the pull so the match clock cannot stall while a direction is
held), and `flushInputs()` ahead of soft-drop, pause and rekey.

### End to end, same warmed harness, baseline vs now

| case | before, p50 / p95 | now, p50 / p95 |
| --- | --- | --- |
| 1 seat | 9.42 / 11.1 ms | **4.61 / 8.24** |
| 4 seats | 10.54 / 14.14 | **7.61 / 12.67** |
| 8 seats | 11.37 / 20.40 | **6.98 / 10.43** |
| 8 seats, 7 busy | 11.15 / 35.31 | **6.11 / 24.79** |

Roughly a 40–50% cut at p50 across the board and ~50% at p95 for eight seats. The
1-seat regression the batching change introduced (+3 ms, flagged when it shipped) is
resolved by the fusion: the deferred input no longer costs an extra crossing.

## 12. What is left, and why it is being left

**The canvas draw — 7.34 ms at eight boards — is now the largest single cost in the
pipeline.** Split measured: the full-screen clear is 1.0 ms (14%), the boards ~6.3 ms,
about 0.79 ms each. The locked stack is already cached to a per-board bitmap, so what
remains is real drawing: moving piece, ghost, near-clear pulse, HUD, outline, garbage
meter. There is no obvious waste to remove, only a rewrite with genuine visual-regression
risk — and the board can only be verified on a device with real controllers attached.
It also runs on its own thread, so it costs photon latency, not throughput. Left alone.

**Flattening the object model** — measured at ~0.2 ms/frame, see section 10. Left alone.

**The remaining engine-path cost** is the per-`evaluate` floor (~0.65 ms, one call per
frame now), the JS-side pack, and one dispatcher hop. Going below that means a thinner
JNI binding than quickjs-kt, or dropping the JS engine — which the one-canonical-engine
architecture exists to prevent, and which would buy the ~0.5 ms the simulation actually
costs.

**Web and AirConsole remain untouched throughout.** They have no boundary to cross:
`getSnapshot()` returns live refs into the renderer's own heap. Every change in sections
10 and 11 would be pure added work there.
