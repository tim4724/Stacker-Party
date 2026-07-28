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
| `IngressPerfTest` | DataChannel packet → coordinator, and one thread wake per priority (part II) |
| `../render/BoardCacheParityTest` | the per-board display-list cache: pixel parity + saving (part II) |

**Caveats.** These run in an instrumentation process, so absolute figures move with CPU
governor and core placement; the A/B comparisons and the relative shape are the solid
part. `InputLatencyTest` stops at `renderSnapshot`, so it excludes the render thread's
wake, its draw, and SurfaceFlinger present — it is a **floor**, not the full photon path.

**Sections 1-12 are the JS↔native boundary.** They start where a decoded INPUT reaches
the coordinator and stop where a snapshot reaches the renderer. **Part II (sections
13-14)** covers the two segments outside that — the network path in, and the pixels out —
and compares web, tvOS and Android TV across the whole thing. Read part II first if the
question is "why does one platform feel different from another".

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
out as the very NUL the bias exists to avoid. Values wider than one code unit must
therefore cross as **15-bit** halves — a 16-bit half is exactly the one that can land
on `0xffff`. With 16-bit halves `elapsed` hit it 65.5s into every match (and every
65.5s after), truncating that frame on both TVs; roughly one four-minute match in five.
`encodeInts` now asserts the range, so a future field that outgrows it fails in the
packer rather than on a TV.

The guard was later tightened again (§20): raw `0xd7ff..0xdffe` biases into lone UTF-16
surrogates, which are not guaranteed to survive C-string marshalling either (JSC
substitutes U+FFFD), so the asserted single-unit range is now `0..0xd7fe`. No real
field gets anywhere near it; split halves max out at `0x7fff`.

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

## 12. What was left here, and what section 13 did with it

**The canvas draw — 7.34 ms at eight boards — is now the largest single cost in the
pipeline.** Split measured: the full-screen clear is 1.0 ms (14%), the boards ~6.3 ms,
about 0.79 ms each. The locked stack is already cached to a per-board bitmap, so what
remains is real drawing: moving piece, ghost, near-clear pulse, HUD, outline, garbage
meter. There is no obvious waste to remove, only a rewrite with genuine visual-regression
risk — and the board can only be verified on a device with real controllers attached.
It also runs on its own thread, so it costs photon latency, not throughput. Left alone.

> **Superseded by §13.3.** The premise — that cutting this means rewriting the drawing —
> was wrong. The boards do not need to be drawn differently, only *re-recorded* less
> often, and the pixels are provably unchanged because the replayed display list is the
> same command stream. 7.25 ms → 3.98 ms on the frame an input produces.

**Flattening the object model** — measured at ~0.2 ms/frame, see section 10. Left alone.

**The remaining engine-path cost** is the per-`evaluate` floor (~0.65 ms, one call per
frame now), the JS-side pack, and one dispatcher hop. Going below that means a thinner
JNI binding than quickjs-kt, or dropping the JS engine — which the one-canonical-engine
architecture exists to prevent, and which would buy the ~0.5 ms the simulation actually
costs.

**Web and AirConsole remain untouched throughout.** They have no boundary to cross:
`getSnapshot()` returns live refs into the renderer's own heap. Every change in sections
10 and 11 would be pure added work there.

---

# Part II — the network path, and the three platforms end to end

Sections 1-12 measure from the moment a decoded INPUT reaches the coordinator to the
moment a snapshot reaches the renderer. That leaves out both ends: how the packet gets
from the radio to the coordinator, and how the renderer's output gets to a pixel. Those
are the two segments below, and they are where the remaining difference between web,
tvOS and Android TV lives.

Same device throughout (Google TV Streamer, kirkwood, Android 14), same reproduce
command as section 0, plus:

```bash
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew :tv:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.package=com.hexstacker.tv
adb logcat -d -s HexPerf:I
```

New benchmarks:

| file | what it measures |
| --- | --- |
| `perf/IngressPerfTest` | DataChannel packet → coordinator; one thread wake priced per Android thread priority |
| `render/BoardCacheParityTest` | the per-board display-list cache: pixel parity against a direct draw, and what it saves |

## 13. How the three platforms react to input

### 13.1 The path, per platform

Everything up to the display is IDENTICAL on all three — it is the same phone running
the same `public/controller/` code and the same `partyplug/PartyFastlane.js`:

```
finger → pointerdown/move/up (TouchInput.js)
       → onInput → sendToDisplay          [no batching, no coalescing: fires on the event]
       → fastlane.enqueue → JSON.stringify → channel.send
```

The DataChannel is `{ordered: false, maxRetransmits: 0}` with app-layer redundancy (the
rolling window resends every unacked event for TTL_MS=300 at TICK_MS=50 until the peer
acks). So an input is on the wire in the same task that produced it, and loss costs a
50 ms resend rather than an SCTP retransmit timer. Nothing on the controller side defers
an input, on any platform. **The divergence is entirely on the display.**

| | web / AirConsole | tvOS | Android TV |
| --- | --- | --- | --- |
| packet lands on | the page's main thread | libwebrtc thread → `DispatchQueue.main` | libwebrtc net thread → `fastlane` executor → coordinator's action channel on Main |
| thread handoffs before the coordinator sees it | **0** | 1 | **2** |
| envelope decode | `JSON.parse` | `JSONSerialization` | `kotlinx.parseToJsonElement` → `JsonObject` tree |
| input reaches the engine by | direct call, same heap | `JSValue.invokeMethod` (real call API) | interpolated JS source string, `withContext` to the engine thread |
| engine crossing cost | **0** | no parse floor, no thread hop | ~0.65 ms parse floor + ~0.6 ms hop |
| repaint trigger | next `requestAnimationFrame` | next SpriteKit `update(_:)` (vsync) | signal a free-running render thread (draws immediately) |
| unchanged boards on a repaint | skipped (per-board tile cache + `playerRenderSig`) | **re-synced anyway** (`BoardNode.update` runs for every seat) | skipped as of §13.3 |

Two things fall out of the table and they are worth stating plainly:

- **Web has no boundary and never will.** `DisplayInput.js:onInput` is a direct
  `displayGame.processInput`, and the rAF loop reads live refs. Its whole added latency
  is the wait for the next vsync (0-16.7 ms, mean 8.3). There is nothing to optimise
  there, and every native-side change in this document would be pure added work.
