import UIKit
import SpriteKit
import HexStackerKit

/// Renders one player's board + HUD from a PlayerSnapshot. Geometry comes from
/// HexStackerKit (canvas Y-down, board-local); this node converts to SpriteKit's
/// Y-up. Ported from public/display/BoardRenderer.js + UIRenderer.js.
final class BoardNode: SKNode {

    /// Piece spawn shapes as axial (q, r) offsets (server/Piece.js PIECES).
    static let pieceShapes: [String: [(q: Int, r: Int)]] = [
        "I3": [(-1, 0), (0, 0), (1, 0)],
        "V3": [(1, -1), (0, 0), (-1, 0)],
        "T3": [(1, 0), (0, 0), (0, 1)],
        "o":  [(-1, 0), (0, 0), (0, -1), (1, -1)],
        "d":  [(1, 0), (0, 0), (-1, 0), (-1, 1)],
        "b":  [(-1, 1), (0, 0), (1, -1), (1, 0)],
    ]

    private let geo: HexGeometry
    private let cs: CGFloat
    private let colorSlot: Int
    private let accent: RGB
    private let hudless: Bool

    private let bg = SKSpriteNode()
    private let lockedLayer = SKNode()
    private let ghostLayer = SKNode()
    private let previewLayer = SKNode()      // zigzag clear preview (cream highlight)
    private let nearClearLayer = SKNode()    // near-clear pulse (cream outline)
    private let pieceLayer = SKNode()
    private let clearingLayer = SKNode()     // clearing-cells glow during line clear
    private let hudLayer = SKNode()
    private let holdPieceLayer = SKNode()
    private let nextPieceLayer = SKNode()
    private let meterLayer = SKNode()
    private let effectsLayer = SKNode()
    private let disconnectLayer = SKNode()
    private var koShown = false
    private var chromeSprites: [(node: SKSpriteNode, w: CGFloat, h: CGFloat)] = []

    private let nameLabel = SKLabelNode()
    private let levelValue = SKLabelNode()
    private let linesValue = SKLabelNode()

    // Change keys for the per-frame rebuild gates. Plain Equatable structs, not
    // interpolated strings: the keys are compared every frame for every player,
    // and value comparisons are allocation-free Int compares.
    private struct PieceKey: Equatable { let blocks: [Cell]; let typeId: Int; let tier: Theme.StyleTier }
    private struct GhostKey: Equatable { let blocks: [Cell]; let typeId: Int }
    private struct PreviewKey: Equatable {
        let anchorCol: Int; let anchorRow: Int; let typeId: Int
        let rotation: Axial?   // first piece cell identifies the rotation (BoardRenderer cache key)
        let gridVersion: Int
    }

    private var lastGridVersion = -1
    private var lastTier: Theme.StyleTier?
    private var lastLevel = -1
    private var lastLines = -1
    private var lastHold: String??
    private var lastNext: [String] = []
    private var lastPending = -1
    private var lastPreview: PreviewKey?
    private var lastNearClearGV = -2
    private var lastClearingCells: [Cell] = []
    private var lastPiece: PieceKey?  // live piece: rebuild only when its cells/type/tier change
    private var lastGhost: GhostKey?  // ghost: rebuild only when its cells/type change
    private var shakeBase: CGPoint?   // layout position captured at shake start (no drift on re-trigger)

    private var boxSize: CGFloat { cs * 2.7 }           // miniSize * 4.5
    private var miniSize: CGFloat { cs * 0.6 }
    private var panelGap: CGFloat { cs * 0.25 }
    // Web THEME.font: cellScale.name 0.9 / minPx.name 24, cellScale.label 0.48 /
    // minPx.label 14 (public/shared/Theme.js). The name scale also sizes the
    // disconnect overlay labels, as it does on the web.
    private var nameSize: CGFloat { max(24, cs * 0.9) }
    private var labelSize: CGFloat { max(14, cs * 0.48) }
    private var valueSize: CGFloat { max(14, cs * 0.48 * 1.3) }

