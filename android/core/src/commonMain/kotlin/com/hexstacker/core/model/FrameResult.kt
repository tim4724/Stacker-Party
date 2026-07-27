package com.hexstacker.core.model

import kotlinx.serialization.Serializable

/**
 * One pull of `PartyCore.frame(nowMs)`: this frame's complete ordered event
 * record, a value-copy snapshot, and the normalized host-effect commands.
 *
 * [snapshot] is null when the frame is render-identical to the previously
 * delivered one (the Bridge shim's scene signature; see EngineBootstrap) —
 * consumers keep rendering their retained snapshot. Events/commands always
 * arrive in full.
 */
@Serializable
data class FrameResult(
    val events: List<GameEvent>,
    val snapshot: GameSnapshot? = null,
    val commands: List<Command>,
)

/**
 * Engine event (snake_case `type`). FLAT model: every non-`type` field is
 * optional because each type populates a different subset. `ignoreUnknownKeys`
 * absorbs `game_end`'s elapsed/results (modeled on [Command.gameEnd] instead).
 *
 * Types: piece_lock | line_clear | player_ko | garbage_cancelled | garbage_sent | game_end
 */
@Serializable
data class GameEvent(
    val type: String,
    val playerId: Int? = null,
    val typeId: Int? = null,            // piece_lock
    val lines: Int? = null,             // line_clear / garbage_cancelled / garbage_sent
    val blocks: List<Cell>? = null,     // piece_lock
    val clearCells: List<Cell>? = null, // line_clear
    val rows: List<Int>? = null,        // line_clear
    val senderId: Int? = null,          // garbage_sent
    val toId: Int? = null,              // garbage_sent
)

/**
 * Host command (camelCase `type`), in `toCommands` emission order. FLAT model.
 *
 * Types: pieceLock | lineClear | playerState | playerKO | playerEliminated |
 *        garbageCancelled | garbageSent | gameEnd
 */
@Serializable
data class Command(
    val type: String,
    val playerId: Int? = null,
    val senderId: Int? = null,           // garbageSent
    val toId: Int? = null,               // garbageSent
    val typeId: Int? = null,             // pieceLock
    val lines: Int? = null,              // lineClear / playerState(full) / garbage*
    val blocks: List<Cell>? = null,      // pieceLock
    val clearCells: List<Cell>? = null,  // lineClear
    val level: Int? = null,              // playerState(full)
    val alive: Boolean? = null,          // playerState
    val garbageIncoming: Int? = null,    // playerState(full)
    val elapsed: Double? = null,         // gameEnd
    val results: List<PlayerResult>? = null, // gameEnd (raw, pre-enrichment)
)

@Serializable
data class PlayerResult(
    val playerId: Int,
    val alive: Boolean,
    val lines: Int,
    val level: Int,
    val rank: Int = 0, // 1-based, alive-first then lines desc (added post-sort by Game.getResults)
)

/** Known event `type` strings (the engine emits exactly these). */
object EventType {
    const val PIECE_LOCK = "piece_lock"
    const val LINE_CLEAR = "line_clear"
    const val PLAYER_KO = "player_ko"
    const val GARBAGE_CANCELLED = "garbage_cancelled"
    const val GARBAGE_SENT = "garbage_sent"
    const val GAME_END = "game_end"
    val ALL = setOf(PIECE_LOCK, LINE_CLEAR, PLAYER_KO, GARBAGE_CANCELLED, GARBAGE_SENT, GAME_END)
}

/** Known command `type` strings (`PartyCore.toCommands`). */
object CommandType {
    const val PIECE_LOCK = "pieceLock"
    const val LINE_CLEAR = "lineClear"
    const val PLAYER_STATE = "playerState"
    const val PLAYER_KO = "playerKO"
    const val PLAYER_ELIMINATED = "playerEliminated"
    const val GARBAGE_CANCELLED = "garbageCancelled"
    const val GARBAGE_SENT = "garbageSent"
    const val GAME_END = "gameEnd"
    val ALL = setOf(
        PIECE_LOCK, LINE_CLEAR, PLAYER_STATE, PLAYER_KO, PLAYER_ELIMINATED,
        GARBAGE_CANCELLED, GARBAGE_SENT, GAME_END,
    )
}
