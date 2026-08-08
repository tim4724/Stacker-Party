import Foundation

/// Gamepads attached to the TV itself, as players.
///
/// A pad is not a second kind of player. Every press becomes the SAME message a
/// phone would have sent and goes through the coordinator's inbound path, so
/// joining, auto-naming, colour slots, host election, liveness and pause all keep
/// running their one implementation. What a local seat skips is the relay, which
/// is why its peer index comes from a range the relay will never hand out — see
/// `localSeatBase` below for the range and the packed-frame constraint that makes
/// it a HIGH POSITIVE one. `isLocalSeat` is what guards the `transport.sendTo`
/// call sites.
///
/// The MAPPING is not here. Which button rotates, how fast a held direction
/// repeats and how the stick scales a soft drop all live in `server/PadMapper.js`
/// and cross through `EngineBridge.padPoll`, because the web display, this and
/// Android TV must agree about what a press means. What IS here is the part that
/// needs a shell: which pads exist, which seat each one holds, and where a menu
/// press goes.
///
/// This type deliberately does not import GameController. Reading the hardware is
/// a `PadSource`, injected, so the seat lifecycle and the menu routing below are
/// testable without a controller plugged into the machine.
public protocol PadSource {
    /// Attached pads in STABLE slot order: a pad must keep its slot across polls,
    /// and reclaim it after a replug, or it would be a new player every time.
    func pads() -> [PadReading]
    /// Effects a phone gets as haptics through its own vibrate() call.
    func rumble(slot: Int, durationMs: Double, weak: Double, strong: Double)
}

public struct PadReading {
    public let slot: Int
    /// The product string, cleaned up through the shared rules into a name.
    public let id: String
    /// W3C "standard" mapping order, so one mapper serves every platform.
    public let buttons: [Bool]
    /// `[leftX, leftY]`, y POSITIVE DOWN as the web reports it. The mapper reads
    /// nothing past the left stick, so nothing else is carried.
    public let axes: [Double]

    public init(slot: Int, id: String, buttons: [Bool], axes: [Double]) {
        self.slot = slot
        self.id = id
        self.buttons = buttons
        self.axes = axes
    }
}

/// Button indices this file routes by hand. The rest are the mapper's business
/// and never named here. Kept in sync with `PAD_BTN` in server/PadMapper.js.
enum PadButton {
    static let faceDown = 0
    static let l1 = 4
    static let r1 = 5
    static let l2 = 6
    static let r2 = 7
    static let start = 9
}

public final class PadSeats {
    /// An id the relay will never hand out (it owns slot 0 and gives out 1...MAX).
    /// Mirrors LOCAL_SEAT_BASE in server/PadMapper.js, which owns the definition
    /// and the reason it must be POSITIVE: a player id crosses to us inside
    /// PartyCore's packed frame, where every integer is one UTF-16 code unit, and
    /// a negative one is unencodable — packFrame throws, so the first frame of a
    /// match with a pad seated kills the game. Pinned by
    /// tests/protocol-swift-parity.test.js.
    static let localSeatBase = 900

    /// Derived from the pad's own slot, so unplugging and replugging the same pad
    /// lands back on the same seat: a reconnect, not a new player.
    public static func seatId(forSlot slot: Int) -> Int { localSeatBase + slot }

    /// True for a seat this display owns rather than one the relay handed out.
    /// Every `sendTo` has to ask, because there is nothing on the wire to send to.
    public static func isLocalSeat(_ peerIndex: Int) -> Bool { peerIndex >= localSeatBase }

    private let source: PadSource
    private unowned let coordinator: DisplayCoordinator
    /// slot -> seat id, for pads that have actually joined.
    private var seated: [Int: Int] = [:]
    /// slot -> pad-clock time of a REFUSED join (room full). Because tvOS joins
    /// on connect rather than on a press, a refused pad would otherwise re-send
    /// HELLO on every poll — three bridge crossings per frame, forever. There is
    /// no press edge to retry on here, so the retry is paced by time instead.
    private var refusedAt: [Int: Double] = [:]
    private let refusedRetryMs: Double = 1000

    public init(source: PadSource, coordinator: DisplayCoordinator) {
        self.source = source
        self.coordinator = coordinator
    }

