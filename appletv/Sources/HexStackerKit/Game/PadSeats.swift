import Foundation

/// Gamepads attached to the TV itself, as players.
///
/// A pad is not a second kind of player. Every press becomes the SAME message a
/// phone would have sent and goes through the coordinator's inbound path, so
/// joining, auto-naming, colour slots, host election, liveness and pause all keep
/// running their one implementation. What a local seat skips is the relay, and
/// that is also why its peer index is NEGATIVE: the relay hands out 1...N and owns
/// slot 0, so -(slot + 1) can never collide with a phone. `isLocalSeat` is what
/// guards the `transport.sendTo` call sites.
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
    /// `[leftX, leftY, rightX, rightY]`, y POSITIVE DOWN as the web reports it.
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
    /// The relay owns 1...N and the display owns 0, so negatives are ours alone.
    /// Derived from the pad's own slot, so unplugging and replugging the same pad
    /// lands back on the same seat: a reconnect, not a new player.
    public static func seatId(forSlot slot: Int) -> Int { -(slot + 1) }

    /// True for a seat this display owns rather than one the relay handed out.
    /// Every `sendTo` has to ask, because there is nothing on the wire to send to.
    public static func isLocalSeat(_ peerIndex: Int) -> Bool { peerIndex < 0 }

    private let source: PadSource
    private unowned let coordinator: DisplayCoordinator
    /// slot -> seat id, for pads that have actually joined.
    private var seated: [Int: Int] = [:]

    public init(source: PadSource, coordinator: DisplayCoordinator) {
        self.source = source
        self.coordinator = coordinator
    }

    /// Seats currently held by a pad, which the shell needs in order to know
    /// whether to suppress focus (see `poll`).
    public var hasSeats: Bool { !seated.isEmpty }

    /// One poll, driven from the coordinator's own tick so there is a single loop.
    /// `nowMs` is the frame clock the mapper measures DAS and the soft-drop
    /// keepalive against, NOT wall time.
    public func poll(nowMs: Double, playing: Bool) {
        let readings = source.pads()
        retireVanished(readings)

        // Join before mapping: a pad that has not joined has no seat to attribute
        // input to, and the joining press must not also fire whatever it is bound
        // to. `padPoll` is handed the joining press as the mapper's baseline, so
        // it reads as already-down rather than as a fresh press next frame.
        var states: [EngineBridge.PadState] = []
        for reading in readings {
            guard let seat = seat(for: reading) else { continue }
            states.append(EngineBridge.PadState(
                seat: seat, buttons: reading.buttons, axes: reading.axes))
        }
        guard !states.isEmpty else { return }

        let results: [EngineBridge.PadResult]
        do { results = try coordinator.padPoll(states, nowMs: nowMs, playing: playing) }
        catch {
            FileHandle.standardError.write(Data("[pad] poll failed: \(error)\n".utf8))
            return
        }

        for result in results {
            // A local seat sends nothing over the wire, so nothing else proves it
            // is still there. The pad being present in this poll IS the proof;
            // without it the liveness sweep would expire an idle player mid-game.
            coordinator.markLocalSeatSeen(result.seat)
            for message in result.messages {
                coordinator.deliverLocal(from: result.seat, data: message)
            }
            guard !playing else {
                if result.pressed.contains(PadButton.start) {
                    coordinator.deliverLocal(from: result.seat, data: ["type": MSG.pauseGame])
                }
                continue
            }
            for direction in result.nav { onMenuNav(seat: result.seat, direction: direction) }
            for index in result.pressed { onMenuPress(seat: result.seat, index: index) }
        }
    }

    // MARK: - Seat lifecycle

    private func seat(for reading: PadReading) -> Int? {
        if let seat = seated[reading.slot] {
            // The row can disappear without the pad going anywhere: a session
            // reset clears the whole roster. Give the seat up so the next press
            // joins the new room instead of feeding a player that is gone.
            if coordinator.player(seat) == nil {
                seated.removeValue(forKey: reading.slot)
                return nil
            }
            return seat
        }
        // Any press joins. Naming one button would leave a player who pressed a
        // different one with no feedback, and no letter is right on every brand.
        // Unlike the web there is no welcome screen to exclude: a TV display goes
        // straight to the lobby, so there is always a room to join.
        guard reading.buttons.contains(true) else { return nil }
        return join(reading)
    }

    private func join(_ reading: PadReading) -> Int? {
        let seat = Self.seatId(forSlot: reading.slot)
        let name = coordinator.padName(reading.id)
        // The same HELLO a phone sends. autoName stays false: the pad's name is a
        // real (if borrowed) identity, not a request for an HX-n slot.
        coordinator.deliverLocal(from: seat, data: [
            "type": MSG.hello, "name": name, "autoName": false,
        ])
        // A refused join (room full) leaves no row behind. Drop the seat so the
        // next press tries again rather than feeding input nobody owns.
        guard coordinator.player(seat) != nil else { return nil }
        seated[reading.slot] = seat
        return seat
    }

    private func retireVanished(_ readings: [PadReading]) {
        let live = Set(readings.map(\.slot))
        for (slot, seat) in seated where !live.contains(slot) {
            seated.removeValue(forKey: slot)
            // Same path as a phone closing its tab: mid-game the row is held
            // (with a rejoin QR) so replugging the pad, or scanning with a phone,
            // resumes the seat; in lobby or results it is dropped outright.
            coordinator.deliverLocal(from: seat, data: ["type": MSG.leave])
        }
    }

    // MARK: - Menus

    /// The lobby steps this seat's start level, which is why the shell suppresses
    /// system focus there while a pad is seated: the D-pad cannot both move a
    /// focus ring and set a level. Everywhere else outside play the pad is left
    /// alone to drive focus like a remote, so Play Again, Continue and the rest
    /// need no binding here and a new button is reachable the day it lands.
    private func onMenuNav(seat: Int, direction: String) {
        guard coordinator.state == .lobby else { return }
        let step = (direction == "right" || direction == "up") ? 1 : -1
        guard let level = coordinator.roomLevelAfterStep(seat: seat, delta: step) else { return }
        coordinator.deliverLocal(from: seat, data: ["type": MSG.setLevel, "level": level])
    }

    private func onMenuPress(seat: Int, index: Int) {
        guard coordinator.state == .lobby else {
            // Outside the lobby Start toggles the pause directly. It is the one
            // action with no button on screen to focus while a game is running.
            if index == PadButton.start {
                coordinator.deliverLocal(
                    from: seat, data: ["type": coordinator.isPaused ? MSG.resumeGame : MSG.pauseGame])
            }
            return
        }

        // Starting the round is the host's call, the same rule the phones' lobby
        // renders. The bottom face button because it is the one a player reaches
        // for when they want something to happen; Start because its meaning holds
        // on every brand. See server/PadMapper.js for why no face button is
        // brand-safe and why that does not matter in a lobby.
        if index == PadButton.faceDown || index == PadButton.start {
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
    /// message, because the pad is local and the event is right there.
    public func handle(event: GameEvent) {
        guard !seated.isEmpty else { return }
        switch event.type {
        case "garbage_sent":
            // The telegraph: garbage is queued and the meter is filling.
            guard let toId = event.toId else { return }
            rumble(seat: toId, durationMs: 120 + 40 * Double(event.lines ?? 0), weak: 0.35, strong: 0.15)
        case "garbage_cancelled":
            guard let playerId = event.playerId else { return }
            rumble(seat: playerId, durationMs: 60, weak: 0.5, strong: 0)
        case "player_ko":
            guard let playerId = event.playerId else { return }
            rumble(seat: playerId, durationMs: 400, weak: 0.6, strong: 1)
        default:
            break
        }
    }

    private func rumble(seat: Int, durationMs: Double, weak: Double, strong: Double) {
        guard let slot = seated.first(where: { $0.value == seat })?.key else { return }
        source.rumble(slot: slot, durationMs: durationMs, weak: weak, strong: strong)
    }
}
