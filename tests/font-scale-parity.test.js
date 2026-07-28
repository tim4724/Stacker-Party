'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { THEME } = require('../public/shared/Theme.js');

// The board renderers on all three platforms size their HUD text off the same
// cellSize multipliers with the same px floors (web THEME.font). Each TV port
// keeps its own copy of those numbers — there is no shared constants file for
// them, because the canvas/SpriteKit renderers are per-shell by design.
//
// The copies drifted: both ports carried nameScale 0.7 / nameMinPx 18 against
// the web's 0.9 / 24, so in-game player names rendered at 78% of the reference
// on every TV. The name scale also drives textHeight(), so the drift moved
// board layout too, not just the glyphs.
//
// Nothing else can catch this. The engine golden tests gate simulation, not
// render metrics, and the gallery only surfaces it if a human eyeballs the
// columns side by side.
const ROOT = path.resolve(__dirname, '..');
const SWIFT_LAYOUT = fs.readFileSync(
  path.join(ROOT, 'appletv/Sources/HexStackerKit/Render/Theme.swift'), 'utf8');
const SWIFT_BOARD = fs.readFileSync(
  path.join(ROOT, 'appletv/Sources/HexStackerTV/BoardNode.swift'), 'utf8');
const KOTLIN = fs.readFileSync(
  path.join(ROOT, 'android/core/src/commonMain/kotlin/com/hexstacker/core/render/Theme.kt'), 'utf8');

function kotlinConst(name) {
  const m = new RegExp(`const val ${name}\\s*=\\s*([0-9.]+)`).exec(KOTLIN);
  assert.ok(m, `could not find "const val ${name}" in android core Theme.kt`);
  return parseFloat(m[1]);
}

// tvOS has no named font constants: the name metrics are literals, and it keeps
// TWO copies — one in textHeight() (which reserves the strip above the board and
// so drives cellSize) and one in BoardNode (which sizes the glyphs). Pin both, or
// half the port can drift while the test stays green.
function swiftNameMetrics(src, re, where) {
  const m = re.exec(src);
  assert.ok(m, `could not find the nameSize expression in ${where}`);
  return { minPx: parseFloat(m[1]), scale: parseFloat(m[2]) };
}

const SWIFT_SITES = [
  ['HexStackerKit Theme.swift (layout reservation)',
    () => swiftNameMetrics(SWIFT_LAYOUT, /let nameSize = max\(([0-9.]+), cs \* ([0-9.]+)\)/,
      'HexStackerKit Theme.swift')],
  ['BoardNode.swift (glyph size)',
    () => swiftNameMetrics(SWIFT_BOARD, /var nameSize: CGFloat \{ max\(([0-9.]+), cs \* ([0-9.]+)\) \}/,
      'BoardNode.swift')],
];

describe('board font metrics agree across web, tvOS and Android TV', function () {
  it('Android core Theme.Font mirrors web THEME.font', function () {
    assert.equal(kotlinConst('nameScale'), THEME.font.cellScale.name);
    assert.equal(kotlinConst('labelScale'), THEME.font.cellScale.label);
    assert.equal(kotlinConst('miniScale'), THEME.font.cellScale.mini);
    assert.equal(kotlinConst('nameMinPx'), THEME.font.minPx.name);
    assert.equal(kotlinConst('labelMinPx'), THEME.font.minPx.label);
  });

  for (const [where, read] of SWIFT_SITES) {
    it(`tvOS ${where} uses the web name scale + floor`, function () {
      const { minPx, scale } = read();
      assert.equal(scale, THEME.font.cellScale.name);
      assert.equal(minPx, THEME.font.minPx.name);
    });
  }
});
