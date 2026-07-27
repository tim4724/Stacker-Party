import Foundation

/// One roster row, decoded straight from the room core's record
/// (`RoomCore.list()` / `roomCall("list")`).
///
/// It used to be a mutable class the display wrote through; the room core owns every
/// field now, so this is a value type and the only thing that produces one is a
/// bridge read. The wire snapshot deliberately carries neither `connected` nor
/// `joinedAt` (controllers have no use for them), which is exactly why the lobby
/// UI reads the roster through here rather than off the published snapshot.
public struct PlayerRecord: Decodable, Equatable {
    public let peerIndex: Int
    public let joinedAt: Int           // monotonic join counter (not wall clock)
    public let connected: Bool
    public let playerName: String
    public let colorSlot: Int          // dense 0..MAX_PLAYERS-1 (the room core's `playerIndex`)
    public let startLevel: Int         // 1...15
    /// False between the relay's `peer_joined` and this player's own HELLO: the
    /// name and colour are our guesses until then. See RoomCore.peerJoined.
    public let helloSeen: Bool

    private enum CodingKeys: String, CodingKey {
        case peerIndex, joinedAt, connected, playerName, startLevel, helloSeen
        case colorSlot = "playerIndex"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        peerIndex = try c.decode(Int.self, forKey: .peerIndex)
        joinedAt = try c.decode(Int.self, forKey: .joinedAt)
        connected = try c.decodeIfPresent(Bool.self, forKey: .connected) ?? true
        playerName = try c.decodeIfPresent(String.self, forKey: .playerName) ?? ""
        colorSlot = try c.decodeIfPresent(Int.self, forKey: .colorSlot) ?? 0
        // The fixture path (RoomCore.addPlayer) writes neither field; the room core's
        // own snapshot defaults them the same way (`startLevel || 1`, `!== false`).
        startLevel = try c.decodeIfPresent(Int.self, forKey: .startLevel) ?? 1
        helloSeen = try c.decodeIfPresent(Bool.self, forKey: .helloSeen) ?? true
    }
}