- **Android pays for its transport twice**: once because it has two ingress handoffs
  where tvOS has one, and once because quickjs-kt has no call-with-arguments API while
  JavaScriptCore does. Neither is a bug; both are the price of the runtime.

### 13.2 Ingress, measured

`DataChannel packet → the thread the coordinator consumes on`, in the shipping shape
(copy the reused buffer on the network thread, post to the serial executor, parse there,
run `FastlaneReceiver`, hand over), warmed:

| segment | p50 | p95 |
| --- | --- | --- |
| whole ingress, consumer parked | 0.92-0.99 ms | 1.15-1.21 ms |
| **whole ingress, consumer warm** (what §16a made it) | **0.87 ms** | 1.64 |
| of which: fastlane envelope parse + dedup (65-230 B) | 0.26-0.29 ms | 0.31-0.44 |
| of which: one bare thread wake | 0.073 ms | 0.12 |

The warm row is the honest one now: since §16a the consumer is the game thread, which ticks
at 60 Hz and is never parked for long, so the parked-consumer variant overstates it by
~0.12 ms.

So roughly a third is the kotlinx JSON tree for a 131-byte packet and the rest is the two
handoffs. It is real but it is under a millisecond, and both halves resist cheap fixes:
the tree is needed because the events inside `h` are handed on as `JsonObject` for
`ControllerMessage.from`, and collapsing the executor hop means running `FastlaneReceiver`
and the peer map on libwebrtc's network thread, racing `onDataChannel`'s channel/receiver
swap in a file whose lifecycle comments are all scar tissue. Not worth it for ~0.5 ms.

**Thread priority is not the lever, and this is the main reason to keep the benchmark.**
A first pass suggested raising the ingress threads to `THREAD_PRIORITY_DISPLAY` cut the
ingress 38% (2.19 → 1.36 ms p50). Running each variant twice, alternating, showed that
was warm-up: the second passes land on top of each other (0.92 ms default vs 0.95 ms
display). A bare wake is 73 µs at default priority and no faster at display or
urgent-display. Nothing was changed here — but the measurement is checked in so the idea
does not get re-proposed on the strength of a one-pass A/B.

### 13.3 Shipped: the per-board display-list cache (Android)

An input moves exactly ONE board. Gravity steps one or two more. Yet every repaint
re-drew all eight, because `Surface.lockHardwareCanvas()` hands back a swap-chain buffer
with no preserved content, so there was no way to leave seven boards alone.

There is one: that canvas **is** a `RecordingCanvas` (HWUI records into a RenderNode
internally — verified on device, `android.graphics.RecordingCanvas`), so a board whose
render inputs have not moved can be **replayed from its recorded display list** instead
of re-recorded. `BoardSurfaceView` now keeps one `RenderNode` per board plus a per-board
signature — the port of web's `DisplayRender.playerRenderSig`, which gates the same skip
on that platform.

`BoardCacheParityTest.cacheSavingAtEightBoards`, cached-first and cached-last with the
uncached run between them, so warm-up cannot be credited to it:

| 8 boards @1920×1080 | p50 | p95 |
| --- | --- | --- |
| all re-drawn (before) | 6.99 ms | 9.09 |
| all replayed, nothing moved | **3.98 / 3.46 ms** | 7.24 / 7.61 |
| **one board dirty — the frame an input produces** | **3.81 ms** | 6.20 |

45% off the repaint an input causes, and 47% off a steady frame. The same shows up in
`RenderPerfTest.drawCost`, which redraws one submitted snapshot and so measures the
all-clean case, and which is the table section 3 quotes:

| boards | before p50 | after p50 |
| --- | --- | --- |
| 1 | 1.92 ms | 2.34 |
| 4 | 3.60 ms | **3.27** |
| 8 | 6.06 ms | **3.64** |

**At one board there is nothing to gain and the p50 reads slightly worse**; mean (2.20 →
2.05), p95 (3.20 → 2.83) and max (4.35 → 3.08) all improved on the same run, so that is
harness noise rather than a real cost, and a single board still benefits on frames driven
by the timer or an animation rather than by the board itself. No player-count gate was
added: it would be a magic constant bought with nothing measurable.

**Why this is not a visual risk.** The recording is not an approximation of the draw —
it is the same command stream `BoardRenderer.render` would have emitted straight onto the
canvas. `BoardCacheParityTest` renders four real match frames at 1, 4 and 8 boards both
ways onto an `ImageReader`-backed hardware canvas and compares the buffers **byte for
byte**; a `disableBoardCache` hook makes the uncached path reachable from the test. The
cached path is entered only when the canvas really is a `RecordingCanvas` (that is an
HWUI implementation detail, not a contract) and only on API 29+; otherwise the old loop
runs unchanged.

Three things had to be got right, and they are the parts to re-read before touching it:

1. **The signature must name everything `drawBoard` reads.** A missed field is a stale
   board on screen. It carries web's fragment verbatim (alive/lines/level/pendingGarbage/
   gridVersion/holdPiece/currentPiece incl. `cells[0]`, and the 0/1/2 disconnect-QR state,
   since the QR bitmap resolves asynchronously) plus `clearingCells.size` and the next
   queue — the two things web tracks outside its signature rather than inside it.
2. **Wall-clock effects must re-record every frame.** The near-clear pulse and clearing
   glow are reported back by `render`; the garbage-meter flashes report nothing and fade
   against `nowMs`, so their presence is tested directly. A board that *starts* pulsing is
   caught by the signature, because every trigger is in it.
3. **Shake rides on the node, not in the recording.** `node.translationX/Y` instead of
   `canvas.translate`, or the offset — which changes every frame — would invalidate every
   shaking board's recording on every frame, i.e. exactly when the saving matters.
   Display lists are also discarded before `BoardRenderer.recycle()` in both
   `rebuildLayout` and `surfaceDestroyed`: a list replayed against a recycled bitmap throws.

## 14. Where the remaining time goes, and why each piece stays

Android TV, eight seats, warm, controller input to buffer queued:

| segment | p50 | fixable? |
| --- | --- | --- |
| LAN P2P DataChannel | ~1-3 ms | no — network |
| ingress: 2 handoffs + envelope parse | 0.92 ms | §13.2 — ~0.5 ms available, costs a data race |
| coordinator + engine crossing + decode + merge | 5.07 ms | ~0.7 ms is the hop; see §14.1 |
| render-thread wake | 0.073 ms | already signalled, not polled (§5.3) |
| draw + queue, one board dirty | 3.81 ms | was 6.99 (§13.3) |
| SurfaceFlinger present | ~1 vsync | no |

