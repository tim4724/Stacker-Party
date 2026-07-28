package com.hexstacker.tv.screenshot

import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.render.Theme
import com.hexstacker.tv.testing.evalAs
import com.hexstacker.tv.testing.quickJs
import com.hexstacker.tv.ui.FallingPiece
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.float
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/** JOIN block: host + code compose the lobby pill; qrText is what the QR encodes. */
data class Join(val host: String, val code: String, val qrText: String)

/** One lobby seat from the canonical roster (id == slot == color index). */
data class RosterEntry(val id: Int, val slot: Int, val name: String, val level: Int)

/** One ranked results row (no "new player" placeholders in the fixtures). */
data class ResultEntry(
    val playerId: Int,
    val playerName: String,
    val colorIndex: Int,
    val rank: Int,
    val lines: Int,
    val level: Int,
)

data class ResultsFixture(val elapsedMs: Long, val entries: List<ResultEntry>)

/** A game-variant spec: player count + per-board start levels (elapsed rides the snapshot). */
data class Variant(val players: Int, val levels: List<Int>)

/** A variant paired with its decoded PartyCore snapshot. */
data class GameFixture(val variant: Variant, val snapshot: GameSnapshot)

/**
 * Canonical cross-platform gallery fixtures, sourced by running the built engine
 * bundle (`dist/partycore.js`, the `HexCore` iife) in QuickJS on the host JVM — the
 * exact same `HexCore.GalleryFixtures` the web and Apple TV galleries consume. This
 * guarantees every platform's screenshots render byte-identical data; nothing is
 * hand-ported into Kotlin. Snapshots decode through the production
 * [GameSnapshot]/`PlayerState` models (same path the live engine bridge uses).
 *
 * The bundle path comes from the `hexcore.bundle` system property (wired in
 * `:tv/build.gradle.kts`, pointing at the repo-root dist file), mirroring
 * `:core`'s `FrameGoldenConformanceTest`.
 */
object GalleryFixtures {

    private const val GF = "HexCore.GalleryFixtures"
    private val json = Json { ignoreUnknownKeys = true }

    private val bundleSrc: String by lazy {
        val path = System.getProperty("hexcore.bundle")
            ?: error("hexcore.bundle system property not set by the build")
        val f = File(path)
        require(f.exists()) { "Engine bundle not found at $path. Run `npm run build` at the repo root first." }
        f.readText()
    }

    /** Load the bundle fresh and return `JSON.stringify(<expr>)`. */
    private fun evalJson(expr: String): String = runBlocking {
        quickJs {
            evalAs<Any?>(bundleSrc)
            evalAs<String>("JSON.stringify($expr)")
        }
    }

    private fun obj(expr: String): JsonObject = json.parseToJsonElement(evalJson(expr)).jsonObject
    private fun arr(expr: String): JsonArray = json.parseToJsonElement(evalJson(expr)).jsonArray

    val join: Join by lazy {
        val o = obj("$GF.JOIN")
        Join(
            host = o.getValue("host").jsonPrimitive.content,
            code = o.getValue("code").jsonPrimitive.content,
            qrText = o.getValue("qrText").jsonPrimitive.content,
        )
    }

    /** [longNames] swaps in the 16-char LONG_NAMES fixture (lobby_long_names shot). */
    fun roster(count: Int, longNames: Boolean = false): List<RosterEntry> = arr("$GF.roster($count, $longNames)").map {
        val o = it.jsonObject
        RosterEntry(
            id = o.getValue("id").jsonPrimitive.int,
            slot = o.getValue("slot").jsonPrimitive.int,
            name = o.getValue("name").jsonPrimitive.content,
            level = o.getValue("level").jsonPrimitive.int,
        )
    }

    fun results(count: Int): ResultsFixture {
        val o = obj("$GF.results($count)")
        return ResultsFixture(
            elapsedMs = o.getValue("elapsed").jsonPrimitive.long,
            entries = o.getValue("results").jsonArray.map { e ->
                val r = e.jsonObject
                ResultEntry(
                    playerId = r.getValue("playerId").jsonPrimitive.int,
                    playerName = r.getValue("playerName").jsonPrimitive.content,
                    colorIndex = r.getValue("colorIndex").jsonPrimitive.int,
                    rank = r.getValue("rank").jsonPrimitive.int,
                    lines = r.getValue("lines").jsonPrimitive.int,
                    level = r.getValue("level").jsonPrimitive.int,
                )
            },
        )
    }

    /**
     * The frozen lobby falling-piece background: the same 16 placements the web and
     * Apple TV lobby galleries paint, so the ambient columns match across platforms.
     * [FallingPiece.colorArgb] resolves through the shared piece palette by typeId
     * (`Theme.pieceColors`, the source `FallingPieceField` uses); cells/size/x/y/opacity
     * come straight from the fixture (x/y in the 1920x1080 Y-DOWN reference space).
     */
    fun ambientPieces(): List<FallingPiece> = arr("$GF.ambientPieces()").map { el ->
        val o = el.jsonObject
        FallingPiece(
            cells = o.getValue("cells").jsonArray.map { c ->
                val qr = c.jsonArray
                intArrayOf(qr[0].jsonPrimitive.int, qr[1].jsonPrimitive.int)
            },
            blockSize = o.getValue("size").jsonPrimitive.float,
            speed = 0f, // frozen: never advanced
            opacity = o.getValue("opacity").jsonPrimitive.float,
            colorArgb = Theme.pieceColors.getValue(o.getValue("typeId").jsonPrimitive.int).toArgb(),
            x = o.getValue("x").jsonPrimitive.float,
            y = o.getValue("y").jsonPrimitive.float,
        )
    }

    /** Variant spec + its decoded snapshot, in one bundle load. */
    fun game(variant: String): GameFixture {
        val root = json.parseToJsonElement(
            evalJson("(function(){var v=$GF.gameVariant('$variant');return {variant:v,snapshot:$GF.gameSnapshot(v)};})()"),
        ).jsonObject
        val v = root.getValue("variant").jsonObject
        return GameFixture(
            variant = Variant(
                players = v.getValue("players").jsonPrimitive.int,
                levels = v.getValue("levels").jsonArray.map { it.jsonPrimitive.int },
            ),
            snapshot = json.decodeFromJsonElement(root.getValue("snapshot")),
        )
    }

    /**
     * The rejoin-claim URL a dropped board's QR encodes: splice `claim=<peerIndex>`
     * into [joinUrl] before any fragment. Mirrors the web `showDisconnectQR`
     * (DisplayConnection.js) so the QR matches a live cross-device rejoin.
     */
    fun claimUrl(joinUrl: String, peerIndex: Int): String {
        val hashIdx = joinUrl.indexOf('#')
        val base = if (hashIdx >= 0) joinUrl.substring(0, hashIdx) else joinUrl
        val hash = if (hashIdx >= 0) joinUrl.substring(hashIdx) else ""
        val sep = if (base.contains('?')) "&" else "?"
        return "$base${sep}claim=$peerIndex$hash"
    }
}
