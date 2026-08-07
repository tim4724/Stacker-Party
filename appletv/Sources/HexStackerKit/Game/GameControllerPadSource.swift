import CoreHaptics
import Foundation
import GameController

/// Reads attached MFi / Xbox / DualSense / Switch pads through GameController and
/// presents them in the W3C "standard" mapping the shared mapper expects
/// (`server/PadMapper.js`). This file is the ONLY place that knows what a
/// `GCExtendedGamepad` is: everything about what a press MEANS is either in the
/// portable mapper or in `PadSeats`.
///
/// Two conversions matter and both are easy to get silently wrong:
///
///   - Y AXIS SIGN. GameController reports a thumbstick's y as +1 UP; the web's
///     Gamepad API reports +1 DOWN, and the shared mapper reads a positive y as
///     a soft drop. Passing it through unflipped inverts the stick.
///   - BUTTON ORDER. The mapper binds by index, never by label, so what has to
///     line up is the PHYSICAL position: index 0 is the bottom face button on
///     every brand. GameController's `buttonA` is already the bottom one (it is
///     named for position, not for the letter printed on a Switch pad), so the
///     four face buttons map straight across.
///
/// Menu (index 9) is deliberately reported but never acted on. tvOS delivers it
/// as a `.menu` UIPress to the responder chain, where the app already handles it;
/// see the note in `PadSeats.onMenuPress`.
public final class GameControllerPadSource: PadSource {
    /// Slots are assigned here rather than read from `GCController.controllers()`,
    /// whose order is not stable: a pad must keep its slot across polls and
    /// reclaim it after a replug, or it would be a new player every time. The
    /// system's own `playerIndex` is the natural home for it, so setting it also
    /// lights the right player LED on pads that have one.
    private var slots: [ObjectIdentifier: Int] = [:]

    public init() {}

    public func pads() -> [PadReading] {
        var readings: [PadReading] = []
        for controller in GCController.controllers() {
            guard let pad = controller.extendedGamepad else { continue }
            let slot = slot(for: controller)
            readings.append(PadReading(
                slot: slot,
                id: identity(of: controller),
                buttons: buttons(pad),
                axes: axes(pad)
            ))
        }
        // Stable order so a shell walking the list twice sees the same thing.
        return readings.sorted { $0.slot < $1.slot }
    }

    public func rumble(slot: Int, durationMs: Double, weak: Double, strong: Double) {
        // `.default` is, with `.all`, the ONLY locality every pad is guaranteed to
        // support, and Apple's recommendation: it plays on the handles. Driving the
        // two motors separately via .leftHandle/.rightHandle returns nil on a pad
        // that doesn't split them, which is silence rather than a coarser rumble.
        // So the pair collapses to the stronger of the two, exactly as Android's
        // single-motor `InputDevice.vibrator` does.
        let magnitude = max(weak, strong)
        guard magnitude > 0, let controller = controller(inSlot: slot) else { return }
        let key = ObjectIdentifier(controller)
        if engines[key] == nil {
            engines[key] = controller.haptics?.createEngine(withLocality: .default)
        }
        guard let engine = engines[key] else { return }
        do {
            // Cheap when already running; restarts an engine that auto-shut down
            // during a quiet stretch of play.
            try engine.start()
            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(magnitude)),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
                ],
                relativeTime: 0,
                duration: durationMs / 1000
            )
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            players[key] = player
        } catch {
            // A pad with no working motor is not a reason to interrupt a game.
        }
    }

    /// Both of these exist to be RETAINED, which is the whole point. A
    /// `CHHapticEngine` stops the instant its last strong reference goes, and so
    /// does its player: built as locals, they are torn down on the way out of
    /// `rumble` and no effect short enough to be useful ever reaches the motor.
    /// One engine per controller also beats one per effect, which was a device
    /// round-trip every line clear.
    private var engines: [ObjectIdentifier: CHHapticEngine] = [:]
    /// Only the newest player per controller is kept: the next effect should
    /// replace the last one anyway, so this stays bounded on its own.
    private var players: [ObjectIdentifier: CHHapticPatternPlayer] = [:]

    // MARK: - Slots

    private func slot(for controller: GCController) -> Int {
        let key = ObjectIdentifier(controller)
        if let slot = slots[key] { return slot }
        // Purge BEFORE choosing, which is the whole point of the ordering. A pad
        // that dropped and came back is a NEW GCController object, so its old
        // entry is still sitting in `slots`; counting that as taken hands the
        // reconnect slot 1. The seat id is derived from the slot
        // (`PadSeats.seatId(forSlot:)`), so that is not a cosmetic difference —
        // it comes back as a different PLAYER, and the row `retireVanished` held
        // open for the resume is orphaned until it expires.
        let live = Set(GCController.controllers().map(ObjectIdentifier.init))
        slots = slots.filter { live.contains($0.key) }
        engines = engines.filter { live.contains($0.key) }
        players = players.filter { live.contains($0.key) }
        let taken = Set(slots.values)
        var next = 0
        while taken.contains(next) { next += 1 }
        slots[key] = next
        controller.playerIndex = GCControllerPlayerIndex(rawValue: next) ?? .indexUnset
        return next
    }

    private func controller(inSlot slot: Int) -> GCController? {
        guard let key = slots.first(where: { $0.value == slot })?.key else { return nil }
        return GCController.controllers().first { ObjectIdentifier($0) == key }
    }

    /// What the shared name cleanup is given. `vendorName` is the product string
    /// ("Xbox Wireless Controller", "DualSense Wireless Controller"), which is the
    /// same kind of string a browser reports, so one set of rules fits both.
    private func identity(of controller: GCController) -> String {
        controller.vendorName ?? "Gamepad"
    }

    // MARK: - Standard mapping

    private func buttons(_ pad: GCExtendedGamepad) -> [Bool] {
        var out = [Bool](repeating: false, count: 17)
        out[0] = pad.buttonA.isPressed        // bottom face: A / Cross / Switch B
        out[1] = pad.buttonB.isPressed        // right face
        out[2] = pad.buttonX.isPressed        // left face
        out[3] = pad.buttonY.isPressed        // top face
        out[4] = pad.leftShoulder.isPressed
        out[5] = pad.rightShoulder.isPressed
        out[6] = pad.leftTrigger.isPressed
        out[7] = pad.rightTrigger.isPressed
        // 8 is Select/Back, which the mapper leaves unbound on purpose.
        out[9] = pad.buttonMenu.isPressed
        out[12] = pad.dpad.up.isPressed
        out[13] = pad.dpad.down.isPressed
        out[14] = pad.dpad.left.isPressed
        out[15] = pad.dpad.right.isPressed
        return out
    }

    private func axes(_ pad: GCExtendedGamepad) -> [Double] {
        [
            Double(pad.leftThumbstick.xAxis.value),
            // Flipped: see the note at the top. +1 is UP here, DOWN for the mapper.
            Double(-pad.leftThumbstick.yAxis.value),
            Double(pad.rightThumbstick.xAxis.value),
            Double(-pad.rightThumbstick.yAxis.value),
        ]
    }

}
