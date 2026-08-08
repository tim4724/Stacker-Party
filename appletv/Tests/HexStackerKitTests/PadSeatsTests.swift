import Testing
import Foundation
@testable import HexStackerKit

/// The seat lifecycle `PadSource` injection exists for: a fake pad, no hardware.
/// Everything below drives the coordinator through `tick(deltaMs:)` exactly as
/// the render loop does — the fake only decides what `pads()` reports, the way
/// GameController decides it on a real TV.
@Suite struct PadSeatsTests {

    private final class FakePadSource: PadSource {
        var readings: [PadReading] = []
        var rumbles: [(slot: Int, durationMs: Double)] = []
        func pads() -> [PadReading] { readings }
        func rumble(slot: Int, durationMs: Double, weak: Double, strong: Double) {
            rumbles.append((slot, durationMs))
        }
    }

    private func make() -> (DisplayCoordinator, FakeTransport, FakeOutput, FakePadSource) {
        let ft = FakeTransport()
        let fo = FakeOutput()
        let pads = FakePadSource()
        let coord = DisplayCoordinator(transport: ft, engineDirectory: EngineFixture.coreBundleDir,
                                       output: fo, padSource: pads,
                                       seedProvider: { 0xBADCAFE },
                                       nowProvider: { Date().timeIntervalSince1970 * 1000 })
        coord.start()
        ft.onCreated?("ROOM42", "inst1", "eu")
        return (coord, ft, fo, pads)
    }

    private func reading(slot: Int = 0, id: String = "Xbox Wireless Controller",
                         pressed: Int...) -> PadReading {
        var buttons = [Bool](repeating: false, count: 17)
        for index in pressed { buttons[index] = true }
        return PadReading(slot: slot, id: id, buttons: buttons, axes: [0, 0])
    }

    private func tick(_ coord: DisplayCoordinator, times: Int = 1, deltaMs: Double = 1000.0 / 60.0) {
        for _ in 0..<times { coord.tick(deltaMs: deltaMs) }
    }

    @Test func padJoinsByConnectingAndFirstPadIsHost() {
        let (coord, _, _, pads) = make()
        pads.readings = [reading()]
        tick(coord)
        let rows = coord.roster()
        #expect(rows.map(\.peerIndex) == [PadSeats.seatId(forSlot: 0)])
        #expect(rows.first?.playerName == "Xbox")
        #expect(coord.hostPeerIndex == PadSeats.seatId(forSlot: 0))
        #expect(coord.hasPadSeats)
    }

    @Test func unplugInLobbyDropsTheRow() {
        let (coord, _, _, pads) = make()
        pads.readings = [reading()]
        tick(coord)
        pads.readings = []
        tick(coord)
        #expect(coord.roster().isEmpty)
        #expect(!coord.hasPadSeats)
    }

    @Test func lobbyStartButtonIsHostGated() {
        let (coord, _, _, pads) = make()
        pads.readings = [reading(slot: 0), reading(slot: 1, id: "DualSense Wireless Controller")]
        tick(coord)   // both seated; slot 0 joined first -> host
        // The second pad's Start must not begin the round.
        pads.readings = [reading(slot: 0), reading(slot: 1, id: "DualSense Wireless Controller", pressed: PadButton.start)]
        tick(coord)
        #expect(coord.state == .lobby)
        pads.readings = [reading(slot: 0), reading(slot: 1, id: "DualSense Wireless Controller")]
        tick(coord)
        // The host pad's Start does — the same binding the web and Android give it.
        pads.readings = [reading(slot: 0, pressed: PadButton.start), reading(slot: 1, id: "DualSense Wireless Controller")]
        tick(coord)
        #expect(coord.state == .countdown)
    }

    @Test func startPausesTheCountdownAndTheGame() {
        let (coord, _, fo, pads) = make()
        pads.readings = [reading()]
        tick(coord)
        pads.readings = [reading(pressed: PadButton.start)]
        tick(coord)
        #expect(coord.state == .countdown)
        // Release, then press again mid-countdown: the pause the Android freeze
        // bug (hardware session, 2026-08-07) never delivered.
        pads.readings = [reading()]
        tick(coord)
        pads.readings = [reading(pressed: PadButton.start)]
        tick(coord)
        #expect(fo.paused)
    }

    @Test func unplugMidGameHoldsTheRowForResume() {
        let (coord, _, _, pads) = make()
        pads.readings = [reading()]
        tick(coord)
        pads.readings = [reading(pressed: PadButton.start)]
        tick(coord)
        var ticks = 0
        while coord.state == .countdown && ticks < 600 { tick(coord); ticks += 1 }
        #expect(coord.state == .playing)
        pads.readings = []
        tick(coord)
        // Same as a phone closing its tab mid-game: the row is held, disconnected,
        // so replugging the pad (or a phone scanning the rejoin QR) resumes it.
        #expect(coord.roster().map(\.peerIndex) == [PadSeats.seatId(forSlot: 0)])
        #expect(coord.roster().first?.connected == false)
    }

    @Test func sessionResetReleasesTheSeat() {
        let (coord, ft, _, pads) = make()
        pads.readings = [reading()]
        tick(coord)
        // A replacement room while one is held (the relay tore the old one down)
        // resets the session and clears the roster under the still-plugged pad.
        ft.onCreated?("ROOM99", "inst1", "eu")
        #expect(coord.roster().isEmpty)
        // The seat sweep runs at 1Hz on the pad clock — within a second the pad
        // gives the dead seat up and joins the new room as a fresh row.
        tick(coord, times: 2, deltaMs: 600)
        #expect(coord.roster().map(\.peerIndex) == [PadSeats.seatId(forSlot: 0)])
        #expect(coord.roster().first?.playerName == "Xbox")
    }
}
