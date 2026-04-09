(function() {
  // --- Tetromino definitions (relative cells) ---
  const COLORS = {
    I: '#EE4444',  // Red
    T: '#9B59F0',  // Violet
    O: '#FFD700',  // Gold
    S: '#7FFF00',  // Lime
    Z: '#FF1493',  // Pink
    L: '#FF8C00',  // Amber
    J: '#00CED1',  // Teal
  };

  // Each piece: array of [col, row] offsets
  const SHAPES = {
    I: [[0,0],[1,0],[2,0],[3,0]],
    T: [[0,0],[1,0],[2,0],[1,1]],
    O: [[0,0],[1,0],[0,1],[1,1]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    L: [[0,0],[0,1],[0,2],[1,2]],
    J: [[1,0],[1,1],[1,2],[0,2]],
  };

  const PIECE_TYPES = ['Z','I','S','T','L','O','J'];

  // Hex piece definitions (axial coords) — multi-cell pieces, not just singles
  const HEX_PIECES = {
    hT: [[-1,0],[0,0],[1,0],[0,-1]],       // T-shape
    hO: [[-1,0],[0,0],[0,-1],[1,-1]],       // O-shape (compact zigzag)
    hL: [[-1,0],[0,0],[1,0],[1,-1]],        // L-shape
    hI: [[-1,0],[0,0],[1,0],[2,0]],         // I-shape (4 in a line)
    hS: [[-2,1],[-1,1],[0,0],[1,0]],        // S-shape (wider zigzag)
  };
  const HEX_PIECE_COLORS = {
    hI: '#EE4444', hT: '#00CED1', hL: '#FFD700', hO: '#7FFF00', hS: '#9B59F0',
  };
  const HEX_PIECE_TYPES = Object.keys(HEX_PIECES);
  const HEX_SOLO_COLORS = ['#00CED1','#FFD700','#9B59F0','#FF1493'];

  // --- Layout presets ---
  // pieces: {x, y, rot} for each of 7 classic pieces
  // hexPieces: {type, x, y, size} for multi-cell hex pieces
  // hexSolo: {x, y, size, color} for single hex cells
  // Presets — pieces in outer bands, clear center for text (~y:160-350)
  // Each piece gets its own zone to avoid overlap.
  // At size=48: tetromino ≈ 200×100px, hex piece ≈ 120×80px
  // Grid zones: TL(0-250,0-130) TR(260-512,0-130) BL(0-250,370-512) BR(260-512,370-512)
  //             ML(0-100,130-370) MR(410-512,130-370)
  const PRESETS = {
    // --- CORNERS 2+2 ---
    c2a: {
      pieces: [{x:10,y:15,rot:-10},{x:310,y:430,rot:8}],
      hexPieces: [{type:'hT',x:340,y:10,size:14},{type:'hS',x:10,y:390,size:14}],
      hexSolo: [],
    },
    c2b: {
      pieces: [{x:10,y:430,rot:8},{x:310,y:15,rot:-8}],
      hexPieces: [{type:'hI',x:10,y:10,size:14},{type:'hL',x:330,y:400,size:14}],
      hexSolo: [],
    },
    // --- CORNERS 3+3 ---
    c3a: {
      pieces: [{x:10,y:15,rot:-10},{x:310,y:15,rot:8},{x:10,y:430,rot:6}],
      hexPieces: [{type:'hT',x:330,y:400,size:14},{type:'hS',x:10,y:110,size:13},{type:'hI',x:340,y:110,size:12}],
      hexSolo: [],
    },
    c3b: {
      pieces: [{x:10,y:15,rot:-8},{x:310,y:430,rot:10},{x:310,y:15,rot:6}],
      hexPieces: [{type:'hL',x:10,y:400,size:14},{type:'hT',x:10,y:110,size:13},{type:'hF',x:340,y:110,size:12}],
      hexSolo: [],
    },
    // --- CORNERS 4+4 ---
    c4a: {
      pieces: [{x:10,y:15,rot:-10},{x:310,y:15,rot:8},{x:10,y:430,rot:6},{x:310,y:430,rot:-8}],
      hexPieces: [{type:'hT',x:10,y:110,size:14},{type:'hS',x:340,y:110,size:13},{type:'hL',x:10,y:370,size:12},{type:'hI',x:340,y:370,size:12}],
      hexSolo: [],
    },
    c4b: {
      pieces: [{x:10,y:15,rot:-8},{x:310,y:15,rot:10},{x:10,y:430,rot:8},{x:310,y:430,rot:-6}],
      hexPieces: [{type:'hI',x:160,y:10,size:14},{type:'hT',x:160,y:410,size:14},{type:'hS',x:10,y:120,size:12},{type:'hL',x:350,y:120,size:12}],
      hexSolo: [],
    },
    c4sym: {
      pieces: [{x:10,y:15,rot:-6},{x:320,y:15,rot:6},{x:10,y:430,rot:6},{x:320,y:430,rot:-6}],
      hexPieces: [{type:'hT',x:10,y:110,size:14},{type:'hS',x:350,y:110,size:14},{type:'hL',x:10,y:370,size:12},{type:'hI',x:350,y:370,size:12}],
      hexSolo: [],
    },
    // --- CORNERS 5+5 ---
    c5a: {
      pieces: [{x:10,y:15,rot:-10},{x:310,y:15,rot:8},{x:10,y:430,rot:6},{x:310,y:430,rot:-8},{x:155,y:430,rot:4}],
      hexPieces: [{type:'hT',x:10,y:110,size:14},{type:'hS',x:350,y:110,size:13},{type:'hL',x:155,y:10,size:12},{type:'hI',x:10,y:370,size:12},{type:'hF',x:350,y:370,size:11}],
      hexSolo: [],
    },
    c5b: {
      pieces: [{x:10,y:15,rot:-8},{x:310,y:15,rot:10},{x:10,y:430,rot:6},{x:310,y:430,rot:-10},{x:155,y:15,rot:4}],
      hexPieces: [{type:'hI',x:10,y:110,size:14},{type:'hT',x:350,y:110,size:13},{type:'hS',x:155,y:410,size:12},{type:'hL',x:10,y:370,size:11},{type:'hF',x:350,y:370,size:11}],
      hexSolo: [],
    },
    // --- CORNERS 6+6 ---
    c6a: {
      pieces: [{x:10,y:15,rot:-10},{x:175,y:15,rot:4},{x:330,y:15,rot:8},{x:10,y:430,rot:6},{x:175,y:430,rot:-4},{x:330,y:430,rot:-8}],
      hexPieces: [{type:'hT',x:10,y:105,size:13},{type:'hS',x:175,y:105,size:12},{type:'hL',x:350,y:105,size:12},{type:'hI',x:10,y:370,size:12},{type:'hF',x:175,y:375,size:11},{type:'hT',x:350,y:370,size:11}],
      hexSolo: [],
    },
    c6b: {
      pieces: [{x:10,y:15,rot:-8},{x:330,y:15,rot:8},{x:10,y:430,rot:6},{x:330,y:430,rot:-8},{x:10,y:105,rot:-5},{x:330,y:105,rot:5}],
      hexPieces: [{type:'hI',x:160,y:5,size:13},{type:'hT',x:160,y:410,size:13},{type:'hS',x:10,y:370,size:12},{type:'hL',x:350,y:370,size:12},{type:'hF',x:160,y:105,size:11},{type:'hS',x:160,y:370,size:11}],
      hexSolo: [],
    },
    // --- CASCADE 2+2 ---
    d2a: {
      pieces: [{x:10,y:15,rot:-5},{x:310,y:430,rot:5}],
      hexPieces: [{type:'hT',x:340,y:10,size:14},{type:'hS',x:10,y:400,size:14}],
      hexSolo: [],
    },
    // --- CASCADE 3+3 ---
    d3a: {
      pieces: [{x:10,y:15,rot:-5},{x:110,y:80,rot:-3},{x:310,y:430,rot:5}],
      hexPieces: [{type:'hT',x:290,y:370,size:14},{type:'hL',x:340,y:10,size:13},{type:'hI',x:10,y:400,size:12}],
      hexSolo: [],
    },
    // --- CASCADE 4+4 ---
    d4a: {
      pieces: [{x:10,y:15,rot:-5},{x:110,y:80,rot:-3},{x:290,y:380,rot:3},{x:360,y:430,rot:5}],
      hexPieces: [{type:'hT',x:340,y:10,size:14},{type:'hS',x:10,y:400,size:13},{type:'hL',x:340,y:110,size:12},{type:'hI',x:10,y:360,size:12}],
      hexSolo: [],
    },
    d4rev: {
      pieces: [{x:310,y:15,rot:5},{x:250,y:80,rot:3},{x:80,y:380,rot:-3},{x:10,y:430,rot:-5}],
      hexPieces: [{type:'hS',x:10,y:10,size:14},{type:'hT',x:330,y:400,size:13},{type:'hI',x:10,y:110,size:12},{type:'hL',x:340,y:360,size:12}],
      hexSolo: [],
    },
    // --- TOP & BOTTOM 2+2 ---
    tb2a: {
      pieces: [{x:10,y:50,rot:-6},{x:310,y:390,rot:6}],
      hexPieces: [{type:'hT',x:200,y:45,size:14},{type:'hS',x:170,y:360,size:14}],
      hexSolo: [],
    },
    // --- TOP & BOTTOM 3+3 ---
    tb3a: {
      pieces: [{x:10,y:50,rot:-8},{x:310,y:50,rot:6},{x:155,y:390,rot:4}],
      hexPieces: [{type:'hT',x:170,y:45,size:14},{type:'hS',x:10,y:360,size:13},{type:'hI',x:310,y:360,size:12}],
      hexSolo: [],
    },
    // --- TOP & BOTTOM 4+4 ---
    tb4a: {
      pieces: [{x:10,y:50,rot:-8},{x:310,y:50,rot:6},{x:10,y:390,rot:6},{x:310,y:390,rot:-8}],
      hexPieces: [{type:'hT',x:170,y:45,size:14},{type:'hS',x:170,y:360,size:14},{type:'hL',x:430,y:50,size:12},{type:'hI',x:430,y:360,size:12}],
      hexSolo: [],
    },
    tb4b: {
      pieces: [{x:10,y:50,rot:-6},{x:220,y:50,rot:4},{x:10,y:390,rot:6},{x:220,y:390,rot:-4}],
      hexPieces: [{type:'hI',x:370,y:45,size:14},{type:'hT',x:370,y:360,size:14},{type:'hS',x:130,y:45,size:12},{type:'hL',x:130,y:360,size:12}],
      hexSolo: [],
    },
    // --- TOP & BOTTOM 5+5 ---
    tb5a: {
      pieces: [{x:10,y:50,rot:-8},{x:175,y:50,rot:4},{x:340,y:50,rot:8},{x:10,y:390,rot:6},{x:340,y:390,rot:-6}],
      hexPieces: [{type:'hT',x:10,y:130,size:14},{type:'hS',x:350,y:130,size:13},{type:'hI',x:170,y:360,size:13},{type:'hL',x:10,y:340,size:12},{type:'hF',x:350,y:340,size:11}],
      hexSolo: [],
    },
    // --- TOP & BOTTOM 6+6 ---
    tb6a: {
      pieces: [{x:10,y:50,rot:-8},{x:175,y:50,rot:4},{x:340,y:50,rot:8},{x:10,y:390,rot:6},{x:175,y:390,rot:-4},{x:340,y:390,rot:-8}],
      hexPieces: [{type:'hT',x:10,y:130,size:13},{type:'hS',x:175,y:130,size:12},{type:'hL',x:350,y:130,size:12},{type:'hI',x:10,y:340,size:12},{type:'hF',x:175,y:340,size:11},{type:'hT',x:350,y:340,size:11}],
      hexSolo: [],
    },
  };

  // --- DOM refs ---
  // --- Swatch palette (game colors + dark background tones) ---
  const BG_PALETTE = [
    '#06060f','#0c0c1a','#12122a','#1e1e44',  // game bg tones
    '#1a0533','#2d1b4e','#0d1b4a','#0a2342',  // purples/navys
    '#0a2a2a','#0d3050','#042a1a','#0a3d2e',  // teals/greens
    '#2a0a1a','#1a0a22','#1a1008','#2a1a0a',  // cherry/warm
    '#6b2fa0','#ff6b35','#0f2557','#081440',  // accent darks
  ];
  const GLOW_PALETTE = [
    '#00ccff','#00ff88','#4444ff',             // game accents
    '#EE4444','#00CED1','#FFD700','#7FFF00',   // piece colors
    '#9B59F0','#FF1493','#FF8C00','#ffffff',
  ];

  function buildSwatches(containerId, hiddenId, palette, defaultVal) {
    const container = document.getElementById(containerId);
    const hidden = document.getElementById(hiddenId);
    palette.forEach(color => {
      const el = document.createElement('div');
      el.className = 'swatch' + (color === defaultVal ? ' active' : '');
      el.style.background = color;
      el.addEventListener('click', () => {
        hidden.value = color;
        container.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
        el.classList.add('active');
        hidden.dispatchEvent(new Event('input'));
      });
      container.appendChild(el);
    });
  }

  buildSwatches('bgColor1Swatches', 'bgColor1', BG_PALETTE, '#0a2342');
  buildSwatches('bgColor2Swatches', 'bgColor2', BG_PALETTE, '#06060f');
  buildSwatches('titleGlowSwatches', 'titleGlowColor', GLOW_PALETTE, '#00ccff');

  const preview = document.getElementById('preview');
  const piecesLayer = document.getElementById('piecesLayer');
  const titleWrap = document.getElementById('titleWrap');
  const vignette = document.getElementById('vignette');

  // Controls
  const bgType = document.getElementById('bgType');
  const bgColor1 = document.getElementById('bgColor1');
  const bgColor2 = document.getElementById('bgColor2');
  const bgAngle = document.getElementById('bgAngle');
  const titleSize = document.getElementById('titleSize');
  const titleY = document.getElementById('titleY');
  const titleSpacing = document.getElementById('titleSpacing');
  const titleGlow = document.getElementById('titleGlow');
  const titleGlowColor = document.getElementById('titleGlowColor');
  const vigStrength = document.getElementById('vigStrength');
  const vigSize = document.getElementById('vigSize');
  const showPieces = document.getElementById('showPieces');
  const pieceOpacity = document.getElementById('pieceOpacity');
  const pieceGlow = document.getElementById('pieceGlow');
  const pieceSize = document.getElementById('pieceSize');
  const layoutPreset = document.getElementById('layoutPreset');
  const layoutLabel = document.getElementById('layoutLabel');
  const prevLayout = document.getElementById('prevLayout');
  const nextLayout = document.getElementById('nextLayout');
  const PRESET_KEYS = Object.keys(PRESETS);
  const PRESET_NAMES = {
    c2a:'Corners 2+2 A', c2b:'Corners 2+2 B',
    c3a:'Corners 3+3 A', c3b:'Corners 3+3 B',
    c4a:'Corners 4+4 A', c4b:'Corners 4+4 B', c4sym:'Corners 4+4 Sym',
    c5a:'Corners 5+5 A', c5b:'Corners 5+5 B',
    c6a:'Corners 6+6 A', c6b:'Corners 6+6 B',
    d2a:'Cascade 2+2', d3a:'Cascade 3+3', d4a:'Cascade 4+4', d4rev:'Cascade 4+4 Rev',
    tb2a:'Top/Bottom 2+2', tb3a:'Top/Bottom 3+3',
    tb4a:'Top/Bottom 4+4 A', tb4b:'Top/Bottom 4+4 B',
    tb5a:'Top/Bottom 5+5', tb6a:'Top/Bottom 6+6',
  };
  let layoutIndex = PRESET_KEYS.indexOf('tb3a') >= 0 ? PRESET_KEYS.indexOf('tb3a') : 0;

  function setLayout(idx) {
    layoutIndex = ((idx % PRESET_KEYS.length) + PRESET_KEYS.length) % PRESET_KEYS.length;
    layoutPreset.value = PRESET_KEYS[layoutIndex];
    layoutLabel.textContent = PRESET_NAMES[PRESET_KEYS[layoutIndex]] || PRESET_KEYS[layoutIndex];
    updateAll();
  }
  prevLayout.addEventListener('click', () => setLayout(layoutIndex - 1));
  nextLayout.addEventListener('click', () => setLayout(layoutIndex + 1));
  const blockStyle = document.getElementById('blockStyle');
  const piecesCanvas = document.getElementById('piecesCanvas');
  // Canvas is always 1024x1024, displayed at 512x512 via CSS
  const pctx = piecesCanvas.getContext('2d');
  pctx.scale(2, 2); // draw in 512 logical coords, rendered at 2x
  const exportBtn = document.getElementById('exportBtn');

  // --- Build pieces ---
  function createPieces() { /* no-op, canvas renders on each update */ }

  // Canvas-based piece rendering using the game's actual block stamps
  function updatePiecePositions() {
    const preset = PRESETS[layoutPreset.value] || PRESETS.cornersMin;
    const size = parseInt(pieceSize.value);
    const opacity = parseInt(pieceOpacity.value) / 100;
    const visible = showPieces.checked;
    const gap = Math.round(size * 0.04);
    const tier = blockStyle.value; // 'normal', 'pillow', 'neonFlat'

    clearStampCache();
    pctx.clearRect(0, 0, 1024, 1024);
    if (!visible) return;
    pctx.globalAlpha = opacity;

    // Draw classic square pieces using game's getBlockStamp at 2x resolution
    // Generate stamp at 2x cell size, then draw at half size so the canvas 2x scale
    // doesn't upscale a low-res bitmap.
    PIECE_TYPES.forEach((type, i) => {
      const pos = preset.pieces[i];
      if (!pos) return;
      const color = COLORS[type];
      const shape = SHAPES[type];
      const stamp = getBlockStamp(tier, color, size * 2);
      shape.forEach(([col, row]) => {
        const bx = pos.x + col * (size + gap);
        const by = pos.y + row * (size + gap);
        pctx.save();
        pctx.translate(bx + size / 2, by + size / 2);
        pctx.rotate(pos.rot * Math.PI / 180);
        pctx.drawImage(stamp, -size / 2, -size / 2, size, size);
        pctx.restore();
      });
    });

    // Draw hex pieces using the game's HexBoardRenderer._drawFilledHex
    _renderHexPieces(pctx, preset, size, tier);

    pctx.globalAlpha = 1;
  }

  // Shared hex piece rendering — uses the game's actual HexBoardRenderer
  function _renderHexPieces(ctx, preset, size, tier) {
    var hexR = size * 0.52;
    var hexSpacing = hexR + size * 0.04;
    var sCell = hexR * (1 - THEME.size.blockGap * 2);
    // Create a temporary HexBoardRenderer to use its _drawFilledHex method
    var hbr = new HexBoardRenderer(ctx, 0, 0, size, 0);
    hbr._styleTier = tier;
    var hpDefs = preset.hexPieces || [];
    hpDefs.forEach(function(hp, i) {
      var cells = HEX_PIECES[hp.type];
      var color = HEX_PIECE_COLORS[hp.type];
      var matchedRot = preset.pieces[i] ? preset.pieces[i].rot : 0;
      var ox = hp.x + size * 2;
      var oy = hp.y + size * 1.5;
      cells.forEach(function(cell) {
        var cx = ox + hexSpacing * 1.5 * cell[0];
        var cy = oy + hexSpacing * Math.sqrt(3) * (cell[1] + cell[0] / 2);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(matchedRot * Math.PI / 180);
        hbr._drawFilledHex(0, 0, sCell, color);
        ctx.restore();
      });
    });
  }

  // --- Update functions ---
  function updateBackground() {
    const c1 = bgColor1.value;
    const c2 = bgColor2.value;
    const type = bgType.value;
    const angle = bgAngle.value;
    if (type === 'solid') {
      preview.style.background = c1;
    } else if (type === 'radial') {
      preview.style.background = 'radial-gradient(ellipse at center, ' + c1 + ', ' + c2 + ')';
    } else {
      preview.style.background = 'linear-gradient(' + angle + 'deg, ' + c1 + ', ' + c2 + ')';
    }
  }

  function updateTitle() {
    const size = parseInt(titleSize.value);
    const y = parseInt(titleY.value);
    const glow = parseInt(titleGlow.value);
    const glowColor = titleGlowColor.value;
    const { r, g, b } = hexToRgb(glowColor);

    const spacing = parseInt(titleSpacing.value);

    titleWrap.style.fontSize = size + 'px';
    titleWrap.style.top = y + '%';
    titleWrap.style.filter =
      'drop-shadow(0 0 ' + glow + 'px rgba(' + r + ',' + g + ',' + b + ',.4))' +
      ' drop-shadow(0 3px 6px rgba(0,0,0,.7))';

    // Apply same base letter-spacing to both words, then widen PARTY to match STACKER's width
    const stacker = titleWrap.querySelector('.word-stacker');
    const party = titleWrap.querySelector('.word-party');
    const baseEm = (spacing / 100) + 'em';
    stacker.style.letterSpacing = baseEm;
    party.style.letterSpacing = baseEm;
    requestAnimationFrame(() => {
      const sw = stacker.offsetWidth;
      const pw = party.offsetWidth;
      if (pw > 0 && pw < sw) {
        // Add extra per-character spacing to PARTY on top of base
        const basePx = parseFloat(getComputedStyle(party).letterSpacing) || 0;
        const extraPerChar = (sw - pw) / 4;
        party.style.letterSpacing = (basePx + extraPerChar).toFixed(1) + 'px';
      }
    });
  }

  function updateVignette() {
    const strength = parseInt(vigStrength.value) / 100;
    const size = parseInt(vigSize.value);
    vignette.style.background =
      'radial-gradient(ellipse ' + size + '% ' + size + '% at 50% 50%, transparent 35%, rgba(10,5,30,' + strength.toFixed(2) + ') 100%)';
  }

  function updateAll() {
    updateBackground();
    updateTitle();
    updateVignette();
    updatePiecePositions();
  }

  // --- Value display helpers ---
  function showVal(sliderId, suffix) {
    const slider = document.getElementById(sliderId);
    const display = document.getElementById(sliderId + 'Val');
    if (display) display.textContent = slider.value + (suffix || '');
  }

  // --- Wire up controls ---
  const allControls = [
    bgType, bgColor1, bgColor2, bgAngle,
    titleSize, titleY, titleSpacing, titleGlow, titleGlowColor,
    vigStrength, vigSize,
    showPieces, pieceOpacity, pieceGlow, pieceSize,
    blockStyle, layoutPreset
  ];

  allControls.forEach(ctrl => {
    ctrl.addEventListener('input', () => {
      showVal('bgAngle', '');
      showVal('titleSize', '');
      showVal('titleY', '%');
      showVal('titleSpacing', '');
      showVal('titleGlow', '');
      showVal('vigStrength', '%');
      showVal('vigSize', '%');
      showVal('pieceOpacity', '%');
      showVal('pieceGlow', '');
      showVal('pieceSize', '');
      updateAll();
    });
  });

  // Export — capture exactly what's on screen at 1024x1024
  exportBtn.addEventListener('click', () => {
    exportBtn.textContent = 'Rendering...';

    // Use html2canvas-like approach: render preview to an offscreen 1024 canvas
    // by drawing background, the already-1024 pieces canvas, vignette, then title
    var S = 1024;
    var expCanvas = document.createElement('canvas');
    expCanvas.width = S; expCanvas.height = S;
    var ectx = expCanvas.getContext('2d');
    ectx.scale(2, 2); // draw in 512 logical coords

    // 1. Background — same as preview
    ectx.fillStyle = '#06060f';
    ectx.fillRect(0, 0, 512, 512);
    var c1 = bgColor1.value, c2 = bgColor2.value;
    var type = bgType.value, angle = bgAngle.value;
    if (type === 'solid') {
      ectx.fillStyle = c1; ectx.fillRect(0, 0, 512, 512);
    } else if (type === 'radial') {
      var rg = ectx.createRadialGradient(256, 256, 0, 256, 256, 362);
      rg.addColorStop(0, c1); rg.addColorStop(1, c2);
      ectx.fillStyle = rg; ectx.fillRect(0, 0, 512, 512);
    } else {
      var a = angle * Math.PI / 180;
      var lg = ectx.createLinearGradient(256 - Math.cos(a) * 362, 256 - Math.sin(a) * 362, 256 + Math.cos(a) * 362, 256 + Math.sin(a) * 362);
      lg.addColorStop(0, c1); lg.addColorStop(1, c2);
      ectx.fillStyle = lg; ectx.fillRect(0, 0, 512, 512);
    }

    // 2. Pieces — blit the 1024x1024 pieces canvas directly (already at correct resolution)
    ectx.setTransform(1, 0, 0, 1, 0, 0); // reset to 1:1 for pixel-perfect blit
    ectx.drawImage(piecesCanvas, 0, 0);
    ectx.setTransform(2, 0, 0, 2, 0, 0); // back to 2x for remaining draws

    // 3. Vignette
    var vs = parseInt(vigStrength.value) / 100;
    var vz = parseInt(vigSize.value);
    var vg = ectx.createRadialGradient(256, 256, 0, 256, 256, vz / 100 * 362);
    vg.addColorStop(0.35, 'transparent');
    vg.addColorStop(1, 'rgba(10,5,30,' + vs.toFixed(2) + ')');
    ectx.fillStyle = vg; ectx.fillRect(0, 0, 512, 512);

    // 4. Title — read computed styles from the DOM for exact match
    var stacker = titleWrap.querySelector('.word-stacker');
    var party = titleWrap.querySelector('.word-party');
    var fs = parseInt(titleSize.value);
    var ty = 512 * parseInt(titleY.value) / 100;
    var sLS = getComputedStyle(stacker).letterSpacing;
    var pLS = getComputedStyle(party).letterSpacing;
    var glowVal = parseInt(titleGlow.value);
    var gc = titleGlowColor.value;
    var grgb = hexToRgb(gc);

    ectx.save();
    ectx.textAlign = 'center'; ectx.textBaseline = 'middle';
    ectx.font = '900 ' + fs + 'px Orbitron';

    // Glow layer (drawn first, behind fill)
    if (glowVal > 0) {
      ectx.shadowColor = 'rgba(' + grgb.r + ',' + grgb.g + ',' + grgb.b + ',0.4)';
      ectx.shadowBlur = glowVal;
    }

    // Gradient fill
    var tg = ectx.createLinearGradient(50, ty - fs, 460, ty + fs);
    tg.addColorStop(0, '#4444ff'); tg.addColorStop(0.5, '#00ccff'); tg.addColorStop(1, '#00ff88');
    ectx.fillStyle = tg;

    ectx.letterSpacing = sLS;
    ectx.fillText('STACKER', 256, ty - fs * 0.55);
    ectx.letterSpacing = pLS;
    ectx.fillText('PARTY', 256, ty + fs * 0.55);
    ectx.restore();

    // 5. Download
    expCanvas.toBlob(function(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'stacker-party-cover-1024.png';
      a.click();
      URL.revokeObjectURL(url);
      exportBtn.textContent = 'Export 1024x1024';
    }, 'image/png');
  });

  // --- Init ---
  createPieces();
  updateAll();
})();