Against web's added latency on the same input: ~0.1 ms of work plus the rAF wait (mean
8.3 ms). tvOS sits between them — one ingress hop, no parse floor, no thread hop, and
SpriteKit composites on vsync whether or not we touched the scene, so its render-on-input
costs node updates rather than a second draw.

### 14.1 The engine hop cannot simply be deleted — this crashes

`EngineBridge` wraps every call in `withContext(engineDispatcher)`, worth ~0.6 ms p50
(0.56-0.72 across runs) and up to 2.6 ms at p99. The class comment notes the QuickJS C
runtime "has no thread affinity", and quickjs-kt runs `evaluate` on the caller's thread,
so the hop looks like pure policy — keep work off Main — and therefore deletable.

**It is not.** Probed on the device: a runtime created on one thread and driven from
another ran 200 frames and a snapshot correctly, and then

```
Fatal signal 11 (SIGSEGV), code 2 (SEGV_ACCERR) in JS_CallInternal
Cause: stack pointer is not in a rw map; likely due to stack overflow.
```

on `(function f(){return f()})()` — which on the creating thread returns a catchable
`InternalError: stack overflow`. QuickJS calibrates its overflow guard against the stack
of the thread that created the runtime, so from a foreign thread the guard never trips
and the native stack runs off the end. The engine does not recurse deeply today, so this
would probably never fire in a match; it would also turn any future JS recursion bug into
a process kill instead of an error. Not worth 0.6 ms.

The hop *can* still go, but only the expensive way: move the **coordinator** onto the
engine thread (`dispatcher = engineDispatcher` in `MainActivity`), so QuickJS is still
only ever entered from its own thread and `withContext` to the same dispatcher stops
dispatching at all. That removes the hop from the tick as well as from input — ~1.2 ms
per busy frame. The cost is that every `DisplayOutput` call then arrives off-main:
`BoardSurfaceView` is already built for it (volatile fields, a `ConcurrentHashMap`, and
`bumpContent` mutating `contentVersion` under `contentLock`) and the Compose model is
`StateFlow`-backed, but ExoPlayer needs main and `stopRenderThread` must stay on main.
That is the next real win on this platform, and it is a threading refactor, not a tweak.

### 14.2 tvOS re-syncs all eight boards when one moved — SHIPPED, see below

`BoardScene.renderSnapshot` calls `boardNodes[p.id]?.update(with: p)` for **every** seat
on every snapshot. `update` guards the two expensive rebuilds internally (`lastTier`,
`lastGridVersion`) but `rebuildGhost/Preview/NearClear/Piece/Clearing` and `updateHUD`
run unconditionally, allocating and re-parenting SKNodes — on the main thread, which is
also where JavaScriptCore runs. That is the same waste §13.3 just removed on Android and
that web never had.

The fix is smaller than Android's, because `update` is a pure function of the
`PlayerSnapshot` plus caches keyed on it (the animations are SKAction-driven and are
added by `handleGameEvent`, not by `update`): skip the call when the seat's snapshot is
unchanged from the one last rendered into that node.

**Done.** `BoardScene.renderSnapshot` now skips `BoardNode.update` for a seat whose
`PlayerSnapshot` is unchanged from the one last rendered into that node.

The gate is struct equality, not a hand-listed signature like Android's: `PlayerSnapshot` is
already `Equatable`, so there is no field to forget. Sound because `update` is a pure
function of the seat plus caches keyed on it — the animations (lock flash, line clear,
shake, garbage, KO) are SKAction-driven and arrive via `handleGameEvent`, which does not go
through it.

The trap is invalidation, and it is not the obvious one. `applySize()` replays `lastSnapshot`
*specifically* to re-apply geometry after a size or safe-area-inset change — a naive skip
makes that replay a no-op and strands the boards on the inset-less layout forever. It is
handled at a single point: `ensureBoards` clears the ledger whenever it rebuilds, and
`relayout()`, `showScreen(.game)` and `resetBoards()` all clear `lastBoardIds`, so every one
of them arrives back there.

**Verification, and its limits.** There is still no Apple TV on this bench, and `swift test`
(101 tests) covers HexStackerKit but not `BoardScene`. What was done instead: the tvOS
target builds, and the Simulator gallery (`scripts/gallery/capture-tvos.sh`) captures all 24
states through the real `renderSnapshot`. That path exercises the replay risk directly,
because the safe-area insets land *after* the first render.

A byte comparison against a pre-change capture is worthless here and the control proves it:
capturing the SAME code twice leaves **the same 16 of 24 shots differing** — every state
with live particles or a running clock. So the shots were judged visually instead: at four
and eight boards every seat renders its stack, ghost, current piece, HOLD/NEXT, HUD and
per-seat tier chrome, inside the title-safe area. A broken skip or a missed invalidation
would show as a blank, stale or mis-laid-out board, and none appears.

Still worth a device pass and a before/after on `update` cost, which needs an Apple TV.

## 15. Would a different JS engine help? No — but a different BINDING would

The ~0.65 ms per-`evaluate` floor from §2 was assumed to be QuickJS re-parsing the source
string. It is not, and that changes what is worth doing.
`JsBindingPerfTest.evaluateFloorComposition`, warmed, all calls already on the engine
thread so no dispatcher hop is included:

| | p50 |
| --- | --- |
| `evaluate("1")` — 4 chars | 1250 µs |
| same expression, 200-char source | 1111 |
| same expression, 2000-char source | 948 |
| `evaluate(compile("1"))` — parse removed | 819 |
| a JS function returning 0, no args | **776** |
| the same call with an 8-input batch as a source literal | 866 |
| `B.frameNoJson(now)`, 8 seats, source | 3444 |
| the same call precompiled to bytecode | 3248 |

**Cost does not grow with source length** — it falls, which is warm-up ordering, so parse
is in the noise. **Precompiling saves ~6%.** What is left, ~780 µs, is `QuickJs.evaluate`
itself: `evalInSession` allocates a session and an evaluation state, calls
`loadModules`, takes `jsMutex`, JNI-calls `getEvaluateResultPromiseId`, takes `jobsMutex`,
runs the promise-await machinery, retakes `jsMutex` for `getEvaluateResult`, then in
`finally` does a `withContext(NonCancellable)` plus both mutexes again and
`releaseEvaluateResult`. Roughly five JNI calls and four suspending mutex acquisitions per
call, to support async/Promise semantics `EngineBootstrap.SHIM` never uses.