    /// Seats currently held by a pad, which the shell needs in order to know
    /// whether to suppress focus (see `poll`).
    public var hasSeats: Bool { !seated.isEmpty }

    /// Seats that joined on the LAST collect. Their press still goes to the
    /// mapper, which is the point: it becomes the baseline, so the button that
    /// joined reads as already-down rather than as a fresh press. What must not
    /// happen is acting on it, or the bottom face button would join and start
    /// the round in one press. Spans collect to route, which is why it is not a
    /// local.
    private var joinedNow: Set<Int> = []

    /// One poll's pad states: retire vanished pads, seat new ones, stamp
    /// liveness. The mapping itself is the shim's; the CALLER decides which
    /// crossing carries it — poll's own, or the playing tick's frame
    /// (EngineBridge.framePads), which is what keeps a playing tick at one
    /// evaluate. `nowMs` is the pad clock, NOT wall time.
    public func collectStates(nowMs: Double) -> [EngineBridge.PadState] {
        let readings = source.pads()
        retireVanished(readings)
        validateSeats(nowMs: nowMs)

        // Join before mapping: a pad that has not joined has no seat to attribute
        // input to, and the joining press must not also fire whatever it is bound
        // to (see joinedNow above).
        joinedNow.removeAll()
        var states: [EngineBridge.PadState] = []
        for reading in readings {
            let existing = seated[reading.slot] != nil
            guard let seat = seat(for: reading, nowMs: nowMs) else { continue }
            if !existing { joinedNow.insert(seat) }
            // A local seat sends nothing over the wire, so nothing else proves it
            // is still there. The pad being present in this poll IS the proof;
            // without it the liveness sweep would expire an idle player mid-game.
            coordinator.markLocalSeatSeen(seat)
            states.append(EngineBridge.PadState(
                seat: seat, buttons: reading.buttons, axes: reading.axes))
        }
        return states
    }

    /// Route one poll's results — the menu edges and the rumble flag; the game
    /// input never comes back (the shim feeds it to the engine itself).
    public func route(_ results: [EngineBridge.PadResult], playing: Bool) {
        for result in results {
            // The joining press is a baseline, never an action. See joinedNow.
            if joinedNow.contains(result.seat) { continue }
            // The one effect driven by what the PLAYER did rather than what
            // happened to them. Fired off the mapping rather than the resulting
            // lock event, so the thump lands with the press.
            if result.hardDrop { rumble(seat: result.seat, "hardDrop") }
            guard !playing else {
                if result.pressed.contains(PadButton.start) {
                    coordinator.deliverLocal(from: result.seat, data: ["type": MSG.pauseGame])
                }
                continue
            }
            // Index 9 is bound here on EVERY screen, not only while the pad owns
            // input, because tvOS never puts a gamepad's Menu button on the
            // responder chain — it stays in GameController. That is why the remote
            // exits the lobby and a pad does not: the code path is identical, so
            // the press simply is not arriving. Leaving it to `handleMenu` (as the
            // face buttons are left to the focus engine) means nothing hears it,
            // which is what stranded the pause overlay: Menu raised it and Menu
            // could not put it back.
            // Countdown counts as well as playing, the same pair `remoteTogglePause`
            // accepts and the same pair the web allows — otherwise the remote can
            // pause the 3-2-1 and a pad cannot, for no reason a player could guess.
            if result.pressed.contains(PadButton.start),
               coordinator.state == .playing || coordinator.state == .countdown {
                coordinator.remoteTogglePause()
                continue
            }
            for direction in result.nav { onMenuNav(seat: result.seat, direction: direction) }
            for index in result.pressed { onMenuPress(seat: result.seat, index: index) }
        }
    }

    /// Collect, map and route in one go — the path for every tick that is NOT
    /// running a frame (lobby, results, countdown, paused). The playing tick
    /// rides its mapping on the frame crossing instead (see collectStates).
    public func poll(nowMs: Double, playing: Bool) {
        let states = collectStates(nowMs: nowMs)
        guard !states.isEmpty else { return }

        let results: [EngineBridge.PadResult]
        do { results = try coordinator.padPoll(states, nowMs: nowMs, playing: playing) }
        catch {
            FileHandle.standardError.write(Data("[pad] poll failed: \(error)\n".utf8))
            return
        }
        route(results, playing: playing)
    }

