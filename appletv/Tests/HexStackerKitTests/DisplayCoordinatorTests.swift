import Testing
import Foundation
@testable import HexStackerKit

/// Drives the display through the SAME entry points the tvOS UI, the Siri Remote
/// and real controllers use — `remoteStartMatch()` / `remotePlayPause()` and the
/// inbound relay messages — with a fake transport feeding peer joins / messages and
/// a fake output recording screen + countdown + pause side-effects. The countdown
/// is frame-time driven, so `tick(deltaMs:)` advances it deterministically.
///
/// Room assertions read the retained snapshot (`FakeTransport.states`), because the
/// snapshot IS the protocol now: it is the only thing the display tells controllers
/// about the room, and it is built by the shared RoomBrain rather than here. The
/// room LOGIC is pinned by RoomBrainConformanceTests; what these tests own is the
/// shell — which brain call each relay event maps to, and what the shell does with
/// the answer.
@Suite struct DisplayCoordinatorTests {

    /// A started coordinator showing a lobby with `players` synthetic controllers
    /// joined (each having sent `hello`). Returns the pieces a test asserts on.
    private func makeLobby(players: Int) -> (DisplayCoordinator, FakeTransport, FakeOutput) {
        makeLobby(players: players, clock: nil)
    }

    /// A controllable wall clock so liveness/grace/throttle timing is deterministic.
    private final class Clock { var ms: Double = 0 }

    private func makeLobby(players: Int, clock: Clock?) -> (DisplayCoordinator, FakeTransport, FakeOutput) {
        let ft = FakeTransport()
        let fo = FakeOutput()
        let coord = DisplayCoordinator(transport: ft, engineDirectory: EngineFixture.coreBundleDir,
                                       output: fo, seedProvider: { 0xBADCAFE },
                                       nowProvider: clock.map { c in { c.ms } }
                                           ?? { Date().timeIntervalSince1970 * 1000 })
        coord.start()
        ft.onCreated?("ROOM42", "inst1", "eu")
        if players > 0 {
            // Deliberately NOT "P1": P1-P8 are the legacy slot names the brain
            // resolves away to room-unique HX names (see legacyNameResolvesToAnAutoName).
            for i in 1...players {
                ft.onPeerJoined?(i)
                ft.onMessage?(i, ["type": "hello", "name": "Pl\(i)"])
            }
        }
        return (coord, ft, fo)
    }

    /// Run the 3-2-1-GO countdown to completion (or fail the guard).
    private func runCountdown(_ coord: DisplayCoordinator) {
        var ticks = 0
        while coord.state == .countdown && ticks < 600 { coord.tick(deltaMs: 1000.0 / 60.0); ticks += 1 }
    }

    /// Single player: spam hard_drop until the board tops out and the match ends.
    private func runToResults(_ coord: DisplayCoordinator, _ ft: FakeTransport) {
        var ticks = 0
        while coord.state == .playing && ticks < 8000 {
            ft.onMessage?(1, ["type": "input", "action": "hard_drop"])
            coord.tick(deltaMs: 1000.0 / 60.0); ticks += 1
        }
    }

    // MARK: - The retained room snapshot IS the protocol

