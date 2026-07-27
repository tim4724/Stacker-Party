import Foundation

// Swift mirror of public/shared/protocol.js. The native display speaks the exact
// same JSON wire protocol to the Party-Server relay as the web display.

public enum Protocol {
    public static let relayURL = "wss://ws.hexstacker.com"
    public static let stunURL = "stun:stun.hexstacker.com:3478"

    /// The display's clientId is the literal "display" so the relay always
    /// restores it to slot 0 across reconnects.
    public static let displayClientId = "display"

    /// Slot 0 (display) + up to 8 players (MAX_PLAYERS).
    public static let maxClients = 9

    /// Where phone controllers load the web controller (the QR target). The
    /// join URL is `<base>/<room>#<instance>`, matching the web display.
    public static let controllerBaseURL = "https://hexstacker.com"

    /// Controller-URL template sent with `create`. The relay fills
    /// {room}/{instance} and hands the result to clients that hold only the
    /// room code (`joined`, `GET /room/:code`). Same shape as the QR join URL
    /// the web display registers (controllerUrlTemplate in DisplayConnection.js).
    public static let controllerURLTemplate = "https://hexstacker.com/{room}#{instance}"
}

/// Transport abstraction the coordinator drives. `RelayClient` is the live
/// implementation; tests inject a fake to exercise the game loop headlessly.
public protocol RelayTransport: AnyObject {
    func connect()
    func sendTo(_ index: Int, _ data: [String: Any])
    func broadcast(_ data: [String: Any])

    /// Publish a retained state snapshot (host/slot-0 only; the relay rejects it from
    /// anyone else). The relay keeps the latest blob on the room, pushes it live to
    /// current peers (sender excluded), and replays it to any client right after
    /// `joined` on (re)join. Costs exactly one broadcast. `data` must be
    /// JSON-serializable and <= 16 KiB serialized.
    func setState(_ data: [String: Any])

    /// Forget the current room and open a fresh one (the socket's next handshake
    /// sends `create`, not `join`). Used to recover when the relay reports the
    /// room is gone/full on a reconnect (web resetToWelcome).
    func recreateRoom()

    var onCreated: ((_ room: String, _ instance: String?, _ region: String?) -> Void)? { get set }
    var onJoined: ((_ room: String, _ peers: [Int]) -> Void)? { get set }
    var onPeerJoined: ((_ index: Int) -> Void)? { get set }
    var onPeerLeft: ((_ index: Int) -> Void)? { get set }
    var onMessage: ((_ from: Int, _ data: [String: Any]) -> Void)? { get set }
    var onRelayError: ((_ message: String) -> Void)? { get set }
}

/// Application message type strings (the `data.type` field), from `MSG`.
public enum MSG {
    // Controller -> Display
    public static let hello = "hello"
    public static let input = "input"
    public static let softDrop = "soft_drop"
    public static let softDropEnd = "soft_drop_end"
    public static let startGame = "start_game"
    public static let playAgain = "play_again"
    public static let returnToLobby = "return_to_lobby"
    public static let pauseGame = "pause_game"
    public static let resumeGame = "resume_game"
    public static let leave = "leave"
    public static let setLevel = "set_level"
    public static let setColor = "set_color"
    public static let setName = "set_name"
    public static let setDisplayMute = "set_display_mute"
    public static let ping = "ping"

    // Display -> specific controller
    public static let welcome = "welcome"
    public static let gameOver = "game_over"
    public static let lobbyUpdate = "lobby_update"
    public static let pong = "pong"
    public static let playerState = "player_state"

    // Display -> all controllers (broadcast)
    public static let countdown = "countdown"
    public static let displayMuted = "display_muted"
    public static let gameStart = "game_start"
    public static let gameEnd = "game_end"
    public static let gamePaused = "game_paused"
    public static let gameResumed = "game_resumed"
    public static let error = "error"

    // Internal: display self-liveness canary (echoed via relay slot 0).
    public static let heartbeat = "_heartbeat"
}

/// Input action strings, from `INPUT`. Match `Game.processInput` actions.
public enum InputAction: String, CaseIterable {
    case left
    case right
    case rotateCW = "rotate_cw"
    case hardDrop = "hard_drop"
    case hold
}

