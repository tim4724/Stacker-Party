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

    /// The whole app-suspend round trip for a pads-only party (hardware session,
    /// 2026-08-08: two Bluetooth pads, background + return). Pads are LOCAL seats,
    /// so the relay room holds no members but the display — it dies with our
    /// suspended socket, the foreground rejoin bounces off "Room not found" and a
    /// FRESH room replaces it. tvOS also drops the pads from GCController while
    /// suspended, and the first foreground tick can run before they re-attach.
    /// Through all of that the pads must land back on the SAME seats (slot-derived
    /// ids, same names) and the party must be startable with boards on screen.
    @Test func padsReseatIntoTheFreshRoomAfterAnAppSuspend() {
        let (coord, ft, fo, pads) = make()
        pads.readings = [reading(slot: 0), reading(slot: 1, id: "DualSense Wireless Controller")]
        tick(coord)
        let seatsBefore = coord.roster().map(\.peerIndex)
        let namesBefore = coord.roster().map(\.playerName)
        #expect(seatsBefore == [PadSeats.seatId(forSlot: 0), PadSeats.seatId(forSlot: 1)])

        // Backgrounding: P2P channels close, the relay socket suspends (link down),
        // and the sleeping pads vanish from the controller list.
        coord.displayDidEnterBackground()
        coord.setRelayConnected(false)
        pads.readings = []
        tick(coord)

        // Foreground, harsh order: a tick before the pads re-attach, then the
        // relay recovers into a fresh room (the suspended room is gone), then the
        // pads wake back up.
        tick(coord)
        coord.setRelayConnected(true)
        ft.onCreated?("ROOM99", "inst2", "eu")
        pads.readings = [reading(slot: 0), reading(slot: 1, id: "DualSense Wireless Controller")]
        tick(coord)
        #expect(coord.roster().map(\.peerIndex) == seatsBefore, "same pads, same seats — a reconnect, not new players")
        #expect(coord.roster().map(\.playerName) == namesBefore)

        // And the fresh room is a working party: the host pad starts the match,
        // the game screen goes up with both boards behind the countdown.
        pads.readings = [reading(slot: 0, pressed: PadButton.start),
                         reading(slot: 1, id: "DualSense Wireless Controller")]
        tick(coord)
        #expect(coord.state == .countdown)
        #expect(fo.screen == .game)
        #expect(fo.lastSnapshot?.players.count == 2, "both boards render behind the 3-2-1")
        pads.readings = [reading(slot: 0), reading(slot: 1, id: "DualSense Wireless Controller")]
        var ticks = 0
        while coord.state == .countdown && ticks < 600 { tick(coord); ticks += 1 }
        #expect(coord.state == .playing)
    }
}
