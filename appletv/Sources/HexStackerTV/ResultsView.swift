import SwiftUI
import UIKit
import HexStackerKit

/// Results overlay (web `renderResults` / `#results-screen`, tvOS `buildResults`,
/// Android `ResultsScreen`). Ranked rows over the frozen SpriteKit boards: a
/// winner radial glow, player-colored rank + name, lines/level stats, and the
/// recessed-socket late-joiner treatment. NO title/heading (web `#results-screen`
/// is just the list + buttons, no logo). The PLAY AGAIN primary CTA is host-tinted
/// (web `applyHostTint`). No anti-misclick gate on the TV (a couch remote, not a
/// phone): the buttons are live and focusable immediately.
///
/// The whole-screen fade is the parent's job: DisplayChromeView presents this via
/// `.transition(.opacity)`, so this view only stages its own row + button entrance.
struct ResultsView: View {
    let results: [MatchResult]
    let hostColorSlot: Int?
    let vp: Vp
    let onPlayAgain: () -> Void
    let onNewGame: () -> Void

    private enum Field { case playAgain, newGame }
    @FocusState private var focus: Field?

    /// Buttons fade in with the list (web .result-actions), matching the 0.4s row
    /// stagger duration with no per-row delay. Reduce Motion shows them settled
    /// (web results.css forces this gate open under prefers-reduced-motion).
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var buttonsShown = false

    /// Winner glow color: the lowest-rank player's identity color at 0.08 (web
    /// --winner-glow), gold #FFD700 at 0.06 as the no-winner fallback (Android
    /// parity for the no-winner-color case).
    private static func glow(for sorted: [MatchResult]) -> Color {
        if let slot = sorted.first?.colorIndex {
            return UITheme.player(slot: slot).opacity(0.08)
        }
        return Color(red: 1, green: 0.843, blue: 0).opacity(0.06)
    }

    /// 180px tile of grayscale noise (the web bakes the equivalent from an SVG
    /// feTurbulence data URI). Seeded xorshift so gallery captures stay
    /// byte-stable across launches.
    private static let noiseTile: UIImage = {
        let side = 180
        var state: UInt64 = 0x9E3779B97F4A7C15
        var pixels = [UInt8](repeating: 0, count: side * side)
        for i in pixels.indices {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            pixels[i] = UInt8(truncatingIfNeeded: state)
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let image = CGImage(width: side, height: side,
                            bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: side,
                            space: CGColorSpaceCreateDeviceGray(),
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                            provider: provider, decode: nil,
                            shouldInterpolate: false, intent: .defaultIntent)!
        return UIImage(cgImage: image)
    }()

    var body: some View {
        // Sort once per render (nil rank = late joiners, sorted last), then derive
        // the glow, solo flag and rows from it rather than re-sorting per access.
        let sorted = results.sorted { ($0.rank ?? 999) < ($1.rank ?? 999) }
        let glowColor = Self.glow(for: sorted)
        let solo = sorted.count == 1
        // Row metrics from the web clamps (vh against the full scene height, like
        // the browser viewport): name/rank clamp(1.5rem,3vh,2.8rem), stats
        // clamp(1.2rem,2.6vh,2.2rem), vertical padding clamp(0.8rem,1.6vh,1.5rem).
        // Row height is the Baloo natural line box (~1.6em) plus the padding.
        let nameSize = vp.vh(24, 3, 44.8)
        let statsSize = vp.vh(19.2, 2.6, 35.2)
        let rowPadV = vp.vh(12.8, 1.6, 24)
        let rowH = nameSize * 1.6 + rowPadV * 2
        let rowGap = vp.vh(8, 1, 16)                 // #results-list gap clamp(0.5rem,1vh,1rem)
        let rowW = min(vp.w * 0.9, 860)              // #results-list width 90%, max-width 860px

        // Action-button metrics; the CTA pair balances the group below the rows.
        let btnH = vp.actionButtonH
        let btnW = max(vp.w * 0.20, btnH * 4.5)
        let btnGap = vp.w * 0.03
        // web .screen gap clamp(2rem,5vh,4rem): the rows + buttons are ONE
        // vertically-centered group so a solo result isn't stranded above buttons.
        let groupGap = max(btnH * 0.7, vp.h * 0.06)

        ZStack {
            // Web --overlay-bg (bg-primary @0.88) over the blurred frozen boards,
            // then the single soft winner radial (web --winner-glow at 50% 30%,
            // radius 0.6x the farthest-corner distance).
            UITheme.overlayBg.ignoresSafeArea()
            Rectangle()
                .fill(RadialGradient(
                    colors: [glowColor, .clear],
                    center: UnitPoint(x: 0.5, y: 0.3),
                    startRadius: 0,
                    endRadius: 0.6 * hypot(vp.w * 0.5, vp.h * 0.7)))
                .ignoresSafeArea()
            // Anti-banding dither (web #results-screen::before): the low-alpha
            // radial above bands visibly on 8-bit panels; tiled grayscale noise
            // at 0.05 with overlay blending breaks the bands perceptually.
            Image(uiImage: Self.noiseTile)
                .resizable(resizingMode: .tile)
                .opacity(0.05)
                .blendMode(.overlay)
                .allowsHitTesting(false)
                .ignoresSafeArea()

            VStack(spacing: groupGap) {
                VStack(spacing: rowGap) {
                    ForEach(Array(sorted.enumerated()), id: \.element.playerId) { i, res in
                        // Keyed by playerId like the lobby grid: late joiners append
                        // at runtime, and the id keeps each row's entrance with its
                        // player rather than restaging the whole list.
                        ResultRow(res: res, index: i, solo: solo,
                                  nameSize: nameSize, statsSize: statsSize,
                                  rowW: rowW, rowH: rowH, vp: vp)
                    }
                }

                HStack(spacing: btnGap) {
                    // The primary CTA reads the host color (web applyHostTint); the
                    // winner only tints the background glow, not the button.
                    ChromeButton(text: trUpper("play_again"), primary: true,
                                 tint: UITheme.hostTint(hostColorSlot),
                                 width: btnW, height: btnH, action: onPlayAgain)
                        .focused($focus, equals: .playAgain)
                    ChromeButton(text: trUpper("new_game"), primary: false,
                                 tint: UITheme.hostTint(hostColorSlot),
                                 width: btnW, height: btnH, action: onNewGame)
                        .focused($focus, equals: .newGame)
                }
                .opacity(reduceMotion || buttonsShown ? 1 : 0)
                .defaultFocus($focus, .playAgain)
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.4)) { buttonsShown = true }
            // Imperative seed alongside .defaultFocus: the buttons insert at
            // opacity 0 (the entrance fade), and the focus engine skips
            // entrance-transparent views. Assigning FocusState directly works
            // even while transparent (LobbyView and ConnectionOverlayView do
            // the same).
            focus = .playAgain
        }
    }
}