Set against it: the actual engine work in a packed 8-seat frame is ~900 µs (1681 µs
measured, minus the 780 µs floor), and §8 already established the simulation itself is
~0.25 ms. So:

- **Swapping QuickJS for Hermes or V8 buys almost nothing on this axis.** The parse it
  would eliminate is already free (Hermes' AOT bytecode would only help the one-off 168 ms
  bundle load), and the ~900 µs of execution is the smaller half of the JS-side cost. Both
  bring a much larger APK, and both still need a binding layer whose per-call cost would
  have to be *measured*, not assumed better.
- **Replacing the BINDING is worth ~780 µs per call** — one per tick, two on a frame that
  also serves an input. Either a ~200-line JNI shim over QuickJS using `JS_Call` (keeps
  the engine, so every golden fixture and the packed codec stay valid), or Cash App's
  Zipline, which is QuickJS behind a bridge built for exactly this call pattern.
  Interpolated arguments are NOT the problem — a full 8-input batch as a source literal
  costs +90 µs.

## 15b. Shipped after all: Zipline, with the locale guarded

§15a rejected Zipline because it truncated decimal literals. That was right about the bug
and wrong about its scope: the cause is the process C locale, and it is fixable.

```
LC_ALL=de_DE.UTF-8   String(1.5) -> "1"     9*10/(1.5*9+0.5) -> 10
LC_ALL=C             String(1.5) -> "1.5"   9*10/(1.5*9+0.5) -> 6.428571428571429
```

Android carries no POSIX locale environment at all (`getprop persist.sys.locale` is de-DE,
but there is no `LANG`/`LC_*`, and bionic supports only "C"), so a device is safe. That is
still an assumption to depend game math on, so it is guarded three ways rather than hoped for:

1. **`EngineBridge.assertDecimalParsing`** evaluates `String(0.5)` at bootstrap, BEFORE the
   bundle, and refuses to return a bridge if it is not `"0.5"`. A broken locale fails loudly
   at startup instead of playing a subtly wrong game. This runs on every device launch and
   in every test that builds a bridge, which is what makes the Android claim evidence.
2. **Gradle pins `LC_ALL=C`/`LC_NUMERIC=C`** on every `Test` task, so the desktop goldens do
   not depend on the shell the developer or CI happens to use.
3. **`RenderMathParityTest`** stays the cross-engine gate — it is the ONLY test that caught
   the bug, because every other golden compares QuickJS against itself.

A second trap surfaced on the way in, and is worth more than the first: Zipline's QuickJS
records a stack base at runtime creation and checks every call against it, so re-entering
from a different thread throws a spurious `stack overflow` out of `compile()`.
`Dispatchers.Default.limitedParallelism(1)` — the old default dispatcher — is serial but
**may run successive tasks on different pool threads**, which trips it. The fix is not to
switch the guard off (the first attempt did, with `maxStackSize = 0`) but to give the
runtime a genuinely single thread: `create` now defaults to `newSingleThreadContext` and
owns/closes it, while Android passes its game thread. The guard stays armed.

That thread-confinement requirement is the same one §14.1 found the hard way with a SIGSEGV;
it was always true, and the old binding just failed to enforce it.

### What it bought

| | p50 |
| --- | --- |
| per-call floor, quickjs-kt (was) | 776 us |
| **per-call floor, Zipline (now)** | **78 us** |
| `execute()` of precompiled bytecode | 26 us |
| 8-input batch as a source literal | +85 us (unchanged; arguments were never the problem) |
| `B.frameNoJson`, 8 seats, source vs precompiled | 2448 vs 2312 us (~5%, still not worth it) |

**A 10x cut in per-call binding cost**, on the same device and harness. End to end it is
worth less than that and partly inside the noise, because the input path makes ONE engine
call and the rest of the path dominates: 2-4 seat p50 moved from ~3.1 ms to ~2.4-2.7 ms.
**p95 improved or held everywhere; the all-busy p99 did not improve and read worse on one
run (3 busy: 13.4 -> 25.8 ms).** That number has always been the noisiest in the suite — 150
samples with every other seat firing at 16 Hz, so one scheduling hiccup lands in p99 — and
it reproduced on a cool device, so it is not thermal. Not claimed as a win either way.

## 16. Priced: one game thread. ~1.5-2 ms, and it is not a library change

§14.1 concluded the `withContext` hop can only go by moving the coordinator onto the
engine thread. `InputLatencyTest` now measures that directly: two cases construct the
coordinator and the bridge on ONE shared dedicated dispatcher, which removes the
coordinator's action-channel hop to Main *and* the engine round trip (`withContext` to the
dispatcher you are already on does not dispatch), and takes input handling off the thread
Compose and the Choreographer share. QuickJS stays confined to its creating thread, so the
§14.1 crash is not reintroduced.

Same process, same harness. The one-thread case ran BEFORE both shipping 8-seat runs, so
warm-up works against it:

| 8 seats | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| shipping (coordinator on Main) | 5.96 ms | 9.61 | 11.11 | 11.29 |
| shipping, second pass | 5.54 ms | 8.64 | 9.77 | 10.48 |
| **one game thread** | **4.00 ms** | **7.32** | **9.56** | 9.62 |

**~1.5-2 ms off p50 and ~1.3 ms off p95** — around a third of the brain's cost, and it
matches the two hops it removes (~0.8 ms channel + ~0.6 ms engine).

**With seven other seats also sending, the tail gets worse, not better:**

| 8 seats, 7 busy | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| shipping | 5.57 ms | 20.97 | 26.46 | 26.47 |
| one game thread | **3.81 ms** | 24.30 | 32.65 | 43.99 |

That is the honest cost of the design: one thread must serialize the tick, eight
render-on-input pulls and the message decode that Main and the engine thread currently
overlap. Better at p50 in every case, worse in the tail at a full busy party.

Two things the benchmark does NOT model, both of which matter before building it:

- **The tick's hop comes back.** The harness ticks from the game dispatcher with
  `delay(16)`; `MainActivity` ticks from `awaitFrame()`, a Choreographer callback on Main,
  so a real port pays one hop per tick unless the game thread gets its own Looper and
  Choreographer (which is the right answer, and is how this is normally done).