    init(geometry: HexGeometry, colorSlot: Int, name: String, hudless: Bool = false) {
        self.geo = geometry
        self.cs = CGFloat(geometry.cellSize)
        self.colorSlot = colorSlot
        self.accent = Theme.playerColor(slot: colorSlot)
        self.hudless = hudless
        super.init()

        let layers = [bg, lockedLayer, ghostLayer, previewLayer, nearClearLayer,
                      pieceLayer, clearingLayer, hudLayer, effectsLayer, disconnectLayer]
        for (i, layer) in layers.enumerated() {
            addChild(layer); layer.zPosition = CGFloat(i)
        }
        hudLayer.addChild(holdPieceLayer)
        hudLayer.addChild(nextPieceLayer)
        hudLayer.addChild(meterLayer)

        bg.anchorPoint = .zero
        bg.position = .zero

        if !hudless {
            buildName(name)
            buildPanels()
            buildLevelLines()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // Convert board-local Y-down distance-from-top to Y-up node-local Y.
    private func flipY(_ down: CGFloat) -> CGFloat { CGFloat(geo.boardHeight) - down }

    private func localPoint(col: Int, row: Int) -> CGPoint {
        let c = geo.hexCenter(col: col, row: row)
        return CGPoint(x: c.x, y: flipY(c.y))
    }

    func update(with p: PlayerSnapshot) {
        let tier = Theme.tier(forLevel: p.level)
        if tier != lastTier {
            bg.texture = makeBackgroundTexture(tier: tier)
            let pad = bgPad
            bg.size = CGSize(width: CGFloat(geo.boardWidth) + pad * 2, height: CGFloat(geo.boardHeight) + pad * 2)
            bg.position = CGPoint(x: -pad, y: -pad)   // keep board-local (0,0) aligned
            // Panels follow the well: neon-black at Lv 11+, tinted card otherwise.
            for c in chromeSprites { c.node.texture = makeChromeTexture(w: c.w, h: c.h, tier: tier) }
            lastTier = tier
            lastGridVersion = -1
        }
        if p.gridVersion != lastGridVersion {
            rebuildLocked(p.grid, tier: tier)
            lastGridVersion = p.gridVersion
        }
        rebuildGhost(p)
        rebuildPreview(p)
        rebuildNearClear(p)
        rebuildPiece(p, tier: tier)
        rebuildClearing(p)
        if !hudless { updateHUD(p, tier: tier) }
        // KO is shown as a red wash over the well + a KO label (web), not by
        // dimming the whole board (which would fade the name/HUD too).
        if !p.alive && !koShown {
            showKO(); koShown = true
        } else if p.alive && koShown {
            effectsLayer.childNode(withName: "ko")?.removeFromParent()
            effectsLayer.childNode(withName: "koWash")?.removeFromParent()
            koShown = false
        }
    }

    // MARK: - Animations (ported from public/display/Animations.js)

    /// Sparkle burst at a piece lock, only from the piece's EXPOSED bottom-edge
    /// blocks (those with no block directly below) — 5 sparkles each, matching the
    /// web's addHexLockFlash (occluded blocks emit nothing).
    func flashLock(_ blocks: [Cell], typeId: Int) {
        guard !blocks.isEmpty else { return }
        let color = UIColor(Theme.pieceColors[typeId] ?? RGB(255, 255, 255))
        var occupied = Set<Int>()
        let stride = geo.visibleRows + 2
        for b in blocks { occupied.insert(b.col * stride + (b.row + 1)) }
        for b in blocks where b.row >= 0 && b.row < geo.visibleRows {
            if occupied.contains(b.col * stride + (b.row + 1 + 1)) { continue }   // block directly below → not exposed
            let p = localPoint(col: b.col, row: b.row)
            for _ in 0..<5 {
                sparkle(at: CGPoint(x: p.x + CGFloat.random(in: -cs / 2...cs / 2), y: p.y - cs * 0.5),
                        color: color, sizeBase: 0.08, sizeRange: 0.10)   // lock sparkles run larger (web)
            }
        }
    }

    /// Cream flash + shrink on cleared cells, confetti on every clear (more +
    /// palette-colored on a triple), and a popup label for double/triple.
    func lineClearEffect(_ cells: [Cell], lines: Int) {
        for c in cells where c.row >= 0 && c.row < geo.visibleRows {
            let p = localPoint(col: c.col, row: c.row)
            // Clear flash in warm cream, matching the preview/near-clear vocabulary.
            // Alpha 0.9 on the node (== the old shape's 0.9 fill) fading to 0.
            let node = particleSprite(radius: CGFloat(geo.hexSize), color: SKTheme.textPrimary())
            node.alpha = 0.9
            node.position = p; node.zPosition = 9
            effectsLayer.addChild(node)
            node.run(.sequence([.group([.fadeOut(withDuration: 0.6), .scale(to: 0.1, duration: 0.6)]), .removeFromParent()]))
            // Confetti fires on EVERY clear (web addLineClearConfetti): warm cream
            // on single/double, palette-random on triple; triples throw more.
            let count = lines >= 3 ? 5 : 2
            for _ in 0..<count {
                let color = lines >= 3 ? UIColor(Theme.pieceColors[Int.random(in: 1...6)] ?? RGB(255, 255, 255)) : SKTheme.textPrimary()
                sparkle(at: p, color: color)
            }
        }
        if lines >= 2, let first = cells.first(where: { $0.row >= 0 }) {
            let p = localPoint(col: geo.cols / 2, row: first.row)
            let label = SKLabelNode(text: lines >= 3 ? tr("triple") : tr("double"))
            label.fontName = AppFont.black
            label.fontSize = cs * 0.73
            label.fontColor = lines >= 3 ? UIColor(RGB(0xFF, 0xE0, 0x66)) : SKTheme.textPrimary()
            label.position = p; label.zPosition = 11
            label.verticalAlignmentMode = .center
            effectsLayer.addChild(label)
            // Scale-pop (0.5 → 1.2 → 1.0) as it rises, matching the web addTextPopup.
            label.setScale(0.5)
            let pop = SKAction.sequence([.scale(to: 1.2, duration: 0.18), .scale(to: 1.0, duration: 0.12)])
            pop.timingMode = .easeOut
            label.run(.sequence([.group([pop,
                                         .moveBy(x: 0, y: cs * 1.7, duration: 1.2),
                                         .sequence([.wait(forDuration: 0.9), .fadeOut(withDuration: 0.3)])]),
                                 .removeFromParent()]))
        }
    }

    /// KO flash: a brief cream pop, then a danger-red flash, plus a 12-particle
    /// red sparkle burst (web addKO). The persistent dim + KO label live in showKO.
    func flashKO() {
        let w = CGFloat(geo.boardWidth), h = CGFloat(geo.boardHeight)
        // Clip the flashes to the board's zigzag outline (web addKO), so they don't
        // bleed into the rectangular corners outside the well.
        let flash = SKShapeNode(path: outlinePathFlipped(outset: 0))
        flash.fillColor = SKTheme.textPrimary(0.7); flash.strokeColor = .clear; flash.zPosition = 8
        effectsLayer.addChild(flash)
        flash.run(.sequence([.fadeOut(withDuration: 0.18), .removeFromParent()]))

        let red = SKShapeNode(path: outlinePathFlipped(outset: 0))
        red.fillColor = SKTheme.danger.withAlphaComponent(0.4); red.strokeColor = .clear; red.zPosition = 8
        effectsLayer.addChild(red)
        red.run(.sequence([.fadeOut(withDuration: 0.5), .removeFromParent()]))

        let koColor = UIColor(red: 0.8, green: 0.13, blue: 0.13, alpha: 1)
        for _ in 0..<12 {
            sparkle(at: CGPoint(x: CGFloat.random(in: 0...w), y: CGFloat.random(in: 0...h)), color: koColor)
        }
    }

    /// Incoming-garbage telegraph: a brief attacker-colored flash over the bottom
    /// `lines` meter cells, fading over ~1s (web drawGarbageIndicatorEffects).
    func flashGarbageIncoming(lines: Int, color: UIColor) {
        garbageFlash(lines: lines, color: color, duration: 1.0, maxAlpha: 0.94, stripeAlpha: 0.2)
    }

    /// Defence/cancel flash: a cream pulse over the bottom `lines` meter cells,
    /// fading over ~0.4s (web drawGarbageDefenceEffects, _getDefenceColor).
    func flashGarbageDefence(lines: Int) {
        garbageFlash(lines: lines, color: SKTheme.textPrimary(), duration: 0.4, maxAlpha: 0.9, stripeAlpha: 0.3)
    }

    private func garbageFlash(lines: Int, color: UIColor, duration: TimeInterval,
                              maxAlpha: CGFloat, stripeAlpha: CGFloat) {
        let n = min(max(lines, 1), geo.visibleRows)
        let meterX = -cs * 1.07          // same column as rebuildMeter
        let r = CGFloat(geo.sCell)
        // Cream top-edge bevel stripe on each meter cell (web _drawGarbageEffects).
        let topEdgeOffset = r * CGFloat(3.0.squareRoot()) / 2
        let stripeInset = r * 0.05, stripeH = r * 0.06, halfStripeW = r / 2
        let fillPath = CGMutablePath()
        let stripePath = CGMutablePath()
        for i in 0..<n {
            let row = geo.visibleRows - 1 - i
            let cyDown = geo.hexH * Double(row) + geo.hexH / 2
            let cy = flipY(cyDown)
            addHex(to: fillPath, center: CGPoint(x: meterX, y: cy), radius: r)
            let topEdgeY = cy + topEdgeOffset   // flat top edge is "up" in Y-up space
            stripePath.addRect(CGRect(x: meterX - halfStripeW, y: topEdgeY - stripeInset - stripeH,
                                      width: halfStripeW * 2, height: stripeH))
        }
        // Fill + stripe share one container so they fade together (web globalAlpha).
        let container = SKNode()
        container.alpha = maxAlpha
        container.zPosition = 9
        let fill = SKShapeNode(path: fillPath)
        fill.fillColor = color; fill.strokeColor = .clear
        container.addChild(fill)
        let stripe = SKShapeNode(path: stripePath)
        stripe.fillColor = SKTheme.textPrimary(stripeAlpha); stripe.strokeColor = .clear
        container.addChild(stripe)
        effectsLayer.addChild(container)
        container.run(.sequence([.fadeOut(withDuration: duration), .removeFromParent()]))
    }

    /// Per-board disconnect/rejoin overlay. `joinURL == nil` clears it.
    func setDisconnected(_ joinURL: String?) {
        disconnectLayer.removeAllChildren()
        guard let url = joinURL else { return }
        let boardW = CGFloat(geo.boardWidth), boardH = CGFloat(geo.boardHeight)

        // Dim only the well, clipped to the board's zigzag hex outline (web
        // _fillBoardArea), not the rectangular bounding box. Brand-plum at
        // overlay alpha — the canvas twin of --overlay-bg (never a black wash).
        let dim = SKShapeNode(path: outlinePathFlipped(outset: 0))
        dim.fillColor = UIColor(Theme.bgPrimary, alpha: CGFloat(Theme.Opacity.overlay))
        dim.strokeColor = .clear
        dim.zPosition = 0
        dim.isAntialiased = true
        disconnectLayer.addChild(dim)

        let center = CGPoint(x: boardW / 2, y: boardH / 2)
        // Match web drawDisconnectedOverlay: a name-scale "scan to rejoin" label
        // (cs·0.9, not the smaller label scale) below the QR, with the whole
        // QR-plus-label group vertically centered on the board. Web floors this
        // at 10px rather than the name label's 24.
        let rejoinLabelSize = max(10, cs * 0.9)
        if let qr = QRCode.image(for: url) {
            let side = min(boardW, boardH) * 0.5
            let pad = side * 0.06
            let outerSize = side + pad * 2
            let labelGap = rejoinLabelSize * 1.2
            let totalH = outerSize + labelGap + rejoinLabelSize
            let qrCenterY = center.y + totalH / 2 - outerSize / 2
            let labelCenterY = center.y - totalH / 2 + rejoinLabelSize / 2
            let card = SKShapeNode(rect: CGRect(x: center.x - side / 2 - pad, y: qrCenterY - side / 2 - pad,
                                                width: outerSize, height: outerSize),
                                   cornerRadius: side * 0.08)
            card.fillColor = .white; card.strokeColor = UIColor(accent, alpha: 0.5)
            card.lineWidth = 2
            card.zPosition = 1   // explicit z-order: ignoresSiblingOrder is on, so
            disconnectLayer.addChild(card)
            let sprite = SKSpriteNode(texture: SKTexture(image: qr))
            sprite.size = CGSize(width: side, height: side)
            sprite.position = CGPoint(x: center.x, y: qrCenterY)
            sprite.zPosition = 2   // the QR must sit above the white card
            disconnectLayer.addChild(sprite)
            let label = SKLabelNode()
            label.zPosition = 2
            label.verticalAlignmentMode = .center
            label.setStyledText(tr("scan_to_rejoin"), font: AppFont.semibold, size: rejoinLabelSize,
                                color: UIColor(accent), tracking: 0.10)
            label.position = CGPoint(x: center.x, y: labelCenterY)
            disconnectLayer.addChild(label)
        } else {
            let label = SKLabelNode()
            label.verticalAlignmentMode = .center
            label.setStyledText(tr("disconnected"), font: AppFont.semibold, size: max(10, cs * 0.9),
                                color: UIColor(accent), tracking: 0.10)
            label.position = center
            disconnectLayer.addChild(label)
        }
    }

    /// Garbage-received shake: a decaying sinusoid with a small vertical component
    /// over ~180 ms (web addGarbageShake), replacing a coarser, much stronger
    /// 3-step jitter. Peak offset ≈ 0.08·cs (web's 2.4 px at cs≈30).
    func shake() {
        if action(forKey: "shake") == nil { shakeBase = position }
        let base = shakeBase ?? position
        removeAction(forKey: "shake")
        let dur: TimeInterval = 0.18
        let intensityMax = cs * 0.08
        let anim = SKAction.customAction(withDuration: dur) { [weak self] _, elapsed in
            guard let self else { return }
            let progress = CGFloat(elapsed) / CGFloat(dur)
            let intensity = (1 - progress) * intensityMax
            let freq = 1 - progress * 0.5
            let ox = sin(progress * 18) * intensity * freq
            let oy = cos(progress * 20) * intensity * 0.18 * freq
            self.position = CGPoint(x: base.x + ox, y: base.y + oy)
        }
        run(.sequence([anim, .run { [weak self] in self?.position = base }]), withKey: "shake")
    }

    private func showKO() {
        // Brand-plum dim over the well (never a black/red-black wash) with the
        // danger red on top — the canvas twin of --overlay-bg (web A2).
        let wash = SKShapeNode(path: outlinePathFlipped(outset: 0))
        wash.name = "koWash"
        wash.fillColor = UIColor(Theme.bgPrimary, alpha: CGFloat(Theme.Opacity.overlay))
        wash.strokeColor = .clear
        wash.zPosition = 7
        effectsLayer.addChild(wash)

        let label = SKLabelNode(text: tr("ko"))
        label.name = "ko"
        label.fontName = AppFont.black
        label.fontSize = max(20, cs * 2)
        label.fontColor = SKTheme.danger
        label.position = CGPoint(x: CGFloat(geo.boardWidth) / 2, y: CGFloat(geo.boardHeight) / 2)
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        label.zPosition = 12
        effectsLayer.addChild(label)
    }

    /// Solid-fill hex sprite for effect particles: the shared white `flatHex`
    /// texture tinted per sprite, so every particle batches into one draw call
    /// regardless of color (an SKShapeNode each was an unbatched draw plus a
    /// CPU tessellation).
    private func particleSprite(radius: CGFloat, color: UIColor) -> SKSpriteNode {
        let tex = HexStampFactory.shared.flatHex
        let node = SKSpriteNode(texture: tex)
        let s = radius / HexStampFactory.flatHexCircumradius
        node.size = CGSize(width: tex.size().width * s, height: tex.size().height * s)
        node.color = color
        node.colorBlendFactor = 1
        return node
    }

    /// Hex confetti particle: launches with a random velocity, arcs under gravity,
    /// spins, shrinks and fades — matching the web `_addSparkle` (velocities in
    /// pt/s tuned so cs≈30 reproduces the web's 120/80 pixel constants).
    private func sparkle(at point: CGPoint, color: UIColor,
                         sizeBase: CGFloat = 0.05, sizeRange: CGFloat = 0.07,
                         duration: TimeInterval = 0.45) {
        let r = cs * (sizeBase + CGFloat.random(in: 0...sizeRange))
        let node = particleSprite(radius: r, color: color)
        node.position = point; node.zPosition = 10
        let vx = CGFloat.random(in: -0.5...0.5) * 4 * cs           // web (rand-0.5)·120 @ cs≈30
        let vyUp = (CGFloat.random(in: 0...1) * 2.67 + 0.67) * cs  // web rand·80+20, upward (Y-up)
        let gravity = 2.67 * cs                                    // web 80 px/s² downward
        let rotStart = CGFloat.random(in: 0...(2 * .pi))
        let rotSpeed = CGFloat.random(in: -3...3)                  // web (rand-0.5)·6 rad/s
        node.zRotation = rotStart
        effectsLayer.addChild(node)
        let anim = SKAction.customAction(withDuration: duration) { n, elapsed in
            let t = CGFloat(elapsed), progress = min(1, CGFloat(elapsed) / CGFloat(duration))
            n.position = CGPoint(x: point.x + vx * t, y: point.y + vyUp * t - gravity * t * t)
            n.setScale(1 - progress * 0.5)
            n.alpha = 1 - progress
            n.zRotation = rotStart + rotSpeed * t
        }
        node.run(.sequence([anim, .removeFromParent()]))
    }

    // MARK: - Board cells

    private func rebuildLocked(_ grid: [[Int]], tier: Theme.StyleTier) {
        lockedLayer.removeAllChildren()
        for (row, cols) in grid.enumerated() {
            for (col, value) in cols.enumerated() where value != 0 {
                let sprite = SKSpriteNode(texture: stamp(value, tier))
                sprite.position = localPoint(col: col, row: row)
                lockedLayer.addChild(sprite)
            }
        }
    }

    private func rebuildPiece(_ p: PlayerSnapshot, tier: Theme.StyleTier) {
        guard let piece = p.currentPiece, p.alive else {
            if !pieceLayer.children.isEmpty { pieceLayer.removeAllChildren() }
            lastPiece = nil
            return
        }
        // The piece re-renders every frame; skip the node churn unless its cells,
        // type, or the style tier (stamp) actually changed.
        let key = PieceKey(blocks: piece.blocks, typeId: piece.typeId, tier: tier)
        guard key != lastPiece else { return }
        lastPiece = key
        pieceLayer.removeAllChildren()
        for block in piece.blocks where block.row >= 0 && block.row < geo.visibleRows {
            let sprite = SKSpriteNode(texture: stamp(piece.typeId, tier))
            sprite.position = localPoint(col: block.col, row: block.row)
            pieceLayer.addChild(sprite)
        }
    }

    private func rebuildGhost(_ p: PlayerSnapshot) {
        guard let ghost = p.ghost, let piece = p.currentPiece, p.alive else {
            if !ghostLayer.children.isEmpty { ghostLayer.removeAllChildren() }
            lastGhost = nil
            return
        }
        let key = GhostKey(blocks: ghost.blocks, typeId: piece.typeId)
        guard key != lastGhost else { return }
        lastGhost = key
        ghostLayer.removeAllChildren()
        let g = ColorMath.ghost(Theme.pieceColors[piece.typeId] ?? RGB(255, 255, 255))
        let path = CGMutablePath()
        for block in ghost.blocks where block.row >= 0 && block.row < geo.visibleRows {
            addHex(to: path, center: localPoint(col: block.col, row: block.row), radius: CGFloat(geo.sCell))
        }
        let node = SKShapeNode(path: path)
        node.fillColor = UIColor(g.rgb, alpha: CGFloat(g.fillAlpha))
        node.strokeColor = UIColor(g.rgb, alpha: CGFloat(g.outlineAlpha))
        node.lineWidth = CGFloat(geo.gridLineWidth)
        node.isAntialiased = true
        ghostLayer.addChild(node)
    }

    private func stamp(_ typeId: Int, _ tier: Theme.StyleTier) -> SKTexture {
        HexStampFactory.shared.stamp(tier: tier,
                                     color: Theme.pieceColors[typeId] ?? RGB(128, 128, 128),
                                     size: CGFloat(geo.stampHeight))
    }

    // MARK: - Clear preview / near-clear pulse / clearing glow (BoardRenderer.js)

    /// Zigzag clear preview: highlight the cells that WILL clear when the ghost
    /// piece lands. Recomputed only when the ghost anchor/type/rotation or the
    /// locked stack changes (matches BoardRenderer's cache key).
    private func rebuildPreview(_ p: PlayerSnapshot) {
        guard p.alive, let ghost = p.ghost, let piece = p.currentPiece else {
            if !previewLayer.children.isEmpty { previewLayer.removeAllChildren() }
            lastPreview = nil
            return
        }
        let key = PreviewKey(anchorCol: ghost.anchorCol, anchorRow: ghost.anchorRow,
                             typeId: piece.typeId, rotation: piece.cells.first,
                             gridVersion: p.gridVersion)
        guard key != lastPreview else { return }
        lastPreview = key
        previewLayer.removeAllChildren()

        let grid = p.grid
        let stride = grid.count + 2
        var ghostSet = Set<Int>()
        for b in ghost.blocks { ghostSet.insert(b.col * stride + (b.row + 1)) }
        func gkey(_ c: Int, _ r: Int) -> Int { c * stride + (r + 1) }
        let isFilled: (Int, Int) -> Bool = { grid[$1][$0] > 0 || ghostSet.contains(gkey($0, $1)) }
        let ghostContributes: (Int, Int) -> Bool = { grid[$1][$0] == 0 && ghostSet.contains(gkey($0, $1)) }
        let cells = Zigzag.clearable(cols: geo.cols, totalRows: grid.count,
                                     isFilled: isFilled, ghostContributes: ghostContributes)
        guard !cells.isEmpty else { return }
        let path = CGMutablePath()
        for c in cells where c.row >= 0 && c.row < geo.visibleRows {
            addHex(to: path, center: localPoint(col: c.col, row: c.row), radius: CGFloat(geo.hexSize))
        }
        let node = SKShapeNode(path: path)
        // Clear-related effects speak cream (text.primary), not pure white —
        // warm flashes sit better on the plum surfaces.
        node.fillColor = SKTheme.textPrimary(0.2)
        node.strokeColor = SKTheme.textPrimary(0.4)
        node.lineWidth = CGFloat(geo.gridLineWidth)
        node.isAntialiased = true
        previewLayer.addChild(node)
    }

    /// Near-clear pulse: a pulsing white outline on empty cells one drop away
    /// from completing a zigzag. Depends only on the locked stack (cached by
    /// gridVersion); hidden during the line-clear animation so stale positions
    /// don't flash mid-gravity.
    private func rebuildNearClear(_ p: PlayerSnapshot) {
        let clearing = (p.clearingCells?.isEmpty == false)
        guard p.alive, !clearing else {
            nearClearLayer.isHidden = true
            nearClearLayer.removeAllChildren()
            lastNearClearGV = -2   // force a fresh rebuild once play resumes
            return
        }
        nearClearLayer.isHidden = false
        guard p.gridVersion != lastNearClearGV else { return }
        lastNearClearGV = p.gridVersion
        nearClearLayer.removeAllChildren()

        let grid = p.grid
        let cells = Zigzag.nearClear(cols: geo.cols, totalRows: grid.count, isFilled: { grid[$1][$0] > 0 })
        guard !cells.isEmpty else { return }
        let path = CGMutablePath()
        for c in cells where c.row >= 0 && c.row < geo.visibleRows {
            addHex(to: path, center: localPoint(col: c.col, row: c.row), radius: CGFloat(geo.sCell))
        }
        let node = SKShapeNode(path: path)
        node.fillColor = .clear
        node.strokeColor = UIColor(Theme.nearClear)
        node.lineWidth = CGFloat(geo.gridLineWidth) * 1.5
        node.isAntialiased = true
        node.alpha = 0.6
        node.run(.repeatForever(.sequence([.fadeAlpha(to: 0.8, duration: 0.3),
                                           .fadeAlpha(to: 0.4, duration: 0.3)])))
        nearClearLayer.addChild(node)
    }

    /// Clearing-cells glow: a pulsing white fill on the cells currently mid
    /// clear-animation (driven by snapshot.clearingCells).
    private func rebuildClearing(_ p: PlayerSnapshot) {
        let cells = (p.alive ? p.clearingCells : nil) ?? []
        guard cells != lastClearingCells else { return }
        lastClearingCells = cells
        clearingLayer.removeAllChildren()
        guard !cells.isEmpty else { return }
        let path = CGMutablePath()
        for c in cells where c.row >= 0 && c.row < geo.visibleRows {
            addHex(to: path, center: localPoint(col: c.col, row: c.row), radius: CGFloat(geo.sCell))
        }
        let node = SKShapeNode(path: path)
        node.fillColor = SKTheme.textPrimary(0.4)
        node.strokeColor = .clear
        node.isAntialiased = true
        node.run(.repeatForever(.sequence([.fadeAlpha(to: 0.3, duration: 0.15),
                                           .fadeAlpha(to: 0.5, duration: 0.15)])))
        clearingLayer.addChild(node)
    }

    // MARK: - HUD (name / hold / next / level / lines / garbage)

    private func buildName(_ name: String) {
        // Identity voice (Baloo 2), not the HUD face — same split as the web,
        // where UIRenderer's `_fontName` uses getBrandFont() at weight 700.
        nameLabel.fontName = AppFont.brandBold
        nameLabel.fontSize = nameSize
        nameLabel.fontColor = UIColor(accent)
        nameLabel.text = name
        nameLabel.horizontalAlignmentMode = .left
        // Web anchors the em-square bottom (ctx.textBaseline = 'bottom') at cs*0.2
        // above the board. SpriteKit's .bottom is the ink box, so drive the baseline
        // directly and lift it by the em-box descent (see emBoxDescent).
        nameLabel.verticalAlignmentMode = .baseline
        nameLabel.position = CGPoint(
            x: cs * 0.07,
            y: CGFloat(geo.boardHeight) + cs * 0.2 + emBoxDescent(font: AppFont.brandBold, size: nameSize))
        nameLabel.zPosition = 1
        hudLayer.addChild(nameLabel)
    }

    private func buildPanels() {
        // HOLD panel (left of board).
        let holdCenterX = -(panelGap + boxSize / 2)
        let boxTopDown = labelSize + cs * 0.2
        let holdBoxCenterY = flipY(boxTopDown + boxSize / 2)
        addChrome(centerX: holdCenterX, centerY: holdBoxCenterY, w: boxSize, h: boxSize)
        addPanelLabel(tr("hold"), centerX: holdCenterX, topDown: 0)
        holdPieceLayer.position = CGPoint(x: holdCenterX, y: holdBoxCenterY)

        // NEXT panel (right of board): up to 3 pieces stacked.
        let nextCenterX = CGFloat(geo.boardWidth) + panelGap + boxSize / 2
        let spacing = miniSize * 3.5
        let nextBoxH = spacing * 3
        let nextBoxCenterY = flipY(boxTopDown + nextBoxH / 2)
        addChrome(centerX: nextCenterX, centerY: nextBoxCenterY, w: boxSize, h: nextBoxH)
        addPanelLabel(tr("next"), centerX: nextCenterX, topDown: 0)
        nextPieceLayer.position = CGPoint(x: nextCenterX, y: flipY(boxTopDown))
    }

    private func buildLevelLines() {
        let x = CGFloat(geo.boardWidth) + panelGap
        let spacing = miniSize * 3.5
        let nextBoxH = spacing * 3
        let belowNextDown = (labelSize + cs * 0.2) + nextBoxH + cs * 0.5
        let rowHeight = labelSize + valueSize + cs * 0.4
        addStatLabel(tr("level"), x: x, topDown: belowNextDown)
        styleValue(levelValue, x: x, topDown: belowNextDown + labelSize + cs * 0.1)
        addStatLabel(tr("lines"), x: x, topDown: belowNextDown + rowHeight)
        styleValue(linesValue, x: x, topDown: belowNextDown + rowHeight + labelSize + cs * 0.1)
        hudLayer.addChild(levelValue)
        hudLayer.addChild(linesValue)
    }

    private func updateHUD(_ p: PlayerSnapshot, tier: Theme.StyleTier) {
        if p.level != lastLevel { levelValue.text = "\(p.level)"; lastLevel = p.level }
        if p.lines != lastLines { linesValue.text = "\(p.lines)"; lastLines = p.lines }

        if lastHold == nil || lastHold! != p.holdPiece {
            holdPieceLayer.removeAllChildren()
            if let hold = p.holdPiece {
                for n in miniPieceNodes(type: hold, center: .zero, tier: tier) { holdPieceLayer.addChild(n) }
            }
            lastHold = .some(p.holdPiece)
        }

        if p.nextPieces != lastNext {
            nextPieceLayer.removeAllChildren()
            let spacing = miniSize * 3.5
            for (i, type) in p.nextPieces.prefix(3).enumerated() {
                let cy = -(CGFloat(i) * spacing + spacing / 2)   // Y-down from box top, flipped
                let alpha: CGFloat = i == 0 ? 1.0 : 0.7 - CGFloat(i) * 0.06
                for n in miniPieceNodes(type: type, center: CGPoint(x: 0, y: cy), tier: tier) {
                    n.alpha = alpha
                    nextPieceLayer.addChild(n)
                }
            }
            lastNext = p.nextPieces
        }

        if p.pendingGarbage != lastPending {
            rebuildMeter(p.pendingGarbage)
            lastPending = p.pendingGarbage
        }
    }

    private func rebuildMeter(_ pending: Int) {
        meterLayer.removeAllChildren()
        guard pending > 0 else { return }
        let lines = min(pending, geo.visibleRows)
        let meterX = -cs * 1.07
        let r = CGFloat(geo.sCell)
        for i in 0..<lines {
            let row = geo.visibleRows - 1 - i
            let cyDown = geo.hexH * Double(row) + geo.hexH / 2
            let path = CGMutablePath()
            addHex(to: path, center: CGPoint(x: meterX, y: flipY(cyDown)), radius: r)
            let node = SKShapeNode(path: path)
            // Garbage meter speaks cream (A2), not pure white.
            node.fillColor = SKTheme.textPrimary(0.10)
            node.strokeColor = SKTheme.textPrimary(0.6)
            node.lineWidth = CGFloat(geo.gridLineWidth)
            meterLayer.addChild(node)
        }
    }

    // MARK: - Mini piece

    private func miniPieceNodes(type: String, center: CGPoint, tier: Theme.StyleTier) -> [SKSpriteNode] {
        guard let cells = Self.pieceShapes[type] else { return [] }
        // Axial (q,r) -> offset (col,row), odd-q (anchor at origin).
        let offsets = cells.map { (col: $0.q, row: $0.r + (($0.q - ($0.q & 1)) >> 1)) }
        let minC = offsets.map { $0.col }.min() ?? 0
        let minR = offsets.map { $0.row }.min() ?? 0
        let hexS = miniSize * 0.58
        let drawS = hexS * (1 - 0.03 * 2)
        let hexH = 3.0.squareRoot() * hexS
        let colW = 1.5 * hexS

        // Raw centers in mini Y-down space.
        let pts: [CGPoint] = offsets.map { o in
            CGPoint(x: colW * CGFloat(o.col - minC) + hexS,
                    y: hexH * (CGFloat(o.row - minR) + 0.5 * CGFloat(o.col & 1)) + hexH / 2)
        }
        let xs = pts.map { $0.x }, ys = pts.map { $0.y }
        let pcx = ((xs.min() ?? 0) + (xs.max() ?? 0)) / 2
        let pcy = ((ys.min() ?? 0) + (ys.max() ?? 0)) / 2

        let typeId = EngineConstants.pieceTypeToId[type] ?? 0
        let texture = HexStampFactory.shared.stamp(tier: tier,
                                                   color: Theme.pieceColors[typeId] ?? RGB(255, 255, 255),
                                                   size: 3.0.squareRoot() * drawS)
        var nodes: [SKSpriteNode] = []
        for pt in pts {
            let sprite = SKSpriteNode(texture: texture)
            // Center the piece on `center`, flipping y (mini space is Y-down).
            sprite.position = CGPoint(x: center.x + (pt.x - pcx), y: center.y - (pt.y - pcy))
            nodes.append(sprite)
        }
        return nodes
    }

    // MARK: - Panel chrome + labels

    private func addChrome(centerX: CGFloat, centerY: CGFloat, w: CGFloat, h: CGFloat) {
        let sprite = SKSpriteNode(texture: makeChromeTexture(w: w, h: h, tier: .normal))
        sprite.size = CGSize(width: w, height: h)
        sprite.position = CGPoint(x: centerX, y: centerY)
        sprite.zPosition = -1
        hudLayer.addChild(sprite)
        chromeSprites.append((sprite, w, h))
    }

    // Panel/stat labels: quiet uppercase metadata — cream at label alpha with
    // the wide 0.2em tracking of .card-level__heading (A2).
    private func addPanelLabel(_ text: String, centerX: CGFloat, topDown: CGFloat) {
        let label = SKLabelNode()
        label.horizontalAlignmentMode = .center
        label.verticalAlignmentMode = .top
        label.setStyledText(text, font: AppFont.name, size: labelSize,
                            color: SKTheme.textPrimary(0.6), tracking: 0.2)
        label.position = CGPoint(x: centerX, y: flipY(topDown))
        hudLayer.addChild(label)
    }

    private func addStatLabel(_ text: String, x: CGFloat, topDown: CGFloat) {
        let label = SKLabelNode()
        label.horizontalAlignmentMode = .left
        label.verticalAlignmentMode = .top
        label.setStyledText(text, font: AppFont.name, size: labelSize,
                            color: SKTheme.textPrimary(0.6), tracking: 0.2)
        label.position = CGPoint(x: x, y: flipY(topDown))
        hudLayer.addChild(label)
    }

    private func styleValue(_ label: SKLabelNode, x: CGFloat, topDown: CGFloat) {
        label.fontName = AppFont.name
        label.fontSize = valueSize
        label.fontColor = SKTheme.textPrimary()
        label.horizontalAlignmentMode = .left
        label.verticalAlignmentMode = .top
        label.position = CGPoint(x: x, y: flipY(topDown))
    }

    private func makeChromeTexture(w: CGFloat, h: CGFloat, tier: Theme.StyleTier) -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w, height: h))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            let rect = CGRect(x: 0, y: 0, width: w, height: h)
            let radius = cs * 0.2
            let path = UIBezierPath(roundedRect: rect, cornerRadius: radius).cgPath
            ctx.addPath(path); ctx.clip()
            if case .neonFlat = tier {
                // Neon tier: pure black fill to match the black well. The black
                // fill can't carry identity, so keep the thin player-tinted rim
                // stroke (mirrors the neon board's bright wall).
                ctx.setFillColor(UIColor.black.cgColor)
                ctx.fill(rect)
                ctx.resetClip()
                ctx.addPath(path)
                ctx.setStrokeColor(UIColor(accent, alpha: 0.15).cgColor)
                ctx.setLineWidth(max(1, cs * 0.04 * 0.6))
                ctx.strokePath()
            } else {
                // Tonal fill — 20% player color mixed into the card surface
                // carries identity on its own (same as .player-card in
                // theme.css). Flat: no gradient, no bevel, no border.
                let cardR = 0x2A as CGFloat, cardG = 0x25 as CGFloat, cardB = 0x40 as CGFloat
                let fill = UIColor(red: (CGFloat(accent.r) * 0.2 + cardR * 0.8) / 255,
                                   green: (CGFloat(accent.g) * 0.2 + cardG * 0.8) / 255,
                                   blue: (CGFloat(accent.b) * 0.2 + cardB * 0.8) / 255, alpha: 1)
                ctx.setFillColor(fill.cgColor)
                ctx.fill(rect)
            }
        }
        return SKTexture(image: image)
    }

    // MARK: - Board background bake (well + grid)

    /// Texture padding so the outset wall stroke + grid-line/AA halo aren't
    /// clipped at the texture edges (the well content runs to the board bounds).
    private var bgPad: CGFloat { ceil(CGFloat(geo.wallOutset + geo.borderWidth / 2)) + 2 }

    private func makeBackgroundTexture(tier: Theme.StyleTier) -> SKTexture {
        let w = CGFloat(geo.boardWidth), h = CGFloat(geo.boardHeight)
        let pad = bgPad
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w + pad * 2, height: h + pad * 2))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            ctx.setFillColor(UIColor(Theme.bgPrimary).cgColor)
            ctx.fill(CGRect(x: 0, y: 0, width: w + pad * 2, height: h + pad * 2))
            // Board-local origin at (pad, pad) so the outset wall has room.
            ctx.translateBy(x: pad, y: pad)

            // Well fill clipped to the real board outline (computeHexOutlineVerts).
            // Neon → pure black for max contrast; otherwise a flat recessed
            // deeper-plum well (bg.board) + player tint — the same socket
            // treatment as the lobby's empty player slots (gradient dropped).
            ctx.saveGState()
            ctx.addPath(outlinePath(outset: 0)); ctx.clip()
            if case .neonFlat = tier {
                ctx.setFillColor(UIColor.black.cgColor)
                ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            } else {
                ctx.setFillColor(UIColor(Theme.bgBoard).cgColor)
                ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
                ctx.setFillColor(UIColor(accent, alpha: CGFloat(Theme.Opacity.boardTint)).cgColor)
                ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            }
            ctx.restoreGState()

            // Grid lines: stroke each cell hex with the player accent. Adjacent
            // hexes share edges, so stroking each cell at gridAlpha would paint the
            // interior edges TWICE and roughly double their alpha. The web avoids
            // this by drawing the whole grid opaque then compositing it once at
            // gridAlpha; the CoreGraphics analog is a transparency layer that
            // composites all the (opaque) strokes as a single group at gridAlpha.
            let lum = ColorMath.luminance01(accent)
            let gridAlpha = Theme.Opacity.grid + (1 - lum) * 0.08
            ctx.saveGState()
            ctx.setAlpha(CGFloat(gridAlpha))
            ctx.setStrokeColor(UIColor(accent, alpha: 1).cgColor)
            ctx.setLineWidth(CGFloat(geo.gridLineWidth))
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            for row in 0..<geo.visibleRows {
                for col in 0..<geo.cols {
                    let c = geo.hexCenter(col: col, row: row)
                    let cell = CGMutablePath()
                    addHex(to: cell, center: CGPoint(x: c.x, y: c.y), radius: CGFloat(geo.hexSize))
                    ctx.addPath(cell); ctx.strokePath()
                }
            }
            ctx.endTransparencyLayer()
            ctx.restoreGState()

            // Outer wall: stroke the outset board outline — a calmer player
            // wall, then a crisp warm-paper hairline on top so the well gets
            // the same socket rim as the lobby's empty player slots.
            ctx.addPath(outlinePath(outset: geo.wallOutset))
            ctx.setStrokeColor(UIColor(accent, alpha: CGFloat(Theme.Opacity.wall)).cgColor)
            ctx.setLineWidth(CGFloat(geo.borderWidth))
            ctx.strokePath()
            ctx.addPath(outlinePath(outset: geo.wallOutset))
            ctx.setStrokeColor(UIColor(Theme.hairline, alpha: CGFloat(Theme.Opacity.hairline)).cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }
        return SKTexture(image: image)
    }

    private func outlinePath(outset: Double) -> CGMutablePath {
        let verts = geo.outlineVertices(outset: outset)
        let path = CGMutablePath()
        guard let first = verts.first else { return path }
        path.move(to: CGPoint(x: first.x, y: first.y))
        for v in verts.dropFirst() { path.addLine(to: CGPoint(x: v.x, y: v.y)) }
        path.closeSubpath()
        return path
    }

    /// The board outline in the node's Y-up space (for SKShapeNode overlays like
    /// the KO wash; `outlinePath` is in the texture's Y-down space).
    private func outlinePathFlipped(outset: Double) -> CGMutablePath {
        let verts = geo.outlineVertices(outset: outset)
        let path = CGMutablePath()
        guard let first = verts.first else { return path }
        path.move(to: CGPoint(x: first.x, y: flipY(CGFloat(first.y))))
        for v in verts.dropFirst() { path.addLine(to: CGPoint(x: v.x, y: flipY(CGFloat(v.y)))) }
        path.closeSubpath()
        return path
    }

    private func addHex(to path: CGMutablePath, center: CGPoint, radius: CGFloat) {
        let v = HexGeometry.unitVertices
        path.move(to: CGPoint(x: center.x + radius * CGFloat(v[0].x), y: center.y + radius * CGFloat(v[0].y)))
        for i in 1..<6 {
            path.addLine(to: CGPoint(x: center.x + radius * CGFloat(v[i].x), y: center.y + radius * CGFloat(v[i].y)))
        }
        path.closeSubpath()
    }
}
