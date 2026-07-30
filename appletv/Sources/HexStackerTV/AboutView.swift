import SwiftUI

/// About page for the tvOS display, pushed on the lobby's NavigationStack by
/// the info button. Two QR cards (Privacy / Imprint) link the phone the player
/// is already holding to the web legal pages, plus a link that drills into the
/// Open Source Licenses page. Menu pops back to the lobby (the stack's job).
///
/// The game is played on phones, so the long-form legal text stays single-sourced
/// on the web (not re-rendered natively): the TV only offers a scan target + the
/// URL. Visible copy routes through i18n: the card labels via `privacy` / `imprint`
/// and the Licenses button via `licenses_title`. There is no on-screen back hint
/// (tvOS HIG: the remote navigates back implicitly); only the version tag stays
/// untranslated (a language-neutral marker).
///
/// Mirrors the Android AboutScreen decomposition (a centered cluster of two
/// LegalQrCards + the Licenses button) at the original page proportions.
struct AboutView: View {
    let vp: Vp

    var body: some View {
        // Full-viewport metrics with a single title-safe edge margin, matching the
        // sibling chrome (LobbyView): the page proportions carry over with
        // playRect.height/width read as the full vp.h/vp.w.
        let W = vp.w, H = vp.h
        let margin = H * 0.05
        let cardW = min(W * 0.28, 360)

        ZStack {
            // No opaque fill: this page lives under `case .lobby`, so the
            // BoardScene's ambient falling pieces keep rendering beneath
            // (showScreen never fires for a push). The accent vignette mirrors
            // LobbyView, so the backdrop reads identical across the swap.
            RadialGradient(colors: [UITheme.accentPrimary.opacity(0.06), .clear],
                           center: UnitPoint(x: 0.5, y: 0.3),
                           startRadius: 0,
                           endRadius: max(W, H) * 0.575)
                .ignoresSafeArea()

            // No on-screen back hint (tvOS HIG): the remote's Back/Menu button
            // navigates back implicitly, and its label differs across remote
            // generations, so naming it in text would be wrong for half the users.

            // Privacy / Imprint QR cards + the Licenses button as one vertically
            // centered cluster, so the page reads as a tight group rather than three
            // elements spread across the whole height.
            VStack(spacing: H * 0.06) {
                HStack(spacing: min(W * 0.06, 96)) {
                    LegalQrCard(label: trUpper("privacy"), url: Self.legalURL("privacy"), width: cardW)
                    LegalQrCard(label: trUpper("imprint"), url: Self.legalURL("imprint"), width: cardW)
                }
                // Uppercased for parity with web `.btn { text-transform: uppercase }`
                // (styling, not new copy). The only focusable element on the page,
                // so the stack seats focus here on push.
                ChromeLink(text: trUpper("licenses_title"), primary: false,
                           tint: UITheme.accentPrimary, height: vp.actionButtonH,
                           value: AboutRoute.licenses)
            }
            .padding(.horizontal, W * 0.05)

            // App version pinned to the bottom title-safe edge: a language-neutral
            // marker (like the QR URLs), so it needs no i18n string.
            Text(Self.versionString())
                .styled(font: AppFont.semibold, size: max(18, min(H * 0.026, 26)),
                        color: UITheme.textFaint, tracking: 0.02)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, margin)
        }
    }

    /// The web legal pages the QR codes encode. The pages exist in only two
    /// languages: German at the root (/privacy) and English under /en/, so a German
    /// display links the German pages and every other locale links the English ones,
    /// mirroring the website's own footer routing.
    private static func legalURL(_ page: String) -> String {
        let prefix = resolvedLocale == "de" ? "" : "en/"
        return "https://couchpad.games/\(prefix)\(page)"
    }

    /// The marketing version from the bundle Info.plist (CFBundleShortVersionString),
    /// or "" if absent (renders nothing). Display-only.
    private static func versionString() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }
}

/// One About QR card: a label (Privacy / Imprint), the QR encoding `url` on a
/// full-bleed white panel, and the URL text below. Display-only (not focusable):
/// the QR is the whole point, so a phone scans it. Sizes mirror the web legal
/// card fractions (pad 7%, gap 5%, label 0.58 of the 13% label band, URL 0.6 of
/// the 10% URL band, QR inset 4%, card radius 9%).
private struct LegalQrCard: View {
    let label: String
    let url: String
    let width: CGFloat

    var body: some View {
        let w = width
        let pad = w * 0.07
        let gap = w * 0.05
        let qrSide = w - pad * 2

        VStack(spacing: gap) {
            Text(label)
                .styled(font: AppFont.brandBold, size: w * 0.13 * 0.58,
                        color: UITheme.textPrimary(), tracking: 0.12)
                .lineLimit(1)

            // ONE baked bitmap for the white panel + modules (QRCode.cardImage,
            // same as the lobby card): composed as Shape + Image they fade as
            // separate layers through the page's push/pop cross-fade, and the
            // two white rectangles visibly overlapped mid-transition.
            Image(uiImage: QRCode.cardImage(for: url, side: qrSide,
                                            cornerRadius: w * 0.05,
                                            padding: qrSide * 0.04))

            // Auto-shrink rather than clip: the URL is the human-readable fallback for
            // the QR, so a truncated path is useless.
            Text(url.replacingOccurrences(of: "https://", with: ""))
                .styled(font: AppFont.semibold, size: w * 0.1 * 0.6,
                        color: UITheme.textSecondary, tracking: 0.02)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
        .padding(pad)
        // Pin the card to its metric width: every internal fraction derives
        // from w, and without the frame the square QR panel would inflate to
        // whatever width the HStack proposes.
        .frame(width: w)
        .background(UITheme.bgCard)
        .clipShape(RoundedRectangle(cornerRadius: w * 0.09))
        .overlay(RoundedRectangle(cornerRadius: w * 0.09).stroke(UITheme.border, lineWidth: 1))
    }
}