- **Every `DisplayOutput` call arrives off-main.** `BoardSurfaceView` is already built for
  it (volatile fields, a `ConcurrentHashMap`, `bumpContent` under `contentLock`) and the
  Compose model is `StateFlow`-backed, but ExoPlayer needs main and `stopRenderThread`
  must stay on main.

## 16a. Shipped: one game thread

Built as §16 priced it. `MainActivity` now owns a single `hex-game` thread and passes its
dispatcher to BOTH the coordinator and `EngineBridge.create`, so the action-channel hop to
Main and the engine `withContext` round trip are both gone (`withContext` to the dispatcher
you are already on does not dispatch). QuickJS is created on that thread and only ever
entered from it, which keeps the §14.1 stack guard valid.

`TvDisplayOutput` now runs off Main, and takes a `runOnMain` for the two things that cannot:
ExoPlayer (it asserts its constructing thread) and View properties + the render thread's
lifecycle. Everything else stays inline, deliberately — `renderSnapshot` and
`handleGameEvent` ARE the input path, and posting them would put back the hop this exists
to remove. `BoardSurfaceView`'s ingress was already built for it.

The subtle part is ORDER, and it is the one thing to be careful about when editing
`TvDisplayOutput`: a posted block runs after everything the game thread does inline, so
`showScreen`'s board clear has to stay inline or the countdown's first snapshot lands
before the clear meant to precede it and gets wiped.
`TvDisplayOutputThreadingTest.showScreenClearsBeforeTheSnapshotItPrecedes` pins that with a
deliberately slow `runOnMain`; the other case in that file calls the whole `DisplayOutput`
surface from a foreign thread, where a stray ExoPlayer or View touch throws.

### Measured, order-immune

`InputLatencyTest.shapeComparison*` runs BOTH shapes inside ONE method, twice each,
alternating. That matters: with one shape per `@Test`, whichever ran first paid the JIT, and
the first attempt at this comparison had 4-player "legacy" beating "shipping" purely by
running 7th instead of 1st. Both passes now agree in both directions.

| 4 seats | p50 | p95 | p99 |
| --- | --- | --- | --- |
| legacy (coordinator on Main), pass 1 / 2 | 3.82 / 4.36 ms | 8.77 / 10.41 | 11.19 / 12.44 |
| **one game thread, pass 1 / 2** | **3.29 / 3.14** | **5.42 / 5.72** | **6.30 / 9.32** |

| 8 seats | p50 | p95 | p99 |
| --- | --- | --- | --- |
| legacy, pass 1 / 2 | 4.71 / 4.49 ms | 9.36 / 10.55 | 11.01 / 11.49 |
| **one game thread, pass 1 / 2** | **2.82 / 2.57** | **6.58 / 5.75** | **7.43 / 6.83** |

~20% off p50 at four seats and ~42% at eight, but the striking part is the **tail: ~40% off
p95 and p99 at both counts**. That is the confirmation of why it was there — input handling
was queueing behind Compose and the Choreographer on Main, and it no longer does. The
8-busy tail regression §16 warned about did not materialise at the seat counts that matter.

### The live numbers, all seat counts

| seats | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 1 | 2.40 ms | 3.90 | 4.72 |
| 2 | 2.96 | 5.05 | 5.46 |
| 3, 2 busy | 3.92 | 8.31 | 13.43 |
| 4 | 3.14-3.29 (warm; 4.41 on a cold first run) | 5.42-7.93 | 6.30-9.72 |
| 4, 3 busy | 2.65 | 9.43 | 17.05 |
| 8 | 2.57-3.01 | 5.24-5.75 | 6.83-7.03 |
| 8, 7 busy | 2.78 | 13.69 | 25.43 |

Against the session's starting point (4 seats 3.72 / 9.06, 8 seats 5.07 / 10.73) with the
§13.3 repaint change also in: an ordinary 2-4 player party is now ~3 ms to the renderer at
p50 and ~5-8 ms at p95.

### What is NOT verified

There is no self-playing demo mode on Android, so a full match driven by a real phone —
music, pause, reconnect, results — was not exercised on the device. What was: the lobby
renders (screenshot), every `DisplayOutput` call is safe from the game thread and the
`showScreen` ordering holds (`TvDisplayOutputThreadingTest`, on device), and the whole match
lifecycle from HELLO through 150 inputs at 1/2/3/4/8 seats runs through the real coordinator
and real `EngineBridge` on the shared thread (`InputLatencyTest`, on device, with a fake
`DisplayOutput`). A phone-in-hand pass is still worth doing.

## 17. Ranked, as of here

Android TV, 8 seats, warm, of a ~9.8 ms controllable input-to-buffer path:

| # | item | measured | what it needs |
| --- | --- | --- | --- |
| — | full-screen repaint per input | **done**: 6.99 → 3.81 ms | §13.3 |
| — | coordinator ↔ Main ↔ engine hops | **done**: ~20% p50 / ~40% p95 | §16a |
| — | quickjs-kt per-call wrapper | **done**: 776 -> 78 us per call | §15b — Zipline, with the locale asserted at bootstrap and the runtime thread-confined |
| 3 | ingress envelope + 2 handoffs | 0.87 ms warm, ~0.29 of it the JSON tree | MEASURED AND DECLINED: see below |
| 4 | tvOS re-syncs all 8 boards | unmeasured | §14.2 — needs an Apple TV |
| 5 | actual JS execution | ~0.9 ms | a different engine; the smaller half, and the riskiest change |
| 6 | packed decode → flat ints | 0.13 ms | §10 — measured, not worth it |

**On (3), the ingress: measured, and not worth touching.** Of the 0.87 ms, ~0.29 ms is the
kotlinx JSON tree and ~0.58 ms is the two thread handoffs. A hand-rolled reader for the
fixed `{ps,t,h:[...]}` envelope cannot recover all of the 0.29 ms, because the events inside
`h` still have to arrive as `JsonObject` for `ControllerMessage.from` — that is deliberate
(`Fastlane.onInput`'s contract is that a P2P input re-enters on the SAME path as a relay
message, so there is one input path and not two). Realistically ~0.2 ms, in the file whose
every comment is scar tissue from a lifecycle race. Removing a handoff instead is worth
~0.3 ms and means running `FastlaneReceiver` and the peer map on libwebrtc's network thread,
racing `onDataChannel`'s channel/receiver swap. Neither clears the bar at ~6% of a 3 ms
input path. **Left alone deliberately.**

