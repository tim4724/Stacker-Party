package com.hexstacker.core.parity

import com.hexstacker.core.testing.evalAs
import com.hexstacker.core.testing.quickJs
import java.io.File
import kotlinx.coroutines.runBlocking

/**
 * Loads the canonical web render math (server/constants.js, public/shared/theme.js,
 * public/shared/CanvasUtils.js) into QuickJS and exposes it typed, for cross-engine
 * parity vs the Kotlin ports. TEST-ONLY (jvmTest). Mirrors appletv RenderMathJS.swift
 * but uses the Android QuickJS binding instead of JavaScriptCore.
 */
class RenderMathJs {

    private fun read(prop: String): String =
        File(System.getProperty(prop) ?: error("$prop not set by build")).readText()

    fun interface Eval {
        suspend fun str(code: String): String
    }

    /** Run [block] inside a QuickJs context preloaded with the web render math. */
    fun <T> withContext(block: suspend (Eval) -> T): T = runBlocking {
        quickJs {
            // window shim BEFORE constants.js (its UMD tail resolves the window branch).
            evalAs<Any?>("var window = {}; void 0;")
            evalAs<Any?>(read("hexcore.web.constants") + "\nvoid 0;")
            // theme.js top-level consts are lexical; copy the names we need onto globalThis
            // in the SAME evaluate so a later evaluate() can see them.
            evalAs<Any?>(
                read("hexcore.web.theme") + "\n" +
                    """
                    globalThis.__PIECE_COLORS = PIECE_COLORS;
                    globalThis.__PLAYER_COLORS = PLAYER_COLORS;
                    globalThis.__getStyleTier  = getStyleTier;
                    void 0;
                    """.trimIndent(),
            )
            evalAs<Any?>(
                read("hexcore.web.canvasutils") + "\n" +
                    """
                    globalThis.__lighten = lightenColor;
                    globalThis.__darken  = darkenColor;
                    globalThis.__ghost   = ghostColor;
                    // NEON_FLAT dark fill: 30% of color, truncated (JS `| 0`). Inlined in the
                    // web stamp recipe, so expose the same math here for the neonDark parity check.
                    globalThis.__neonDark = function(hex){
                      var c = hexToRgb(hex);
                      return 'rgb(' + ((c.r*0.3)|0) + ',' + ((c.g*0.3)|0) + ',' + ((c.b*0.3)|0) + ')';
                    };
                    void 0;
                    """.trimIndent(),
            )
            evalAs<Any?>(
                """
                globalThis.__geom = function(cs){ return window.GameConstants.computeHexGeometry(9,15,cs); };
                globalThis.__center = function(col,row,cs){
                  var g = __geom(cs);
                  return [g.colW*col + g.hexSize, g.hexH*(row + 0.5*(col&1)) + g.hexH/2];
                };
                globalThis.__outline = function(cs, outset){
                  var g = __geom(cs);
                  return window.GameConstants.computeHexOutlineVerts(0,0,g.hexSize,g.hexH,g.colW,9,15,outset);
                };
                globalThis.__clearable = function(grid, cols, ghost){
                  var totalRows = grid.length;
                  var gs = {};
                  if (ghost) for (var i=0;i<ghost.length;i++) gs[ghost[i][0]+','+ghost[i][1]]=true;
                  var isFilled = function(c,r){ return grid[r][c] > 0 || !!gs[c+','+r]; };
                  var ghostContributes = ghost ? function(c,r){ return grid[r][c]===0 && !!gs[c+','+r]; } : null;
                  return window.GameConstants.findClearableZigzags(cols, totalRows, isFilled, ghostContributes).clearCells;
                };
                globalThis.__nearClear = function(grid, cols){
                  var totalRows = grid.length;
                  return window.GameConstants.findNearClearZigzags(cols, totalRows, function(c,r){ return grid[r][c] > 0; });
                };
                void 0;
                """.trimIndent(),
            )
            block(Eval { code -> evalAs<String>(code) })
        }
    }
}
