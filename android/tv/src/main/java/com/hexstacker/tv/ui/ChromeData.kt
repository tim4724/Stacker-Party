package com.hexstacker.tv.ui

/**
 * Small, plain render-data classes for the stateless TV chrome composables.
 * These are intentionally decoupled from the `:core` networking/coordinator types:
 * MainActivity maps the room brain's `PlayerRecord` roster and the coordinator's
 * `ResultEntry` into these when wiring the screens, so the chrome holds no room
 * state of its own.
 *
 * `colorIndex` is a `Theme.playerColor(slot)` index (0..7); see [playerColor].
 */

/** One filled lobby seat. [peerIndex] is the stable identity used as a Compose
 *  key so the join-pop animation replays only for genuinely new players. */
data class LobbyPlayer(
    val peerIndex: Int,
    val name: String,
    val colorIndex: Int,
    val level: Int,
)

/** Everything [LobbyScreen] renders. Players must be pre-sorted by join time
 *  (ascending) by the caller, matching `updatePlayerList`/`calculateLayout`. */
data class LobbyData(
    val joinHost: String, // host portion, e.g. "play.example.com/" (rendered lowercase)
    val joinCode: String, // room code, e.g. "ABCD"
    val joinUrl: String, // full controller URL the QR encodes
    val players: List<LobbyPlayer>,
    val hostColorIndex: Int?, // host tint slot; null -> accentPrimary
)

/** One results row. [rank] is null for late joiners (who sat out the round);
 *  [colorIndex]/[lines]/[level] are null when unknown. Mirrors the coordinator's
 *  `ResultEntry` payload (enrichResults). */
data class ResultCard(
    val playerId: Int,
    val rank: Int?,
    val name: String,
    val colorIndex: Int?,
    val lines: Int?,
    val level: Int?,
    val newPlayer: Boolean = false,
)

/** Countdown value: a number (3/2/1) or the terminal GO. [CountdownOverlay] also
 *  has an `Int` overload (n <= 0 == GO) for the simplest caller. */
sealed interface CountdownValue {
    data class Number(val n: Int) : CountdownValue
    data object Go : CountdownValue
}