**Shipped since:** the ALLM request (below) and the binding swap (§15b).

**What that leaves:** (4) needs an Apple TV,
(5) is the riskiest change for the smaller half of the JS cost, (6) is already measured as
not worth it. So the Android input path is done for now, and the honest next move is
verification on a real phone rather than another optimisation. **Thread priority (§13.2),
precompiled bytecode (§15), Zipline (§15a), the ingress (above) and flattening the object
model (§10) are all measured dead ends** — that is the part of this document most worth
reading before starting anything here.

## 15a. Tried and rejected: Zipline's QuickJS binding truncates decimal literals

> **Read §15b before acting on this.** The bug below is real and the diagnosis is right,
> but the conclusion was wrong: the cause is the process C locale, which is fixable and
> guardable, and Zipline SHIPPED. This section is kept because the failure mode, and which
> gate caught it, are the parts worth remembering.

§15 concluded the ~780 µs floor is quickjs-kt's wrapper, not QuickJS, and that a leaner
binding was worth ~780 µs per call. Cash App's Zipline was the obvious candidate: same
engine, public `QuickJs` class, synchronous `evaluate`/`compile`/`execute`, no coroutines
and no promise machinery. It was tried end to end (`:core` migrated, all ten test files
ported, `:tv`'s unit-test classpath swapped) and then **reverted**.

**The floor is real.** Same device, same thread, same bundle, same shim:

| | p50 |
| --- | --- |
| quickjs-kt floor (JS fn returning 0) | 776 µs |
| **Zipline floor, same call** | **78 µs** |
| Zipline `B.frameNoJson(now)`, 8 seats | 2184 µs |
| Zipline, same call precompiled | 2021 µs (~7%, so still not worth it) |

**And it is unusable.** `RenderMathParityTest` failed on the swap — `hexSize` came back
10.0 where the shared math says 90/14 = 6.4286. The cause, probed directly in JS:

```
JVM default locale: de_DE
String(1.5)             -> "1"
String(0.5)             -> "0"
String(1.5 + 0.5)       -> "1"
parseFloat('1.5')       -> 1
Number('1.5')           -> 1
JSON.parse('1.5')       -> 1
String(3/2)             -> "1.5"     // computed division is fine
Locale.setDefault(US)   -> still "1" // it is the C locale, not the JVM's
```

Zipline's `libquickjs` parses **decimal literals** through a locale-dependent `strtod`, so
in a comma-decimal environment every decimal constant in the bundle silently truncates to
its integer part. `1.5` becomes 1, `0.5` becomes 0. `Locale.setDefault` does not help,
because what matters is the process `LC_NUMERIC`, which the JVM does not own.

That is not a tuning problem, it is silently wrong game math — gravity timings, the garbage
table, colour math, geometry — on any device in a European locale, which is most of them.
Nowhere near worth 780 µs. quickjs-kt does not have the bug (the same parity test passes
against it, which is how this was caught at all).

Worth noting what did the catching: `RenderMathParityTest` compares the Kotlin render math
against the canonical web JS, and it is the ONLY gate that would have failed. The packed
goldens, the frame golden and the bridge-shim parity test all passed the swap, because they
compare QuickJS against itself. A binding change needs a cross-engine check, and that test
is it.

**If this is retried**, the remaining routes are: a locale-independent QuickJS build behind
a thin JNI shim of our own (`JS_Call`, ~200 lines, and it must set `LC_NUMERIC=C` or use
`JS_ParseFloat`-style locale-free parsing), or upstreaming a fix to Zipline. Do NOT retry
by simply bumping Zipline's version without re-running `RenderMathParityTest` under a
comma-decimal locale — `LANG=de_DE.UTF-8 ./gradlew :core:jvmTest` is the reproducer.

One incidental gotcha found on the way: **the two bindings cannot coexist.** Both install
`jni/<abi>/libquickjs.so`, so an APK or test classpath carrying both keeps one and the
loser's JNI symbols are missing at runtime — `UnsatisfiedLinkError` from a native method
that plainly exists. That is why the A/B above could not be left in the suite as a
permanent benchmark, and why `:tv`'s unit-test classpath already excludes one variant.


## 18. Shipped: asking the display to stop processing our frames

`Window.setPreferMinimalPostProcessing(true)`, once, in `onCreate`. It asks the panel for
HDMI ALLM / "game mode": drop motion interpolation, noise reduction and the rest of the
picture pipeline that sits between our buffer and the photons.

This is very likely the **largest single latency term in the product**, and none of it is
our code. TV post-processing typically costs 10-40 ms — against the ~7 ms of app time the
entire input path now takes. It was never set.

Set for the whole Activity rather than per screen: the flag makes the display renegotiate,
and a TV that flashes or re-syncs on every lobby↔game transition would be far worse than
the milliseconds it saves. A party is one game session end to end.

**Unverifiable from here, by nature.** Whether a panel honours the request, and what it is
worth, needs a camera or a latency tester pointed at a real TV. The bench display reports
`minimalPostProcessingSupported=true` and the app logs what it asked for and what the
display claimed:

```
MainActivity: requested minimal post-processing (ALLM); display reports supported=true
```

The request costs nothing when unsupported — the display ignores it — which is why there is
no fallback path and no capability gate beyond the API level.

## 19. Where the Android TV app now stands

Input to renderer, warm, shipping shape:

| seats | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 1 | 2.22 ms | 3.81 | 5.57 |
| 2 | 2.72 | 5.42 | 6.43 |
| 3, 2 busy | 3.31 | 9.97 | 25.75 |
| 4 | 2.45-2.49 | 4.68-5.38 | 6.06-8.91 |
| 4, 3 busy | 2.64 | 7.55 | 18.73 |
| 8 | 2.58 | 5.22 | 8.73 |

Against the session's starting point (4 seats 3.72 / 9.06, 8 seats 5.07 / 10.73). The
repaint an input causes went 6.99 -> 3.81 ms at eight boards over the same period.

Segment budget at four seats, warm:

| segment | ms | ours? |
| --- | --- | --- |
| LAN P2P DataChannel | ~1-3 | no |
| ingress: 2 handoffs + envelope parse | 0.87 | yes, measured and declined (§17) |
| coordinator + engine + decode + merge | ~2.5 | yes, ~0.08 of it binding overhead now |
| render-thread wake | 0.07 | yes, already signalled |
| draw + queue, one board dirty | ~3.3 | yes, §13.3 |
| SurfaceFlinger present | ~8 mean | no (60 Hz panel) |
| display post-processing | 10-40 on a TV | now asked to be off (§18) |

**The p50 story is done.** What is left is the all-busy p99 (18-26 ms at 3-4 seats), which
is the noisiest number here and has never responded to any change made in this document —
if input ever feels *inconsistent* rather than slow, that is the thread to pull, and it
wants a longer sampling run than this harness does before anyone optimises against it.

## 20. Review pass: the §16 leftovers closed, and the tail hypothesis paced away

A review of everything above surfaced that two of §16a's own warnings had shipped
un-fixed, plus one real staleness bug in §13.3's cache. All addressed; each verified on
the same device and harness.

### 20.1 The game thread now owns a Looper and a Choreographer

§16 said "the tick's hop comes back... unless the game thread gets its own Looper and
Choreographer (which is the right answer)" — and §16a shipped without it, so every tick
still paid a Main→game channel dispatch plus the ack dispatch back (~0.7-0.8 ms p50 per
frame by §14/§16's own numbers), and tick cadence sat behind whatever Compose had queued
on Main. `MainActivity`'s executor is now a `HandlerThread`; the tick loop runs ON the
game thread, driven by that thread's own Choreographer (the stock `awaitFrame()` always
resolves MAIN's Choreographer, so the loop uses its own await). A same-thread channel
send/ack is a Handler post, an order of magnitude cheaper than the cross-thread wake
(§13.2: 73 µs vs the 0.4-0.8 ms "Channel send -> consumer resume" row).

Relay callbacks moved with it: `RelayClient`'s poster now posts to the game handler, so
relay-fallback INPUT no longer queues behind Compose on Main (the fastlane path already
skipped it; the fallback path was the §16a contention argument applied twice). And the
lobby's 4 Hz tick throttle now covers RESULTS too, which can sit for minutes doing
nothing but the snapshot throttle's trailing edge and 1 Hz liveness.

Verified: `InputLatencyTest` reproduces the §19 table (8 seats 2.2-2.5 ms p50 shipping,
4.0-4.4 legacy, both A/B passes, both directions), and a real match was driven on-device
through lobby → join (web controller) → countdown → PLAYING → pause/resume → top-out →
RESULTS with zero crashes. On RESULTS the game thread idles at ~6% of a core.

### 20.2 Animation windows no longer saturate the swap chain

§5.3's signal-based wake fixed the IDLE case, but while any wall-clock effect ran the
render loop never parked: it drew as fast as `dequeueBuffer` backpressure allowed, which
keeps the swap chain 1-2 buffers deep — so an input landing in an effect window queued
its frame BEHIND already-queued animation frames, 1-2 extra vsyncs of photon latency
exactly when the game is busy. This is a plausible mechanism for §19's "all-busy p99
that never responded to anything": that number is measured to `renderSnapshot`, and the
queue effect starts after it.

Animation-only redraws are now paced to the panel's refresh interval by waiting out the
remainder on the SAME content condition, so new content still interrupts the wait and
draws immediately — the input path is never delayed by the pacing. Content-driven wakes
are untouched.

### 20.3 The cache could freeze an expired garbage flash (fixed, and now gated)

§13.3's `boardPulsing[j]` recorded only what `render` reports back (pulse/glow), not the
garbage-meter flashes, whose liveness the cache checks separately. Sequence: the last
recording taken while a flash was alive holds it at its final faint alpha; next frame
`pruneGarbageFx` empties the map, the signature is unchanged, nothing re-records, the
thread parks — and the residue replays until the next signature change. The flag now
means "this recording contains wall-clock content" and includes fx liveness, which
forces one clean re-record on the first fx-free frame (web's equivalent: `lastRenderSig
= null` while `mustAnimate`).

Gated by `BoardCacheParityTest.garbageFxExpiryLeavesNoResidueInCachedBoards`, which
drives both flash kinds through the real event path, lets them expire, and
byte-compares a cached draw against a direct draw. Run against the pre-fix code it
fails; with the fix the whole parity suite is green.

### 20.4 Smaller items from the same review

- **`QrCache` is off the render thread.** The disconnect-QR encode (multi-ms) ran
  inline in the render loop on first sight of an overlay, and a failed encode re-ran
  every frame. It now renders once on the game thread when the disconnect is recorded,
  and failures are negative-cached.
- **`TvDisplayOutput` races** (correctness, introduced by §16a): `_state` writers span
  the game thread and Main, so every read-copy-write became `_state.update {}`, and the
  roster/room fields shared across those threads are `@Volatile`.
- **`boardSig` allocation trim** on the render thread (`joinToString` dropped), the
  stale "coordinator runs on Main" comments corrected, and `EngineBridge.decode()`'s
  dispatcher hop removed (its rationale predated the game thread; the method itself
  stays — tests use it and the shim surface is parity-locked).
- **Packed codec hardening** (§8 constraint updated): single-unit wire range tightened
  to `0..0xd7fe` (surrogate band), Kotlin's reader now fails truncation with the same
  typed error as Swift, the golden fixture grew from 53 to 65 steps (the hand-built
  edge cases — clearing cells, absent piece/ghost, negative coords — are now replayed
  by BOTH native ports), and the native golden tests compare the events/commands tail
  field-by-field instead of by count.

### 20.5 Declined from the same review, with reasons

- **Pulse overlays as separate RenderNodes with animated node alpha** (would let a
  near-clear board replay its base recording while pulsing, ~0.4 ms/board during pulse
  windows). Declined: node-alpha compositing quantizes differently than paint alpha, so
  the byte-for-byte parity gate would have to become approximate to accommodate it —
  weakening the exact property that makes §13.3 trustworthy, for a saving on a thread
  that is off the input path and now paced (§20.2).
- **The ingress items stay declined** per §17, unchanged.

## 21. Shipped: the engine stops building snapshots nobody reads

> Provenance: written and measured in an earlier session on the pre-§20 tree (its
> companion fix, the goldens-as-task-inputs change, landed separately as
> `d0440d3d`), then found uncommitted in the primary checkout and landed after §20.
> The A/B tables below are that session's measurements; the landing run re-verified
> the suites and re-ran the device benchmarks on the current tree (see the closing
> note).

Two changes in the SHARED JS (`server/PartyCore.js`, `server/Game.js`), so both TVs get
them and web is unaffected in either direction. Neither touches a bridge, a shim or a
renderer. §5 through §19 had squeezed the boundary and the draw; this is the first
session to find that the JS side was doing work that was thrown away.

### 21.1 `deliverFrame` no longer deep-copies a frame it discards

§6 flagged this and it was still open. `deliverFrame` called `frame()`, which value-copies
every seat through `copyPlayer`, then computed the scene signature and dropped the whole
copy when the frame was render-identical to the last delivered one. §10 measured that as
668 of 900 frames at eight seats, so roughly three quarters of the copies were pure waste.

`sceneSig` and `toCommands` read only scalars (`alive`, `lines`, `level`,
`pendingGarbage`, `gridVersion`, `holdPiece`, and the current piece's anchor plus
`cells[0]`). Neither touches `grid`. That is already established, and is why `toCommands`
is documented as pure and the web hands it its zero-copy live snapshot. So `deliverFrame`
now runs both on the live refs from `game.getSnapshot()` and copies only on a frame it
actually delivers. On the delivered ones it consults the grid ledger BEFORE copying rather
than after, the same order fix `deliverSnapshotPlayerPacked` already carried, so a seat
whose `gridVersion` has not moved never duplicates 135 cells for `_stripUnchangedGrids` to
delete a moment later.

`frame()` keeps its old contract for the gallery, the tests and the goldens; the clock
advance and event drain both paths share moved into `_advance`.

### 21.2 A per-seat pull touches one seat

`PartyCore.snapshotPlayer` called `game.getSnapshot()`, which runs `board.getState()` for
every board (ghost solve, visible-grid slice, block arrays), then picked one player out of
the result and discarded the other seven. `Game.getPlayerState(id)` is that loop body
extracted; `getSnapshot` now calls it per board, so there is still one implementation.

### Measured, same device and harness, before and after in the same session

`BrainPerfTest`, p50, eleven minutes apart on a warm Google TV Streamer:

| | 2 seats | 4 seats | 8 seats |
| --- | --- | --- | --- |
| `bridge.frame(now, batch)` before | 1830 us | 2157 | 3697 |
| **after** | **1141** | **1131** | **1593** |
| | -38% | -48% | **-57%** |
| `bridge.snapshotPlayer(id, batch)` before | 1612 us | 1356 | 1147 |
| **after** | **1308** | **908** | **839** |

`whereTheSeatPullTimeGoes`, the JS-only split at eight seats (includes the ~78 us Zipline
floor):

| stage | before | after |
| --- | --- | --- |
| `js: game.getSnapshot()` [live refs] | 426 us | 388 |
| `js: snapshotPlayer()` [copyPlayer] | 665 | **291** |
| `js: + strip + pack` | 662 | **310** |
| `js: payload crosses to Kotlin` | 700 | **334** |

The telling row is the last one across seat counts: **334.0 us at two seats and 334.3 us
at eight**, where before it scaled 381 -> 700. A per-seat pull that does not grow with room
size is the whole point of the call, and it now does not. `snapshotPlayer` is also cheaper
than `getSnapshot` now, which is the direct proof: it used to be `getSnapshot` plus a copy.

The `getSnapshot` row moving 426 -> 388 is noise, and is the check that mattered for web:
routing it through `getPlayerState` adds a `Map.get` per board per frame on the one
platform with no boundary, and that cost nothing measurable.

### End to end

`InputLatencyTest`, against §19's table. Cross-session, so read it as corroboration and
the component A/B above as the evidence:

| case | §19 p50 / p95 / p99 | now |
| --- | --- | --- |
| 1 seat | 2.22 / 3.81 / 5.57 ms | 1.83 / 3.94 / 4.28 |
| 2 seats | 2.72 / 5.42 / 6.43 | 2.17 / 4.61 / 6.51 |
| 4 seats | 2.45 / 4.68 / 6.06 | 2.38-2.47 / 4.78-5.10 / 5.33-6.04 |
| 4, 3 busy | 2.64 / 7.55 / 18.73 | 1.90 / 9.23 / 17.29 |
| 8 seats | 2.58 / 5.22 / 8.73 | **1.78-1.91 / 3.92-4.51 / 5.19-5.84** |
| 8, 7 busy | 2.78 / 13.69 / 25.43 | 1.78 / **7.11** / 25.20 |

The 4-seat standalone row read 3.48 because it runs FIRST in the suite and pays the JIT;
the alternating A/B passes are the honest ones, exactly as §16a warns. The legacy shape,
still in the suite as a control, improved by the same shape (8-seat p50 4.71/4.49 in §16a
against 2.64/2.61 now), which is what a shared-engine change should do to both shapes.

**The 8-busy p95 halved, 13.69 -> 7.11 ms.** §19 closed by saying the all-busy tail "has
never responded to any change made in this document". It responds to this one: the tick is
2.1 ms cheaper at eight seats, so the game thread stops being the thing an input queues
behind. The p99 (25.20 against 25.43) did not move and remains the open number.

### Correctness

622 JS tests, 83 Kotlin `:core` tests and 34 Playwright E2E specs, all unchanged and all
passing, including `FrameGoldenConformanceTest`, `PackedFrameTest` (the cross-port packed
golden), `RenderMathParityTest` and `tests/partycore-packed.test.js`, which round-trips
every delivered frame of a 1200-frame corpus at 1/2/8 seats. No fixture was regenerated:
the output is byte-identical, which is the claim, since `copyPlayer`'s `skipGrid` leaves
the field ABSENT exactly as `_stripUnchangedGrids` did.

### Re-verified at landing, on the post-§20 tree

Same device, same day as §20's run, so directly comparable to that morning's numbers
rather than across sessions: `bridge.frame(now, batch)` at 8 seats went **3.56 -> 1.39 ms
p50** (-61%; 2 seats 1.45 -> 1.05, 4 seats 2.42 -> 1.35), `snapshotPlayer(id, batch)`
2.01/1.04/1.61 -> 1.23/0.92/0.74 at 2/4/8, and the packed seat payload crosses in ~0.33 ms
at BOTH 2 and 8 seats (was 0.42 -> 0.74 scaling). All suites above re-run green on the
landed tree, plus the fresh `:core:jvmTest --rerun-tasks` (84) and the full E2E suite.
End to end, 8 seats now reads 2.71 ms p50 / 4.34 p95 in the same alternating harness.
