import Testing
import Foundation
@testable import HexStackerKit

/// RoomCore conformance: the tvOS leg.
///
/// The SAME op log runs three times against the SAME module — in Node
/// (tests/room-core-conformance.test.js), here in JavaScriptCore, and in QuickJS
/// on Android TV — and every step's return value and resulting snapshot must match
/// tests/fixtures/room-core-golden.json exactly.
///
/// Because all three legs run the same JavaScript, this is no longer asking "did
/// someone re-implement the room layer wrong". It asks "does the BRIDGE marshal
/// correctly": arguments in (including a raw HELLO object, a sparse AirConsole-style
/// peer index, a null, and a name carrying control characters and a zero-width
/// joiner), values out, exception discipline, and the retained snapshot. That is a
/// far smaller surface, and the same shape as the engine's FrameGoldenConformance
/// gate next door.
///
/// The op log deliberately covers peer_joined-before-hello, colour collisions,
/// auto-naming with a blocklisted preference (the tvOS auto-namer used to have no
/// blocklist at all, so an Apple TV really could seat HX-4 and HX-13), the three
/// pause flags, suspend-and-rejoin via a cross-device claim, batched liveness
/// ticks, late-joiner grace, results enrichment, a full room rejecting one more, and
/// a peer the liveness sweep expired keeping its seat because the relay still holds it.
@Suite struct RoomCoreConformanceTests {

    private struct Golden {
        let initJSON: String
        let ops: [[String: Any]]
        let steps: [[String: Any]]
    }

    private func loadGolden() throws -> Golden {
        let data = try Data(contentsOf: EngineFixture.roomCoreGolden)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let options = root["init"],
              let ops = root["ops"] as? [[String: Any]],
              let steps = root["steps"] as? [[String: Any]] else {
            throw EngineBridge.EngineError.decode("room-core-golden.json is not the expected shape")
        }
        return Golden(initJSON: try jsonText(options), ops: ops, steps: steps)
    }

    private func jsonText(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        guard let text = String(data: data, encoding: .utf8) else {
            throw EngineBridge.EngineError.decode("could not encode a golden value")
        }
        return text
    }

    /// Parse a bridge reply back into a Foundation tree so the comparison is
    /// STRUCTURAL. A textual diff would fail on key order and number formatting,
    /// neither of which the contract says anything about.
    private func parsed(_ json: String) throws -> Any {
        guard let data = json.data(using: .utf8) else {
            throw EngineBridge.EngineError.decode("bridge reply is not utf8: \(json)")
        }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private func matches(_ actual: Any, _ expected: Any) -> Bool {
        (actual as AnyObject).isEqual(expected as AnyObject)
    }

    @Test func replayingTheOpLogReproducesTheGoldenStepForStep() throws {
        let golden = try loadGolden()
        #expect(golden.ops.count == golden.steps.count, "the golden's op log and step log disagree")

        let bridge = try EngineBridge(engineDirectory: EngineFixture.coreBundleDir)
        // The room core is SESSION-lived: constructed once here, exactly as the
        // coordinator constructs it once at start() and keeps it across matches.
        try bridge.roomInit(optionsJSON: golden.initJSON)

        for (i, op) in golden.ops.enumerated() {
            let expected = golden.steps[i]
            let label: String
            let reply: String
            if let property = op["g"] as? String {
                label = "step \(i) (get \(property))"
                reply = try bridge.roomGetJSON(property)
            } else {
                guard let method = op["m"] as? String else {
                    Issue.record("step \(i) has neither `g` nor `m`")
                    return
                }
                label = "step \(i) (\(method))"
                reply = try bridge.roomCallJSON(method, try jsonText(op["a"] ?? []))
            }

            let expectedResult = expected["result"] ?? NSNull()
            let resultOK = matches(try parsed(reply), expectedResult)
            let resultText = try jsonText(expectedResult)
            #expect(resultOK, "\(label): return value\n  actual:   \(reply)\n  expected: \(resultText)")

            let expectedSnapshot = expected["snapshot"] ?? NSNull()
            let snapshotJSON = try bridge.roomSnapshotJSON()
            let snapshotOK = matches(try parsed(snapshotJSON), expectedSnapshot)
            let snapshotText = try jsonText(expectedSnapshot)
            #expect(snapshotOK, "\(label): snapshot\n  actual:   \(snapshotJSON)\n  expected: \(snapshotText)")
        }
    }

    /// The room core has to be built before it can be used, and the shell's ordering
    /// guarantee (roomInit ahead of transport.connect) is only worth anything if the
    /// bridge actually refuses the un-initialized case instead of silently no-oping.
    @Test func roomCallsBeforeRoomInitThrow() throws {
        let bridge = try EngineBridge(engineDirectory: EngineFixture.coreBundleDir)
        #expect(throws: (any Error).self) { try bridge.roomSnapshotJSON() }
        #expect(throws: (any Error).self) { try bridge.roomGetJSON("state") }
    }

    /// A JS throw must not leak into the NEXT call through the shared exception box
    /// (the bug EngineBridge's drain discipline exists to prevent), and the room core
    /// must still be usable afterwards.
    @Test func aFailedRoomCallDrainsAndLeavesTheBrainUsable() throws {
        let bridge = try EngineBridge(engineDirectory: EngineFixture.coreBundleDir)
        try bridge.roomInit(optionsJSON: "{\"maxPlayers\":8}")
        #expect(throws: (any Error).self) { try bridge.roomCallJSON("noSuchMethod") }
        // The next call succeeds, and the exception did not get re-reported here.
        let snapshot = try bridge.roomSnapshotJSON()
        #expect(snapshot.contains("\"roomState\":\"lobby\""))
    }
}