    /// Ten message types were retired when the snapshot became the controllers'
    /// single source of truth. A display that still sends any of them is talking to
    /// a controller that stopped listening, so this walks a whole session — join,
    /// countdown, play, KO, pause/resume, mute, results, play again, return to
    /// lobby — and asserts none of them appear on the wire.
    @Test func retiredMessageTypesAreNeverSent() {
        let retired: Set<String> = [
            "welcome", "lobby_update", "game_start", "countdown", "game_end",
            "game_over", "game_paused", "game_resumed", "return_to_lobby", "display_muted",
        ]
        let (coord, ft, _) = makeLobby(players: 2)
        coord.remoteStartMatch(); runCountdown(coord)
        ft.onMessage?(1, ["type": "pause_game"])
        ft.onMessage?(1, ["type": "resume_game"])
        ft.onMessage?(1, ["type": "set_display_mute", "muted": true])
        var ticks = 0
        while coord.state == .playing && ticks < 12000 {
            ft.onMessage?(1, ["type": "input", "action": "hard_drop"])
            ft.onMessage?(2, ["type": "input", "action": "hard_drop"])
            coord.tick(deltaMs: 1000.0 / 60.0); ticks += 1
        }
        #expect(coord.state == .results)
        ft.onMessage?(1, ["type": "play_again"])
        runCountdown(coord)
        coord.remoteReturnToLobby()

        let types = Set((ft.sent.map { $0.data } + ft.broadcasts).compactMap { $0["type"] as? String })
        #expect(types.intersection(retired).isEmpty,
                "these retired types are still being sent: \(types.intersection(retired).sorted())")
        // ...and what SURVIVES is still sent: the targeted player_state is what fires
        // a controller's KO overlay the instant it happens.
        #expect(types.contains(MSG.playerState))
    }

    /// Every room change publishes ONE retained `set_state` snapshot; the relay pushes
    /// it live and replays it to any (re)joining controller, so a briefly-dropped
    /// phone catches up without a round trip. The brain decides which changes take
    /// the throttled path; the shell only owns the timer.
    @Test func roomChangesPublishOneRetainedSnapshot() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 2, clock: clock)

        #expect(!ft.states.isEmpty, "joins publish a retained room snapshot")
        #expect(!ft.didSend("lobby_update", to: 1), "no per-player fanout survives")

        clock.ms += 1000
        coord.tick(deltaMs: 16)   // flush any trailing publish
        let snap = ft.states.last!
        #expect(snap["roomState"] as? String == "lobby")
        #expect(snap["hostPeerIndex"] as? Int == coord.hostPeerIndex)
        #expect(snap["paused"] as? Bool == false)
        #expect(snap["displayMuted"] as? Bool == false)
        #expect(snap["participants"] as? [Int] == [1, 2], "everyone in the lobby is a participant")
        let roster = snap["players"] as? [String: Any]
        #expect(roster?.count == 2)
        let p1 = roster?["1"] as? [String: Any]
        #expect(p1?["name"] as? String == "Pl1")
        #expect(p1?["color"] as? Int == coord.player(1)?.colorSlot)
        #expect(p1?["startLevel"] as? Int == 1)
        #expect(p1?["alive"] as? Bool == true)
        #expect(p1?["helloSeen"] as? Bool == true, "their HELLO landed, so their own controller may render")
    }

    /// The colour rose and the +/- stepper are finger-speed controls where only the
    /// final value matters, so the brain hints 'soon' and the shell collapses the
    /// burst into one leading + one trailing publish that reads live state at fire time.
    @Test func levelAndColourPublishesAreThrottledLeadingAndTrailing() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 2, clock: clock)

        ft.states.removeAll()
        clock.ms += 1000
        ft.onMessage?(1, ["type": MSG.setColor, "colorIndex": 6])   // leading edge
        ft.onMessage?(2, ["type": MSG.setColor, "colorIndex": 7])   // collapses
        #expect(ft.states.count == 1, "the second change inside the window is deferred")
        coord.tick(deltaMs: 16)
        #expect(ft.states.count == 1, "still inside the throttle window")
        clock.ms += coord.snapshotThrottleMs
        coord.tick(deltaMs: 16)                                      // trailing edge
        #expect(ft.states.count == 2)
        let after = ft.states.last?["players"] as? [String: Any]
        #expect((after?["2"] as? [String: Any])?["color"] as? Int == 7, "trailing publish carries live state")

        // startLevel rides the roster too — it was the last per-recipient holdout,
        // and moving it here is what let LOBBY_UPDATE be deleted rather than shrunk.
        ft.states.removeAll()
        clock.ms += 1000
        ft.onMessage?(1, ["type": MSG.setLevel, "level": 7])
        let levels = ft.states.last?["players"] as? [String: Any]
        #expect((levels?["1"] as? [String: Any])?["startLevel"] as? Int == 7)
    }

    /// A room-state transition is the thing controllers route their screens off, so
    /// it publishes immediately, ahead of the level/colour throttle. This is what let
    /// the GAME_START / COUNTDOWN / GAME_END / RETURN_TO_LOBBY broadcasts go.
    @Test func everyTransitionPublishesImmediately() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 1, clock: clock)
        ft.states.removeAll()

        coord.remoteStartMatch()
        #expect(ft.states.last?["roomState"] as? String == "countdown", "same instant, no throttle wait")
        runCountdown(coord)
        #expect(ft.states.last?["roomState"] as? String == "playing")
        runToResults(coord, ft)
        #expect(ft.states.last?["roomState"] as? String == "results")
        coord.remoteReturnToLobby()
        #expect(ft.states.last?["roomState"] as? String == "lobby")
    }

    /// When the LAST lobby player leaves there is nobody to fan out to, but the
    /// retained snapshot must stop naming the departed player to the next joiner.
    @Test func lastLobbyLeaverPublishesTheEmptyRoster() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 1, clock: clock)
        clock.ms += 1000
        ft.states.removeAll()

        ft.onPeerLeft?(1)
        coord.tick(deltaMs: 16)   // flush any trailing publish
        let snap = ft.states.last
        #expect(snap != nil, "the empty roster is published")
        #expect((snap?["players"] as? [String: Any])?.isEmpty == true)
        #expect(snap?["hostPeerIndex"] is NSNull, "no host left")
    }

    /// The relay hands us `peer_joined` before the joiner's HELLO. The row is claimed
    /// straight away (it holds a palette slot the other pickers must see) but flagged
    /// helloSeen:false, so the joiner's OWN controller waits instead of rendering a
    /// guessed identity and visibly correcting itself a round trip later.
    @Test func peerJoinedBeforeHelloPublishesAPlaceholderRow() {
        let (coord, ft, _) = makeLobby(players: 0)
        ft.onPeerJoined?(1)
        let placeholder = (ft.states.last?["players"] as? [String: Any])?["1"] as? [String: Any]
        #expect(placeholder?["helloSeen"] as? Bool == false)
        #expect((placeholder?["name"] as? String)?.hasPrefix("HX-") == true, "a placeholder auto-name")

        ft.onMessage?(1, ["type": "hello", "name": "Ann", "colorIndex": 3])
        let settled = (ft.states.last?["players"] as? [String: Any])?["1"] as? [String: Any]
        #expect(settled?["helloSeen"] as? Bool == true)
        #expect(settled?["name"] as? String == "Ann")
        #expect(settled?["color"] as? Int == 3, "the preferred colour is honoured at HELLO time")
        #expect(coord.playerCount == 1, "one row, claimed once")
    }

    /// P1-P8 was the pre-HX slot naming, and a controller still sending one means
    /// "give me a default", not "call me P3". The blocklisted numbers (4/13/17/69)
    /// are the reason this can't be re-implemented per platform: tvOS used to name
    /// players "HX-(slot + 1)" with no blocklist at all.
    @Test func legacyNameResolvesToAnAutoName() {
        let (coord, ft, _) = makeLobby(players: 0)
        ft.onPeerJoined?(1)
        ft.onMessage?(1, ["type": "hello", "name": "P3"])
        let name = coord.player(1)?.playerName ?? ""
        #expect(name != "P3")
        #expect(name.hasPrefix("HX-"))
        #expect(!["HX-4", "HX-13", "HX-17", "HX-69"].contains(name))
    }

    // MARK: - Render-on-input

    // A controller input renders the applied state on the spot, without waiting for the
    // next tick(); a non-input message must NOT render.
    @Test func inputRendersImmediatelyWithoutWaitingForTick() {
        let (coord, ft, fo) = makeLobby(players: 2)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        let beforeInput = fo.renderCount
        ft.onMessage?(1, ["type": "input", "action": "left"]) // no tick() in between
        #expect(fo.renderCount > beforeInput, "input renders immediately (render-on-input)")

        let afterInput = fo.renderCount
        ft.onMessage?(1, ["type": "ping"])
        #expect(fo.renderCount == afterInput, "a non-input message does not render")
    }

    // MARK: - All-disconnected auto-pause / auto-resume (silent)

    @Test func allParticipantsGoneSilentlyAutoPausesAndAutoResumes() {
        let clock = Clock()
        let (coord, ft, fo) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        // Both controllers go silent past the liveness window → silent auto-pause.
        clock.ms = 10_000
        coord.tick(deltaMs: 16)
        #expect(coord.allParticipantsDisconnected)
        #expect(fo.paused == false, "auto-pause is silent: no pause overlay")
        #expect(ft.states.last?["paused"] as? Bool == false,
                "and it never reaches controllers — their Continue could not work")
        let frozen = fo.renderCount
        coord.tick(deltaMs: 16); coord.tick(deltaMs: 16)
        #expect(fo.renderCount == frozen, "engine does not advance while auto-paused")

        // A controller message returns → auto-resume, sim advances again.
        ft.onMessage?(1, ["type": "input", "action": "left"])
        #expect(!coord.allParticipantsDisconnected)
        coord.tick(deltaMs: 16)
        #expect(fo.renderCount > frozen, "auto-resumed: engine advancing again")
    }

    @Test func manualPauseThenAllDisconnectHidesStrandedOverlay() {
        let clock = Clock()
        let (coord, ft, fo) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        // Host manually pauses while the players are still connected: overlay up, and
        // the snapshot reports it (this is the only pause a controller can act on).
        ft.onMessage?(1, ["type": "pause_game"])
        #expect(fo.paused == true, "manual pause shows the overlay")
        #expect(ft.states.last?["paused"] as? Bool == true)
        // One frame, so the batched "heard from" stamps land at the CURRENT clock:
        // the brain's tick(nowMs, seen) applies a whole frame's arrivals at one time,
        // which is why the silence below has to start from a drained sweep.
        coord.tick(deltaMs: 16)

        // Both controllers then go silent past the liveness window. The manual
        // pause converts into a silent auto-pause: the stranded overlay hides
        // (Continue is gated shut while everyone is gone, so a shown overlay
        // could never be dismissed), but the sim stays frozen.
        clock.ms = 10_000
        coord.tick(deltaMs: 16)
        #expect(coord.allParticipantsDisconnected)
        #expect(fo.paused == false, "overlay hides when the last player drops during a manual pause")
        #expect(ft.states.last?["paused"] as? Bool == false,
                "returning players must not be handed a pause the display would ignore")
        let frozen = fo.renderCount
        coord.tick(deltaMs: 16); coord.tick(deltaMs: 16)
        #expect(fo.renderCount == frozen, "game stays paused (engine frozen) while everyone is gone")

        // A controller message returns → auto-resume, sim advances again.
        ft.onMessage?(1, ["type": "input", "action": "left"])
        #expect(!coord.allParticipantsDisconnected)
        coord.tick(deltaMs: 16)
        #expect(fo.renderCount > frozen, "auto-resumed: engine advancing again")
    }

    // MARK: - Cross-device mid-game rejoin (?claim=)

    @Test func claimRejoinReclaimsDroppedBoard() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        // Player 1 drops mid-game: slot kept, marked disconnected.
        ft.onPeerLeft?(1)
        #expect(coord.isDisconnected(1) && coord.player(1) != nil)

        // Returns under a NEW peer index carrying ?claim=1 — sent as a rejoinToken
        // STRING, the way the controller reads it out of the query param.
        ft.onMessage?(9, ["type": "hello", "rejoinToken": "1"])
        #expect(coord.player(1) == nil, "the dropped slot was re-keyed away")
        #expect(coord.player(9) != nil, "the returning peer now holds the slot")
        #expect(!coord.isDisconnected(9))
        #expect(coord.participants.contains(9), "and holds the board, not a late-joiner seat")
        #expect(ft.states.last?["participants"] as? [Int] == coord.participants)
    }

    /// A forged claim from a peer that already owns a board must be rejected:
    /// rekeying the dropped board onto the attacker's own id would silently
    /// drop one of the two boards in the engine's Map rebuild and duplicate
    /// the id in playerIds (Game.rekeyPlayer refuses it too, defense in depth).
    @Test func activeParticipantCannotClaimAnotherBoard() {
        let clock = Clock()
        let (coord, ft, fo) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        // Player 2 drops mid-game: slot kept, marked disconnected.
        ft.onPeerLeft?(2)
        #expect(coord.isDisconnected(2) && coord.player(2) != nil)

        // Player 1 (active, owns a board) re-sends HELLO with a forged claim on 2.
        ft.onMessage?(1, ["type": "hello", "rejoinToken": 2])
        #expect(coord.player(2) != nil, "the dropped slot is untouched")
        #expect(coord.isDisconnected(2), "still claimable by its real owner")
        #expect(coord.player(1) != nil, "the sender keeps its own slot")

        // Both boards survive under their own ids in the engine snapshot.
        coord.tick(deltaMs: 16)
        #expect(fo.lastSnapshot?.players.map(\.id).sorted() == [1, 2],
                "both boards intact under their own ids")
    }

    // MARK: - A KO'd player stays dead across a reconnect

    /// GAME_OVER is retired: the snapshot's per-player `alive` carries the KO, and it
    /// has to survive a reconnect or the eliminated phone flips back to the live
    /// playing UI (the web's lastAliveState, now the brain's).
    @Test func koedPlayerStaysDeadInTheSnapshotAcrossAReconnect() {
        let clock = Clock()
        // Three players: KO'ing one still leaves two alive, so the match keeps
        // running (a 2-player KO would end the game and go to results).
        let (coord, ft, _) = makeLobby(players: 3, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        // KO only player 1 (spam hard_drop); players 2 & 3 stay idle+alive.
        var ticks = 0
        func aliveInSnapshot(_ id: Int) -> Bool? {
            ((ft.states.last?["players"] as? [String: Any])?[String(id)] as? [String: Any])?["alive"] as? Bool
        }
        while aliveInSnapshot(1) != false && ticks < 8000 {
            ft.onMessage?(1, ["type": "input", "action": "hard_drop"])
            coord.tick(deltaMs: 1000.0 / 60.0); ticks += 1
        }
        #expect(aliveInSnapshot(1) == false, "player 1 topped out and the snapshot says so")
        #expect(coord.state == .playing, "two players still alive → match continues")
        #expect(ft.didSend(MSG.playerState, to: 1), "the targeted KO message still fires the overlay")

        // Player 1 drops and reconnects on the same slot.
        ft.onPeerLeft?(1)
        ft.onMessage?(1, ["type": "hello"])
        #expect(aliveInSnapshot(1) == false,
                "a reconnecting KO'd player must still read alive:false, not be flipped back to playing")
        #expect(aliveInSnapshot(2) == true)
    }

    // MARK: - Results replayed to a controller landing on the RESULTS screen

    /// The relay replays the retained snapshot to a controller that (re)joins on the
    /// results screen, so the ranking has to ride IN it — that is what the retired
    /// WELCOME `results` replay did. It is enriched by the brain: engine rows get the
    /// roster's name and colour, and the players who sat the round out are appended
    /// flagged newPlayer instead of silently dropped.
    @Test func resultsSnapshotCarriesTheEnrichedRanking() {
        let (coord, ft, _) = makeLobby(players: 1)
        coord.remoteStartMatch(); runCountdown(coord)
        // A late joiner sits the round out: the engine's ranking has no row for them.
        ft.onPeerJoined?(2); ft.onMessage?(2, ["type": "hello", "name": "Late"])
        runToResults(coord, ft)
        #expect(coord.state == .results)

        let snap = ft.states.last
        #expect(snap?["roomState"] as? String == "results")
        let results = snap?["results"] as? [[String: Any]]
        #expect(results != nil, "the ranking rides the snapshot so a rejoining phone isn't left blank")
        #expect(results?.contains { $0["playerId"] as? Int == 1 && $0["playerName"] as? String == "Pl1" } == true,
                "enriched with the roster's name")
        #expect(results?.contains { $0["playerId"] as? Int == 2 && $0["newPlayer"] as? Bool == true } == true,
                "the player who sat out is flagged rather than dropped")
    }

    // MARK: - Fatal relay error opens a fresh room (web resetToWelcome)

    @Test func fatalRelayErrorRecreatesRoomAndResets() {
        let (coord, ft, _) = makeLobby(players: 2)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        ft.onRelayError?("Room not found")
        #expect(coord.state == .lobby, "a lost room resets the display to the lobby")
        #expect(coord.playerCount == 0, "the stale roster is cleared")
        #expect(ft.recreatedRoomCount == 1, "a fresh room is requested")
    }

    @Test func nonFatalRelayErrorIsIgnored() {
        let (coord, ft, _) = makeLobby(players: 1)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)
        ft.onRelayError?("some transient warning")
        #expect(coord.state == .playing, "a non-fatal error does not tear the game down")
        #expect(ft.recreatedRoomCount == 0)
    }

    // MARK: - Display relay reconnect reconciles the roster (web onDisplayRejoined)

    @Test func displayRejoinDropsAbsentLobbyPeer() {
        let (coord, ft, _) = makeLobby(players: 2)
        #expect(coord.playerCount == 2)
        // The display's link blips; on rejoin the relay lists only peer 1.
        ft.onJoined?("ROOM42", [1])
        #expect(coord.playerCount == 1, "the absent lobby peer is removed, not left as a ghost card")
        #expect(coord.player(2) == nil)
    }

    @Test func displayRejoinRaisesRejoinQRForAbsentParticipant() {
        let clock = Clock()
        let (coord, ft, fo) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)
        // On rejoin the relay lists only peer 1; peer 2 is an active participant.
        ft.onJoined?("ROOM42", [1])
        #expect(coord.player(2) != nil && coord.isDisconnected(2), "slot kept, flagged disconnected")
        #expect(fo.rejoinQRVisible.contains(2), "the dropped board surfaces its rejoin QR (no softlock)")
    }

    // MARK: - RESULTS returns to the lobby when every controller leaves

    @Test func resultsReturnsToLobbyWhenAllControllersLeave() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        var ticks = 0
        while coord.state == .playing && ticks < 12000 {
            ft.onMessage?(1, ["type": "input", "action": "hard_drop"])
            ft.onMessage?(2, ["type": "input", "action": "hard_drop"])
            coord.tick(deltaMs: 1000.0 / 60.0); ticks += 1
        }
        #expect(coord.state == .results)
        ft.onPeerLeft?(1)
        #expect(coord.state == .results, "one controller still present")
        ft.onPeerLeft?(2)
        #expect(coord.state == .lobby, "no controllers left on results → back to lobby")
        #expect(ft.states.last?["roomState"] as? String == "lobby",
                "and the snapshot routes the next joiner there too")
    }

    // MARK: - Same-slot in-session reconnect keeps the kept record

    @Test func sameSlotReconnectPreservesRecordAndClearsOverlayOnHello() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        let colorBefore = coord.player(1)?.colorSlot
        ft.onPeerLeft?(1)
        #expect(coord.isDisconnected(1))
        // The relay re-emits peer_joined for the SAME slot on an in-session reconnect.
        ft.onPeerJoined?(1)
        #expect(coord.player(1)?.colorSlot == colorBefore, "kept record's color not clobbered")
        #expect(coord.isDisconnected(1), "still disconnected until the HELLO clears it")
        ft.onMessage?(1, ["type": "hello"])
        #expect(!coord.isDisconnected(1), "HELLO reconnects the kept slot")
    }

    // MARK: - A lone late joiner must not resume an all-participants-gone freeze

    @Test func lateJoinerAloneCannotResumeFrozenMatch() {
        let clock = Clock()
        let (coord, ft, fo) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        // A late joiner connects mid-game (in roster, NOT a participant).
        ft.onPeerJoined?(9); ft.onMessage?(9, ["type": "hello", "name": "Late"])
        #expect(!coord.participants.contains(9), "they wait out the round")
        coord.tick(deltaMs: 16)   // drain the join's liveness stamp at the current clock
        // Everyone goes silent → all flagged disconnected, sim auto-pauses.
        clock.ms = 10_000
        coord.tick(deltaMs: 16)
        #expect(coord.allParticipantsDisconnected)
        #expect(coord.isDisconnected(9))
        let frozen = fo.renderCount
        // Only the late joiner returns. The web's canResumeGame refuses while the
        // active participants are still gone, so the sim must stay frozen.
        ft.onMessage?(9, ["type": "input", "action": "left"])
        coord.tick(deltaMs: 16); coord.tick(deltaMs: 16)
        #expect(fo.renderCount == frozen, "a lone late joiner cannot un-freeze the match")
        #expect(coord.allParticipantsDisconnected)
    }

    // MARK: - Relay-link drop freezes the sim

    /// The link-drop pause lifts on the relay's `joined` reply (roster reconciled),
    /// NOT on raw socket open: at `.open` the relay has not yet re-admitted us to the
    /// room, so a snapshot published there can be dropped server-side and leave
    /// controllers stuck behind their overlay. Mirrors Android
    /// linkResumeWaitsForRoomRejoinNotSocketOpen.
    @Test func relayDropPausesAndRejoinResumes() {
        let clock = Clock()
        let (coord, ft, fo) = makeLobby(players: 1, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        coord.setRelayConnected(false)
        let frozen = fo.renderCount
        coord.tick(deltaMs: 16); coord.tick(deltaMs: 16)
        #expect(fo.renderCount == frozen, "relay-down freezes the simulation")

        // Socket back, handshake still outstanding: stay frozen.
        ft.states.removeAll()
        coord.setRelayConnected(true)
        coord.tick(deltaMs: 16); coord.tick(deltaMs: 16)
        #expect(fo.renderCount == frozen, "socket-open alone must not resume the simulation")
        #expect(ft.states.isEmpty, "nothing is published before we are back in the room")

        // `joined` reconciles the roster: now the sim resumes and controllers are told.
        ft.onJoined?("ROOM42", [1])
        coord.tick(deltaMs: 16)
        #expect(fo.renderCount > frozen, "rejoin resumes the simulation")
    }

    /// The rejoin snapshot is the controller's authority on pause state, so it must
    /// report the state the display will actually be in — not a stale paused=true
    /// chased by a resumed one. A controller that latched the first and missed the
    /// second sat on a pause overlay whose Continue did nothing: the display was no
    /// longer paused, so resumeGame()'s manual-pause guard dropped the request.
    /// (Reported from a live Wi-Fi drop.)
    @Test func rejoinSnapshotReportsResumedNotStalePaused() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 1, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)

        // Link drops: the sim freezes. Nothing is published — the relay is gone.
        coord.setRelayConnected(false)
        coord.tick(deltaMs: 16)
        ft.states.removeAll()

        // Link returns and the relay answers the rejoin.
        coord.setRelayConnected(true)
        ft.onJoined?("ROOM42", [1])

        #expect(ft.states.last != nil, "the rejoin republishes")
        #expect(ft.states.last?["paused"] as? Bool == false,
                "the snapshot must not report the pause the display is lifting in the same breath")
        #expect(ft.states.last?["roomState"] as? String == "playing")
    }

    /// The presence sweep re-arms on the relay's `joined` reply, NOT on socket open.
    /// Until that reply the relay drops everything addressed to us, so no controller
    /// can prove it is alive — sweeping there would flag the whole roster (and, with a
    /// late joiner waiting, grace-return the match) for a fault that is entirely ours.
    @Test func presenceSweepReArmsOnRejoinNotOnSocketOpen() {
        let clock = Clock()
        let (coord, ft, _) = makeLobby(players: 2, clock: clock)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)
        ft.onMessage?(1, ["type": "ping"])
        ft.onMessage?(2, ["type": "ping"])

        // Our socket drops, then comes back — but the relay hasn't answered our join.
        // Push the clock far past the liveness timeout: a re-stamp at socket-open would
        // only have covered the first livenessTimeoutMs of this window.
        coord.setRelayConnected(false)
        clock.ms += 30_000
        coord.setRelayConnected(true)
        coord.tick(deltaMs: 16); coord.tick(deltaMs: 16)
        #expect(!coord.isDisconnected(1), "socket-open alone must not re-arm the sweep")
        #expect(!coord.isDisconnected(2), "socket-open alone must not re-arm the sweep")
        #expect(coord.state == .playing)

        // `joined` reconciles the roster, re-stamping the survivors: sweep back on, clean.
        ft.onJoined?("ROOM42", [1, 2])
        coord.tick(deltaMs: 16)
        #expect(!coord.isDisconnected(1), "re-stamped by the roster reconcile")
        #expect(!coord.isDisconnected(2), "re-stamped by the roster reconcile")

        // ...and it really is live again: silence from here does expire a controller.
        clock.ms += 30_000
        coord.tick(deltaMs: 16)
        #expect(coord.isDisconnected(1), "the sweep is live once we are back in the room")
    }

    // MARK: - The reported bug: START does nothing with no players joined

    @Test func remoteStartIsNoOpWithNoPlayers() {
        let (coord, ft, fo) = makeLobby(players: 0)
        #expect(coord.playerCount == 0)
        coord.remoteStartMatch()
        #expect(coord.state == .lobby, "START must not begin a match with zero players")
        #expect(fo.screen == .lobby, "should stay on the lobby screen")
        #expect(!ft.states.contains { $0["roomState"] as? String == "countdown" })
    }

    @Test func remotePlayPauseIsNoOpWithNoPlayers() {
        let (coord, _, _) = makeLobby(players: 0)
        coord.remotePlayPause()
        #expect(coord.state == .lobby, "Play/Pause must not start a match with zero players")
    }

    // MARK: - START works once a controller has joined

    @Test func remoteStartBeginsCountdownWithOnePlayer() {
        let (coord, _, fo) = makeLobby(players: 1)
        #expect(coord.playerCount == 1)
        coord.remoteStartMatch()
        #expect(coord.state == .countdown, "START with a joined player must begin the countdown")
        #expect(fo.screen == .game, "the game screen shows behind the 3-2-1 overlay")
    }

    @Test func remotePlayPauseStartsFromLobby() {
        let (coord, _, _) = makeLobby(players: 2)
        coord.remotePlayPause()
        #expect(coord.state == .countdown, "Play/Pause in the lobby starts the match")
    }

    @Test func controllerStartGameMatchesRemote() {
        let (coord, ft, _) = makeLobby(players: 1)
        ft.onMessage?(1, ["type": "start_game"])
        #expect(coord.state == .countdown, "a controller's start_game starts the match, like the remote")
    }

    // MARK: - Countdown -> playing, and Play/Pause as the in-game toggle

    @Test func countdownAdvancesToPlaying() {
        let (coord, ft, fo) = makeLobby(players: 1)
        coord.remoteStartMatch()
        runCountdown(coord)
        #expect(coord.state == .playing, "countdown completes -> playing")
        #expect(fo.countdowns.contains(.go), "showed GO")
        // The digits are display-only: controllers learn they are counting down from
        // snapshot.roomState and learn the game is live from the transition.
        #expect(ft.states.last?["roomState"] as? String == "playing")
    }

    @Test func playPauseTogglesDuringPlay() {
        let (coord, _, fo) = makeLobby(players: 1)
        coord.remoteStartMatch()
        runCountdown(coord)
        #expect(coord.state == .playing)
        coord.remotePlayPause()
        #expect(fo.paused, "Play/Pause during play pauses")
        coord.remotePlayPause()
        #expect(!fo.paused, "Play/Pause again resumes")
    }

    @Test func playPausePausesDuringCountdown() {
        let (coord, _, fo) = makeLobby(players: 1)
        coord.remoteStartMatch()
        #expect(coord.state == .countdown)
        coord.remotePlayPause()
        #expect(fo.paused, "Play/Pause during the 3-2-1 pauses (web parity)")
        #expect(coord.state == .countdown, "still in countdown, just frozen")
        coord.remotePlayPause()
        #expect(!fo.paused, "Play/Pause again resumes the countdown")
    }

    // MARK: - Results: Play/Pause = play again

    @Test func playPauseRestartsFromResults() {
        let (coord, ft, _) = makeLobby(players: 1)
        coord.remoteStartMatch()
        runCountdown(coord)
        runToResults(coord, ft)
        #expect(coord.state == .results, "single player tops out -> results")
        coord.remotePlayPause()
        #expect(coord.state == .countdown, "Play/Pause on results plays again")
    }

    // MARK: - Coordinator wires up the WebRTC input fastlane (web parity)

    @Test func fastlaneWiringInterceptsSignalsAndRoutesInput() {
        let ft = FakeTransport()
        let fo = FakeOutput()
        let fl = FakeFastlane()
        let coord = DisplayCoordinator(transport: ft, engineDirectory: EngineFixture.coreBundleDir,
                                       output: fo, fastlane: fl, seedProvider: { 0xBADCAFE })
        coord.start()
        #expect(fl.onInput != nil, "coordinator wires fastlane.onInput")

        ft.onCreated?("ROOM42", "inst1", "eu")
        ft.onPeerJoined?(1)
        ft.onMessage?(1, ["type": "hello", "name": "Alice"])
        #expect(coord.playerCount == 1)

        // An `__rtc` signaling envelope is intercepted by the fastlane and NOT
        // parsed as a controller message (mirrors the web onMessage guard).
        let publishesBefore = ft.states.count
        ft.onMessage?(1, ["__rtc": "offer", "sdp": ["type": "offer"]])
        #expect(fl.signalsHandled.count == 1 && fl.signalsHandled[0].from == 1,
                "relay routes __rtc to fastlane.handleSignal")
        #expect(ft.states.count == publishesBefore,
                "__rtc envelope is consumed, not dispatched as a controller message")

        // Input delivered over the FASTLANE path must reach the engine exactly like
        // relay input (same single handler), driving the match to results.
        ft.onMessage?(1, ["type": "start_game"])
        runCountdown(coord)
        #expect(coord.state == .playing)
        let before = fo.renderCount
        var t = 0
        while coord.state == .playing && t < 8000 {
            fl.onInput?(1, ["type": "input", "action": "hard_drop"])   // via fastlane, not relay
            coord.tick(deltaMs: 1000.0 / 60.0); t += 1
        }
        #expect(fo.renderCount > before, "fastlane-delivered input drives the engine")
        #expect(coord.state == .results, "fastlane input alone tops the player out")

        // A controller leaving closes its P2P channel; backgrounding closes all.
        ft.onPeerLeft?(1)
        #expect(fl.closedPeers.contains(1), "peer_left closes the fastlane peer")
        let broadcastsBefore = ft.broadcasts.count
        coord.displayDidEnterBackground()
        #expect(fl.closeAllCount == 1, "backgrounding tears down all fastlane peers")
        // Backgrounding is recoverable, so it must NOT signal the controllers
        // that the party ended; their reconnect overlay comes from the relay's
        // peer_left when the socket suspends.
        #expect(ft.broadcasts.count == broadcastsBefore, "backgrounding broadcasts nothing")
    }

    // MARK: - `created` surfaces the room code + join URL, hello applies the name

    @Test func createdSurfacesRoomAndJoinURL() {
        let (coord, ft, fo) = makeLobby(players: 1)
        #expect(ft.connected, "transport.connect() called on start")
        #expect(fo.room == "ROOM42", "room code surfaced")
        #expect(fo.joinURL?.contains("ROOM42") == true, "join URL carries the room code")
        #expect(fo.joinURL?.contains("#inst1") == true, "join URL carries the instance")
        #expect(coord.player(1)?.playerName == "Pl1", "hello's custom name applied")
        // The display's own lobby repaints from the same roster the snapshot is
        // built from, including the fields the wire form deliberately omits.
        #expect(fo.lobbyPlayers.map(\.peerIndex) == [1])
        #expect(fo.lobbyPlayers.first?.connected == true)
        #expect(fo.lobbyHost == 1)
    }

    // MARK: - Music starts at GO

    @Test func musicStartsAtGo() {
        let (coord, _, fo) = makeLobby(players: 1)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.state == .playing)
        #expect(fo.musicStarted, "music starts when the countdown hits GO")
    }

    // MARK: - Apple TV remote: music mute toggle returns the new state

    @Test func remoteToggleMuteToggles() {
        let (coord, ft, fo) = makeLobby(players: 1)
        coord.remoteStartMatch(); runCountdown(coord)
        #expect(coord.remoteToggleMute() == true, "first toggle mutes")
        #expect(fo.displayMuted == true, "display switch told about the mute")
        #expect(ft.states.last?["displayMuted"] as? Bool == true,
                "and the host phone's Game Music toggle reads it off the snapshot")
        #expect(coord.remoteToggleMute() == false, "second toggle unmutes")
        #expect(fo.displayMuted == false, "display switch told about the unmute")
        #expect(ft.states.last?["displayMuted"] as? Bool == false)
    }

    // A host phone toggling Game Music (SET_DISPLAY_MUTE) must drive the display
    // UI too, so a visible pause-menu switch updates live instead of showing the
    // state it was built with.
    @Test func hostSetMuteDrivesDisplaySwitch() {
        let (coord, ft, fo) = makeLobby(players: 2)
        ft.onMessage?(1, ["type": "set_display_mute", "muted": true])
        #expect(coord.isMuted, "host mute applied")
        #expect(fo.displayMuted == true, "display switch updated live")
        ft.onMessage?(1, ["type": "set_display_mute", "muted": false])
        #expect(fo.displayMuted == false, "display switch updated live on unmute")
        // Non-host controllers can't mute the shared display.
        ft.onMessage?(2, ["type": "set_display_mute", "muted": true])
        #expect(!coord.isMuted, "a non-host SET_DISPLAY_MUTE is rejected")
    }

    // MARK: - Game over publishes the ranking AFTER clearing the pause menu

    @Test func gameEndPublishesResultsAfterPauseClear() {
        let (coord, ft, fo) = makeLobby(players: 1)
        coord.remoteStartMatch(); runCountdown(coord)
        runToResults(coord, ft)
        #expect(coord.state == .results)
        #expect((fo.results?.count ?? 0) >= 1, "results delivered to the display")
        #expect((ft.states.last?["results"] as? [[String: Any]])?.isEmpty == false,
                "and to controllers, on the snapshot")
        // setPaused(false) clears the focus menu, so it must run BEFORE showResults
        // sets the results buttons — otherwise results Left/Right breaks.
        let rIdx = fo.calls.lastIndex(of: "showResults")
        #expect(rIdx != nil, "showResults called at game end")
        if let p = fo.calls.lastIndex(of: "setPaused(false)"), let r = rIdx {
            #expect(r > p, "results menu set after pause cleared (no menu clobber)")
        }
    }

    // MARK: - A controller's play_again restarts the match from results

    @Test func playAgainMessageRestartsFromResults() {
        let (coord, ft, _) = makeLobby(players: 1)
        coord.remoteStartMatch(); runCountdown(coord)
        runToResults(coord, ft)
        #expect(coord.state == .results)
        ft.onMessage?(1, ["type": "play_again"])
        #expect(coord.state == .countdown, "a controller's play_again starts a new match")
    }

    // MARK: - Screen-gallery shots source the canonical GalleryFixtures data

    /// A bare coordinator (no relay/start) for the frozen HEXSHOT render paths.
    private func makeShotCoordinator() -> (DisplayCoordinator, FakeOutput) {
        let fo = FakeOutput()
        let coord = DisplayCoordinator(transport: FakeTransport(), engineDirectory: EngineFixture.coreBundleDir,
                                       output: fo, seedProvider: { 0xBADCAFE })
        return (coord, fo)
    }

    @Test func lobbyShotUsesJoinAndRosterFixtures() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("lobby", playerCount: 4)
        #expect(fo.screen == .lobby)
        // Clean CTA: the bare host with no fake room code; the QR encodes qrText.
        #expect(fo.joinURL == "https://hexstacker.com", "displayed join URL is the bare JOIN.host")
        #expect(fo.qrText == "https://hexstacker.com", "QR encodes JOIN.qrText")
        // Roster names/colors come from GalleryFixtures.roster(4).
        #expect(coord.roster().map(\.playerName) == ["Emma", "Jake", "Sofia", "Liam"])
        #expect(coord.roster().map(\.colorSlot) == [0, 1, 2, 3])
        // The lobby background is frozen to the shared ambientPieces() fixture.
        #expect(fo.lobbyAmbient?.count == 16, "16 frozen ambient pieces delivered")
        #expect(fo.lobbyAmbient?.allSatisfy { (1...6).contains($0.typeId) && !$0.cells.isEmpty } == true)
    }

    @Test func emptyLobbyShotKeepsJoinFixtureWithNoPlayers() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("lobby-empty", playerCount: 0)
        #expect(fo.screen == .lobby)
        #expect(fo.qrText == "https://hexstacker.com")
        #expect(coord.playerCount == 0, "empty lobby has no roster cards")
        #expect(fo.lobbyAmbient?.count == 16, "the waiting lobby still freezes the ambient background")
    }

    @Test func gameVariantShotRendersCanonicalSnapshot() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("game-8p")   // player count comes from the variant, not HEXPLAYERS
        #expect(fo.screen == .game)
        let snap = fo.lastSnapshot
        #expect(snap?.players.count == 8, "the 8p variant fixes eight boards")
        #expect(snap?.elapsed == 154000, "the match timer shows the fixture elapsed (02:34)")
        #expect(snap?.players.map(\.level) == [3, 9, 12, 1, 5, 8, 2, 12], "mixed tiers from the variant spec")
        #expect(snap?.players[5].alive == false, "the 8p variant KOs board 5")
        #expect(coord.roster().map(\.playerName) == ["Emma", "Jake", "Sofia", "Liam", "Mia", "Noah", "Ava", "Leo"])
    }

    @Test func countdownShotShowsEmptyRosterBoards() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("countdown", playerCount: 4)
        #expect(fo.screen == .game)
        #expect(fo.countdowns.contains(.number(3)), "the 3-2-1 overlay freezes at 3 (web parity)")
        let snap = fo.lastSnapshot
        #expect(snap?.players.count == 4)
        // Pre-game wells: no spawn piece / ghost / hold / next, and an empty grid.
        #expect(snap?.players.allSatisfy { $0.currentPiece == nil && $0.nextPieces.isEmpty } == true)
        #expect(snap?.players.allSatisfy { p in p.grid.allSatisfy { row in row.allSatisfy { $0 == 0 } } } == true,
                "countdown boards are empty wells")
        #expect(snap?.players.map(\.level) == [3, 1, 5, 2], "levels from roster(4)")
    }

    @Test func disconnectedControllerShotRaisesSlotOneClaimQR() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("disconnected-controller")
        #expect(fo.screen == .game)
        #expect(fo.rejoinQRVisible == [1], "only slot 1's per-board rejoin QR is shown")
    }

    @Test func resultsShotUsesResultsFixtureOverFrozenBoards() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("results", playerCount: 4)
        #expect(fo.screen == .results)
        let res = fo.results
        #expect(res?.count == 4)
        #expect(res?.first?.playerName == "Emma")
        #expect(res?.first?.rank == 1)
        #expect(res?.first?.lines == 30, "canonical ranking from results(4)")
    }

    @Test func soloResultsShotHasSingleRow() {
        let (coord, fo) = makeShotCoordinator()
        coord.renderShot("results-solo")
        #expect(fo.screen == .results)
        #expect(fo.results?.count == 1)
        #expect(fo.lastSnapshot?.players.count == 1, "one frozen board behind the solo result")
    }
}