/// Room states, from `ROOM_STATE`. Kept identical to RoomFlow's states.
public enum RoomState: String {
    case lobby
    case countdown
    case playing
    case results
}

/// A decoded inbound controller message (the relay envelope's `data` object).
/// Fields are heterogeneous across `type`s, so all but `type` are optional and
/// number/string coercion mirrors the web display's lenient parsing.
public struct ControllerMessage {
    public let type: String
    public let action: String?      // input
    public let speed: Double?       // soft_drop
    public let name: String?        // hello / set_name
    public let autoName: Bool?      // hello
    public let level: Int?          // set_level
    public let colorIndex: Int?     // set_color
    public let muted: Bool?         // set_display_mute
    public let t: Double?           // ping (echoed back in pong)
    public let rejoinId: Int?       // hello (legacy)
    public let rejoinToken: Int?    // hello (?claim=<oldPeerIndex> is sent as rejoinToken)

    public init?(_ dict: [String: Any]) {
        guard let type = dict["type"] as? String else { return nil }
        self.type = type
        self.action = dict["action"] as? String
        self.speed = ControllerMessage.double(dict["speed"])
        self.name = dict["name"] as? String
        self.autoName = dict["autoName"] as? Bool
        self.level = ControllerMessage.int(dict["level"])
        self.colorIndex = ControllerMessage.int(dict["colorIndex"])
        self.muted = dict["muted"] as? Bool
        self.t = ControllerMessage.double(dict["t"])
        self.rejoinId = ControllerMessage.int(dict["rejoinId"])
        self.rejoinToken = ControllerMessage.int(dict["rejoinToken"])
    }

    private static func int(_ v: Any?) -> Int? {
        if let n = v as? Int { return n }
        // NSNumber before Double: JSONSerialization yields NSNumbers, and
        // `NSNumber as? Double` succeeds for every numeric field — so checking
        // Double first would route all integers through the trapping `Int(d)`,
        // which aborts the process on an out-of-Int64-range value (e.g. a peer
        // sending `level: 1e308`). `.intValue` clamps and never traps. Mirrors
        // the safe RelayClient.intValue.
        if let n = v as? NSNumber { return n.intValue }
        if let d = v as? Double { return (d.isFinite && abs(d) < 9.0e15) ? Int(d) : nil }
        if let s = v as? String { return Int(s) }
        return nil
    }

    private static func double(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let n = v as? Int { return Double(n) }
        if let s = v as? String { return Double(s) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }
}

/// Helpers that build the outbound `data` payloads the display sends. Returned
/// as `[String: Any]` for the relay envelope; values match the web display.
public enum OutboundMessage {
    public static func pong(t: Double?) -> [String: Any] {
        var m: [String: Any] = ["type": MSG.pong]
        if let t { m["t"] = t }
        return m
    }

    public static func countdown(value: Any) -> [String: Any] {
        // value is a number (3/2/1) or the string "GO".
        ["type": MSG.countdown, "value": value]
    }

    public static func gameStart() -> [String: Any] { ["type": MSG.gameStart] }
    public static func gamePaused() -> [String: Any] { ["type": MSG.gamePaused] }
    public static func gameResumed() -> [String: Any] { ["type": MSG.gameResumed] }
    public static func gameOver() -> [String: Any] { ["type": MSG.gameOver] }
    public static func displayMuted(_ muted: Bool) -> [String: Any] {
        ["type": MSG.displayMuted, "muted": muted]
    }
    public static func returnToLobby(playerCount: Int) -> [String: Any] {
        ["type": MSG.returnToLobby, "playerCount": playerCount]
    }
    public static func error(message: String) -> [String: Any] {
        ["type": MSG.error, "message": message]
    }

    public static func playerState(level: Int, lines: Int, alive: Bool, garbageIncoming: Int) -> [String: Any] {
        ["type": MSG.playerState, "level": level, "lines": lines, "alive": alive, "garbageIncoming": garbageIncoming]
    }
    public static func playerDead() -> [String: Any] {
        ["type": MSG.playerState, "alive": false]
    }

    public static func gameEnd(elapsed: Double, results: [[String: Any]]) -> [String: Any] {
        ["type": MSG.gameEnd, "elapsed": elapsed, "results": results]
    }
}
