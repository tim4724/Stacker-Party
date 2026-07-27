package com.hexstacker.core.display

import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.room.PlayerRecord
import kotlinx.serialization.Serializable

/** Which top-level display screen is showing. */
enum class DisplayScreen { LOBBY, GAME, RESULTS }

/** The 3 / 2 / 1 numbers, then "GO". Controllers branch on the value being "GO". */
sealed interface CountdownValue {
    data class Number(val n: Int) : CountdownValue
    data object Go : CountdownValue
}

/**
 * The enriched per-player results row, decoded from what `RoomBrain.enrichResults`
 * hands back: the engine's ranking labelled with roster names/colours, plus the
 * players who sat the round out (flagged [newPlayer]). The RESULTS snapshot carries
 * the identical array to controllers, so the TV and the phones render one ranking
 * built in one place. The field names are the wire keys; do not rename them.
 */
@Serializable
data class ResultEntry(
    val playerId: Int,
    val playerName: String? = null,
    val colorIndex: Int? = null, // == record.colorSlot
    val alive: Boolean? = null,
    val lines: Int? = null,
    val level: Int? = null,
    val rank: Int? = null,
    val newPlayer: Boolean = false,
)

/**
 * Side-effects the coordinator drives (rendering, audio, screen changes). The
 * `:tv` app provides a concrete implementation (Canvas/SurfaceView renderer +
 * Media3 music + Compose screen switch); tests provide a fake recorder.
 *
 * Visual-only hooks ([handleGameEvent], [setDisconnected], [setPaused])
 * have no-op defaults so a screenshot/test impl need only
 * implement the screen/render/audio hooks (mirrors the Swift optional-protocol
 * extension).
 */
interface DisplayOutput {
    fun showScreen(screen: DisplayScreen)
    fun roomReady(room: String, joinUrl: String)
    fun updateLobby(players: List<PlayerRecord>, hostPeerIndex: Int?)
    fun showCountdown(value: CountdownValue)
    fun renderSnapshot(snapshot: GameSnapshot)
    fun showResults(results: List<ResultEntry>)
    fun playCountdownBeep(go: Boolean)
    fun startMusic()
    fun stopMusic()
    fun pauseMusic()
    fun resumeMusic()

    /** Board animations (line clears, lock flashes, KO, shakes). Visual only. */
    fun handleGameEvent(event: GameEvent) {}

    /** Show (joinUrl != null) or clear (null) a per-board disconnect/rejoin overlay. */
    fun setDisconnected(playerId: Int, joinUrl: String?) {}

    /** Show/hide the paused overlay. */
    fun setPaused(paused: Boolean) {}

    /** Silence (true) or restore (false) the display's music. Driven by the host's
     *  "Game Music" toggle from either a controller (set_display_mute) or the TV remote. */
    fun setMuted(muted: Boolean) {}
}
