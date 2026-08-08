import SwiftUI
import HexStackerKit

/// Countdown 3/2/1/GO over the flat plum scrim (web #countdown-overlay:
/// var(--overlay-bg); the A2 flat rule dropped the radial glow). Only the
/// number animates: a pop on each value (web countdownBeat's opening beat,
/// tvOS scale 0.7 → 1.0) that pauses with the game.
struct CountdownOverlayView: View {
    let value: CountdownValue
    let paused: Bool
    let vp: Vp

    private var text: String {
        switch value {
        case .number(let n): return "\(n)"
        case .go: return tr("go")
        }
    }

    var body: some View {
        ZStack {
            UITheme.overlayBg.ignoresSafeArea()
            // id(text) gives each tick a fresh identity so the pop replays
            // (web restarts countdownBeat per value). .identity keeps the swap
            // itself instant (web/Android parity): the reveal transaction in
            // showCountdown must not cross-fade successive digits.
            PopNumber(text: text,
                      size: vp.vh(96, 15, 224),   // web clamp(6rem,15vh,14rem)
                      paused: paused)
                .id(text)
                .transition(.identity)
                // For the lifecycle UI test: board HUDs also carry bare digit
                // labels, so presence of THE countdown digit needs an identifier.
                .accessibilityIdentifier("countdown-digit")
        }
    }
}

/// One countdown number with its entry pop + single subtle beat (web
/// countdownBeat's opening cycle: 0.7 → 1.0 → 1.06 → 1.0); fresh identity per
/// tick restarts it.
private struct PopNumber: View {
    let text: String
    let size: CGFloat
    let paused: Bool

    // Trips once per digit (fresh @State per .id identity): the trigger-based
    // animator plays the keyframes ONCE. The trigger-less overload defaults to
    // repeating and would snap 1.0 → 0.7 at every 0.98s loop restart.
    @State private var began = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let label = Text(text)
            .styled(font: AppFont.black, size: size,
                    color: UITheme.accentPrimary, tracking: 0.05)
        if paused || reduceMotion {
            label   // paused / frozen shot / Reduce Motion: no motion, full scale
        } else {
            label.keyframeAnimator(initialValue: CGFloat(0.7), trigger: began) { view, scale in
                view.scaleEffect(scale)
            } keyframes: { _ in
                KeyframeTrack {
                    CubicKeyframe(1.0, duration: 0.18)
                    CubicKeyframe(1.06, duration: 0.4)
                    CubicKeyframe(1.0, duration: 0.4)
                }
            }
            .onAppear { began = true }
        }
    }
}
