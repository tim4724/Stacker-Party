import SpriteKit

/// Distance from the alphabetic baseline down to the EM-SQUARE bottom, in points,
/// for `font` at `size` — the offset Canvas2D's `textBaseline = 'bottom'` applies.
///
/// Canvas normalises the font's ascent/descent so they sum to the font size, so the
/// baseline sits `descent / (ascent + descent)` of an em above the bottom edge
/// (measured in Chrome: 0.333em for Baloo 2, 0.200em for Orbitron). SpriteKit has no
/// equivalent mode — `.bottom` aligns the rendered INK box, which is both a different
/// offset and string-dependent (a name with a descender would shift). Position with
/// `.baseline` plus this instead. Mirrored by `drawTextB` on Android TV.
func emBoxDescent(font: String, size: CGFloat) -> CGFloat {
    guard let f = UIFont(name: font, size: size) else { return 0 }
    let ascent = f.ascender, descent = -f.descender
    let box = ascent + descent
    return box > 0 ? size * (descent / box) : 0
}

extension SKLabelNode {
    /// Set text with an Orbitron weight, color, and letter-spacing. SKLabelNode
    /// has no native letter-spacing, so this routes through `attributedText`
    /// (which the web tracks out via CSS `letter-spacing`). `tracking` is in em
    /// of the font size (e.g. 0.15 == CSS 0.15em). Alignment modes still apply.
    func setStyledText(_ text: String, font: String, size: CGFloat, color: UIColor, tracking: CGFloat = 0) {
        let f = UIFont(name: font, size: size) ?? .systemFont(ofSize: size, weight: .bold)
        attributedText = NSAttributedString(string: text, attributes: [
            .font: f,
            .foregroundColor: color,
            .kern: size * tracking,
        ])
    }
}
