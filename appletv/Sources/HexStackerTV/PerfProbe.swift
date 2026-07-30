import Foundation
import QuartzCore
import SpriteKit
import UIKit

/// On-device render/input profiling (`HEXPERF=1`), the tvOS counterpart of the
/// Android `HexPerf` instrumentation. The Simulator's GPU numbers aren't
/// representative, so the only place these numbers mean anything is a real
/// Apple TV; read them off `devicectl device process launch --console`.
///
/// Three things are sampled, all on the main thread, all off unless the env var
/// is set (`shared` is nil otherwise, so the call sites compile to a nil check):
///
/// * **dt** — wall time between `SKScene.update` calls, i.e. the frame rate the
///   scene actually achieved, including anything the SwiftUI chrome above it
///   cost. Frames longer than 1.5 vsyncs count as drops.
/// * **work** — the main-thread time OUR per-frame code costs (ambient tick,
///   engine frame through JavaScriptCore, snapshot → SKNode sync). This is the
///   budget a render change moves; `dt` is what the user sees.
/// * **in→frame** — controller packet arrival (the WebRTC data channel hop onto
///   main) to the start of the first frame that can show it. The display-side
///   half of input latency: everything before it is network, everything after
///   is SpriteKit's own present pipeline.
final class PerfProbe {

    /// nil unless HEXPERF is set, so a shipped build carries no sampling at all.
    static let shared: PerfProbe? =
        ProcessInfo.processInfo.environment["HEXPERF"] != nil ? PerfProbe() : nil

    /// Report cadence. Long enough that a report is a few hundred frames, short
    /// enough to watch a state change (lobby → countdown → game) land.
    private static let reportInterval: Double = 2.0

    private var deltas: [Double] = []
    private var works: [Double] = []
    private var inputLatencies: [Double] = []
    /// Arrival of the oldest controller packet not yet carried by a frame. Only
    /// the oldest matters: a burst inside one frame all lands on that frame.
    private var pendingInput: Double?
    private var windowStart = CACurrentMediaTime()
    private var drops = 0
    private var vsyncMs = 1000.0 / 60.0

    /// Set by the shell when a WebRTC fastlane exists; appended to each report.
    var fastlaneSummary: (() -> String)?

    private init() {}

    /// One-shot line describing what we're rendering into — the framebuffer is
    /// the single biggest lever on GPU cost and isn't visible from the source.
    func logEnvironment(sceneSize: CGSize) {
        let screen = UIScreen.main
        vsyncMs = 1000.0 / Double(max(1, screen.maximumFramesPerSecond))
        print("""
        [HEXPERF] bounds=\(Int(screen.bounds.width))x\(Int(screen.bounds.height)) \
        scale=\(screen.scale) nativeScale=\(screen.nativeScale) \
        native=\(Int(screen.nativeBounds.width))x\(Int(screen.nativeBounds.height)) \
        maxFps=\(screen.maximumFramesPerSecond) \
        scene=\(Int(sceneSize.width))x\(Int(sceneSize.height))
        """)
    }

    /// The relay confirmed a room. Logged because a headless device run has no
    /// way to read the on-screen QR, and profiling the LIVE input path needs a
    /// controller in the room.
    func logRoom(_ joinURL: String) {
        print("[HEXPERF] room joinURL=\(joinURL)")
    }

    /// A controller packet just landed on the main thread.
    func inputArrived() {
        if pendingInput == nil { pendingInput = CACurrentMediaTime() }
    }

    /// One scene frame: `deltaMs` since the previous one, and the `frameStart`
    /// stamp taken before any of our per-frame code ran. Called at the END of the
    /// scene's update, so the work time is simply the span since that stamp.
    func frame(deltaMs: Double, frameStart: Double, scene: SKScene) {
        let now = CACurrentMediaTime()
        if deltaMs > 0 {
            deltas.append(deltaMs)
            if deltaMs > vsyncMs * 1.5 { drops += 1 }
        }
        works.append((now - frameStart) * 1000.0)
        if let arrived = pendingInput {
            inputLatencies.append((frameStart - arrived) * 1000.0)
            pendingInput = nil
        }
        let elapsed = now - windowStart
        guard elapsed >= PerfProbe.reportInterval, !deltas.isEmpty else { return }
        report(elapsed: elapsed, scene: scene)
        windowStart = now
        deltas.removeAll(keepingCapacity: true)
        works.removeAll(keepingCapacity: true)
        inputLatencies.removeAll(keepingCapacity: true)
        drops = 0
    }

    private func report(elapsed: Double, scene: SKScene) {
        let fps = Double(deltas.count) / elapsed
        var line = String(format: "[HEXPERF] fps=%.1f frames=%d drops=%d nodes=%d",
                          fps, deltas.count, drops, nodeCount(scene))
        line += "  dt " + summary(deltas)
        line += "  work " + summary(works)
        if !inputLatencies.isEmpty {
            line += "  in→frame " + summary(inputLatencies) + String(format: " n=%d", inputLatencies.count)
        }
        if let fastlane = fastlaneSummary?(), fastlane != "none" { line += "  fastlane " + fastlane }
        print(line)
    }

    private func summary(_ samples: [Double]) -> String {
        guard !samples.isEmpty else { return "-" }
        let sorted = samples.sorted()
        func p(_ q: Double) -> Double {
            sorted[min(sorted.count - 1, max(0, Int((Double(sorted.count) * q).rounded(.down))))]
        }
        return String(format: "p50=%.2f p95=%.2f max=%.2f", p(0.5), p(0.95), sorted[sorted.count - 1])
    }

    /// Walked once per report, not per frame: the whole point is to catch node
    /// growth (leaked effect sprites) without paying for the walk at 60 Hz.
    private func nodeCount(_ node: SKNode) -> Int {
        node.children.reduce(node.children.count) { $0 + nodeCount($1) }
    }
}