    // MARK: - Seat lifecycle

    /// A row can disappear without its pad going anywhere: a session reset
    /// clears the whole roster, and a phone claiming the seat's rejoin QR moves
    /// the row to its own index. Give the seat up so the next press joins fresh
    /// instead of feeding a player that is gone. Swept at 1Hz, not per frame:
    /// `roster()` is a bridge crossing, and the fused playing tick exists to
    /// keep those at one per frame (a doomed press inside the window is a no-op
    /// everywhere — the engine and the room both ignore unknown players).
    /// Android reads its native roster mirror per frame instead; tvOS keeps no
    /// mirror, and a 1s window costs nothing observable.
    private var seatSweepMs: Double = -.infinity

    private func validateSeats(nowMs: Double) {
        guard !seated.isEmpty, nowMs - seatSweepMs >= 1000 else { return }
        seatSweepMs = nowMs
        let rows = Set(coordinator.roster().map(\.peerIndex))
        for (slot, seat) in seated where !rows.contains(seat) {
            seated.removeValue(forKey: slot)
        }
    }

    private func seat(for reading: PadReading, nowMs: Double) -> Int? {
        if let seat = seated[reading.slot] {
            return seat
        }
        // CONNECTING joins, with no press required — the one place tvOS differs
        // from the web and Android, and it follows from the platform rather than
        // from taste. Menus here belong to the focus engine, which means a pad's
        // first press also clicks whatever is highlighted; making that press the
        // join is what had a controller take a seat and start the round together.
        // There is no press to disarm, because there is no joining press.
        //
        // What makes it safe is that tvOS drops an idle pad from
        // `GCController.controllers()` when it sleeps, so "connected" already
        // means "awake and in someone's hands" — the reason the web has to wait
        // for a button (`navigator.getGamepads()` reports nothing until then) does
        // not apply. A pad left in a drawer is not connected, so it cannot join.
        if let at = refusedAt[reading.slot], nowMs - at < refusedRetryMs { return nil }
        return join(reading, nowMs: nowMs)
    }

    private func join(_ reading: PadReading, nowMs: Double) -> Int? {
        let seat = Self.seatId(forSlot: reading.slot)
        let name = coordinator.padName(reading.id)
        // The same HELLO a phone sends. autoName stays false: the pad's name is a
        // real (if borrowed) identity, not a request for an HX-n slot.
        coordinator.deliverLocal(from: seat, data: [
            "type": MSG.hello, "name": name, "autoName": false,
        ])
        // A refused join (room full) leaves no row behind. Drop the seat, and
        // note the refusal so the retry runs on the clock (see refusedAt) rather
        // than on every poll.
        guard coordinator.player(seat) != nil else {
            refusedAt[reading.slot] = nowMs
            return nil
        }
        refusedAt.removeValue(forKey: reading.slot)
        seated[reading.slot] = seat
        return seat
    }

    private func retireVanished(_ readings: [PadReading]) {
        let live = Set(readings.map(\.slot))
        // A replugged pad should try again at once, not wait out an old refusal.
        refusedAt = refusedAt.filter { live.contains($0.key) }
        for (slot, seat) in seated where !live.contains(slot) {
            seated.removeValue(forKey: slot)
            // Same path as a phone closing its tab: mid-game the row is held
            // (with a rejoin QR) so replugging the pad, or scanning with a phone,
            // resumes the seat; in lobby or results it is dropped outright.
            coordinator.deliverLocal(from: seat, data: ["type": MSG.leave])
        }
    }

    // MARK: - Menus

    /// The lobby steps this seat's start level on LEFT/RIGHT only. Up/down belong
    /// to the focus engine: the lobby's two controls are stacked vertically (START
    /// bottom-center, ⓘ top-right — see LobbyView), and nothing sits beside either,
    /// so the two axes divide cleanly with no input taken away from the UI.
    ///
    /// That split is what lets several pads coexist here. Level and colour are
    /// PER-PLAYER and never touch focus, so each pad sets its own; START and ⓘ are
    /// decisions about the display, where one shared ring is the same model the
    /// pause and results overlays already use.
    ///
    /// Rests on the lobby having nothing focusable side-by-side. Put two controls
    /// in a row there and left/right starts moving the ring as well as the level.
    private func onMenuNav(seat: Int, direction: String) {
        guard coordinator.state == .lobby else { return }
        let step: Int
        if direction == "right" { step = 1 }
        else if direction == "left" { step = -1 }
        else { return }   // up/down belong to the focus engine
        guard let level = coordinator.roomLevelAfterStep(seat: seat, delta: step) else { return }
        coordinator.deliverLocal(from: seat, data: ["type": MSG.setLevel, "level": level])
    }