/// One ranked row (web `.result-row`, tvOS `buildResultRow`): rank | name (left) |
/// stats (right) on a borderless 20px card. Late joiners get the recessed socket
/// treatment (web `.result-row--joining`: socket fill, faint hairline, no shadow)
/// instead of a dashed rim.
private struct ResultRow: View {
    let res: MatchResult
    let index: Int
    let solo: Bool
    let nameSize: CGFloat
    let statsSize: CGFloat
    let rowW: CGFloat
    let rowH: CGFloat
    let vp: Vp

    /// Stagger entrance: fade + 10pt upward drift, delay 0.2 + 0.08*index s.
    /// Reduce Motion renders the row settled (decorative entrance).
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    private var playerColor: Color? { res.colorIndex.map { UITheme.player(slot: $0) } }
    private var baseOpacity: CGFloat { res.newPlayer ? 0.75 : 1 }   // .result-row--joining dim

    var body: some View {
        // Web paddings: left clamp(0.7rem,1.3vw,1.3rem), right clamp(1.2rem,2.4vw,2.4rem).
        let padL = vp.vw(11.2, 1.3, 20.8)
        let padR = vp.vw(19.2, 2.4, 38.4)

        HStack(spacing: 0) {
            if !solo {
                // Rank sits in a ~1ch tabular column (web min-width 1ch); heavier
                // Orbitron at the name size, player-colored (secondary for a joiner).
                Text(res.newPlayer ? "–" : "\(res.rank ?? 0)")
                    .styled(font: AppFont.black, size: nameSize,
                            color: res.newPlayer ? UITheme.textSecondary : (playerColor ?? UITheme.textSecondary))
                    .frame(width: nameSize * 0.8, alignment: .center)
                Spacer().frame(width: 20)   // .result-row gap 1.25rem
            }
            Text(res.playerName ?? tr("player"))   // web fallback for unnamed players
                .styled(font: AppFont.brandBold, size: nameSize,
                        color: playerColor ?? UITheme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer().frame(width: 20)
            stats
        }
        .padding(.leading, padL)
        .padding(.trailing, padR)
        .frame(width: rowW, height: rowH)
        .background(card)
        .opacity(reduceMotion || shown ? baseOpacity : 0)
        .offset(y: reduceMotion || shown ? 0 : 10)
        .onAppear {
            withAnimation(.easeOut(duration: 0.4).delay(0.2 + 0.08 * Double(index))) { shown = true }
        }
    }

    // .result-stats is the HUD voice (Orbitron 700, tabular figures), like every
    // other numeric readout; render lines + level as two spans with the web 1.5rem
    // gap (buildResultRow concatenates them only because SKLabelNode is one label;
    // the web + Android render two flex spans).
    @ViewBuilder private var stats: some View {
        if res.newPlayer {
            Text(tr("new_player"))
                .styled(font: AppFont.name, size: statsSize, color: UITheme.textSecondary)
        } else {
            HStack(spacing: 24) {   // .result-stats gap 1.5rem
                Text(tr("n_lines", res.lines ?? 0))
                    .styled(font: AppFont.name, size: statsSize, color: UITheme.textSecondary)
                Text(tr("level_n", res.level ?? 1))
                    .styled(font: AppFont.name, size: statsSize, color: UITheme.textSecondary)
            }
        }
    }

    // Borderless card matching the lobby's tonal cards (web .result-row: 20px
    // radius, bg-card, --shadow-sm: 0 2px 4px rgba(0,0,0,0.32)). Late joiners get
    // the recessed socket fill + faint hairline, no shadow.
    @ViewBuilder private var card: some View {
        if res.newPlayer {
            RoundedRectangle(cornerRadius: 20)
                .fill(UITheme.socket(0.55))
                .overlay(RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(UITheme.hairline(0.05), lineWidth: 1))
        } else {
            RoundedRectangle(cornerRadius: 20)
                .fill(UITheme.bgCard)
                .shadow(color: .black.opacity(0.32), radius: 4, x: 0, y: 2)
        }
    }
}