    /// Only what the focus engine cannot reach on its own. Outside a running match
    /// the pad drives focus exactly like a remote, so START needs no binding here:
    /// the bottom face button is tvOS's Select and already clicks it. Binding it
    /// again would also start the round on a press aimed at ⓘ. Same reason Play
    /// Again and Continue are absent, and why a button added to any of these
    /// screens is pad-reachable the day it lands.
    private func onMenuPress(seat: Int, index: Int) {
        guard coordinator.state == .lobby else { return }

        // Index 9 is the exception, as everywhere (see route): a gamepad's Menu
        // button never reaches the responder chain, so if it is to mean anything
        // the binding must be here. In the lobby it starts the round — the same
        // host-gated Start the web and Android give it. Not the bottom face
        // button too (Android's other binding): here that is Select, and the
        // focus engine already clicks the focused START with it.
        if index == PadButton.start {
            if seat == coordinator.hostPeerIndex {
                coordinator.deliverLocal(from: seat, data: ["type": MSG.startGame])
            }
            return
        }

        // Colour has no on-screen control to focus (the picker lives on the
        // phone), so it keeps a shoulder side of its own in each direction. The
        // room core resolves which slot is next; this then sends the same
        // SET_COLOR the phone's picker sends.
        var step = 0
        if index == PadButton.l1 || index == PadButton.l2 { step = -1 }
        else if index == PadButton.r1 || index == PadButton.r2 { step = 1 }
        guard step != 0, let next = coordinator.roomColorAfterStep(seat: seat, step: step) else { return }
        coordinator.deliverLocal(from: seat, data: ["type": MSG.setColor, "colorIndex": next])
    }

    // MARK: - Rumble

    /// Effects a phone gets as haptics. Driven off engine events rather than a
    /// message, because the pad is local and the event is right there. WHAT each
    /// one feels like is the shared table's call, not this file's.
    public func handle(event: GameEvent) {
        guard !seated.isEmpty else { return }
        switch event.type {
        case "garbage_sent":
            guard let toId = event.toId else { return }
            rumble(seat: toId, "garbageSent", lines: event.lines ?? 0)
        case "garbage_cancelled":
            guard let playerId = event.playerId else { return }
            rumble(seat: playerId, "garbageCancelled")
        case "garbage_applied":
            // The stack just got shoved up. Distinct from garbage_sent, which is
            // only the telegraph: in between, this player could still have
            // cancelled it.
            guard let playerId = event.playerId else { return }
            rumble(seat: playerId, "garbageApplied", lines: event.lines ?? 0)
        case "line_clear":
            guard let playerId = event.playerId else { return }
            rumble(seat: playerId, "lineClear", lines: event.lines ?? 0)
        case "player_ko":
            guard let playerId = event.playerId else { return }
            rumble(seat: playerId, "playerKO")
        default:
            break
        }
    }

    /// Cached across the whole session, misses included: the effect for a given
    /// (kind, lines) never changes, and looking it up crosses the bridge.
    private var effects: [String: EngineBridge.PadRumble?] = [:]

    private func rumble(seat: Int, _ kind: String, lines: Int = 0) {
        guard let slot = seated.first(where: { $0.value == seat })?.key else { return }
        let key = "\(kind):\(lines)"
        let effect: EngineBridge.PadRumble?
        if let cached = effects[key] {
            effect = cached
        } else {
            effect = coordinator.padRumble(kind, lines: lines)
            // updateValue, not the subscript: subscript-assigning nil REMOVES
            // the key, so a miss would cross the bridge on every event (the
            // Android twin caches the miss too).
            effects.updateValue(effect, forKey: key)
        }
        guard let effect else { return }
        source.rumble(slot: slot, durationMs: effect.durationMs,
                      weak: effect.weak, strong: effect.strong)
    }
}
