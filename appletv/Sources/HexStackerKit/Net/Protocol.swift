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

    /// Ceiling on an input message's repeat count (INPUT_MAX_REPEAT = COLS - 1).
    /// A controller ships a multi-step ratchet drag as one counted message; the
    /// count is off the wire, and beyond this the piece is against the wall.
    public static let inputMaxRepeat = 8

    /// Where phone controllers load the web controller (the QR target) in a
    /// shipped build. The join URL is `<base>/<room>#<instance>`, matching the
    /// web display.
    public static let defaultControllerBaseURL = "https://hexstacker.com"

    /// The origin the QR / join URL actually points at. The web display reads
    /// this off `window.location` for free, so a preview deploy retargets its own
    /// QR automatically; a TV app has no origin to read, which is why the knob is
    /// explicit. Production unless a debug launch calls `setControllerBase`
    /// (HEXHOST, see DisplayModel.start), which nothing in a shipped build does.
    public static private(set) var controllerBaseURL = defaultControllerBaseURL

    /// Controller-URL template sent with `create`. The relay fills
    /// {room}/{instance} and hands the result to clients that hold only the
    /// room code (`joined`, `GET /room/:code`). Same shape as the QR join URL
    /// the web display registers (controllerUrlTemplate in DisplayConnection.js).
    ///
    /// `cpp` is the CouchPad device tag (§6), and this template is the ONE place
    /// the app declares which box it is. Every route the launcher can arrive by
    /// reads it from here: a typed code and a §8 nearby tap both resolve through
    /// the relay (the advertisement itself carries nothing but the room code), and
    /// it survives into the launcher's rejoin card after the room is gone. The QR
    /// join URL stays clean: whoever scans it is looking at the TV. The vocabulary
    /// is fixed (web/tvos/androidtv) and the launcher renders its own localized
    /// wording from it, so there is no free-text field here for a model name.
    public static var controllerURLTemplate: String { "\(controllerBaseURL)/{room}?cpp=tvos#{instance}" }

    /// Point the QR / join URL at another origin, e.g. a branch preview. Call
    /// before the relay connects: the origin also rides the `create` frame as the
    /// controller-URL template. A nil/blank/unusable value leaves production in
    /// place, so the caller can hand the raw launch value straight through.
    /// Mirrored by RelayConfig.setControllerBase (Kotlin).
    @discardableResult
    public static func setControllerBase(_ raw: String?) -> String {
        if let base = normalizedBase(raw) { controllerBaseURL = base }
        return controllerBaseURL
    }

    /// `raw` as a bare origin: trimmed, scheme defaulted to https, any path or
    /// trailing slash dropped ("preview-x.hexstacker.com" -> "https://preview-x.hexstacker.com").
    /// nil when it names no host or carries a scheme a phone can't open.
    public static func normalizedBase(_ raw: String?) -> String? {
        guard var s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let sep = s.range(of: "://") else { return nil }
        let scheme = String(s[s.startIndex..<sep.lowerBound]).lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        let authority = s[sep.upperBound...].prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        guard !authority.isEmpty else { return nil }
        return "\(scheme)://\(authority)"
    }
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
    public static let pong = "pong"
    public static let playerState = "player_state"

    // Display -> all controllers (broadcast)
    public static let error = "error"

    // welcome / lobby_update / game_start / countdown / game_end / game_over /
    // game_paused / game_resumed / display_muted are GONE. The retained room
    // snapshot (server/RoomCore.js) is the single source of truth controllers
    // derive their whole UI from, screen routing included, so there is no second
    // channel left that could disagree with it. DisplayCoordinatorTests
    // .retiredMessageTypesAreNeverSent walks a whole session asserting none of
    // those strings reaches the wire.

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

/// Room states, from `ROOM_STATE`. Kept identical to the room core's states
/// (server/RoomCore.js -> partyplug/RoomFlow.js), which the snapshot reports as
/// `roomState` and controllers route their screens off.
public enum RoomState: String {
    case lobby
    case countdown
    case playing
    case results
}

/// Why the game is frozen. Raw values are the room core's `RoomCore.PAUSE`, and
/// only `.manual` ever reaches a controller: the other two are display-internal,
/// they resolve themselves, and a controller shown either would sit on a pause
/// overlay whose Continue the display ignores. Pinned by
/// tests/protocol-swift-parity.test.js.
public enum PauseReason: String {
    case manual
    case auto
    case connection

    /// Decode the raw JSON `roomGet("pauseReason")` answers: a quoted word, or
    /// `null` when the room is running (which no raw value matches).
    init?(json: String) {
        guard json.count > 2 else { return nil }
        self.init(rawValue: String(json.dropFirst().dropLast()))
    }
}

/// A decoded inbound controller message (the relay envelope's `data` object).
/// Fields are heterogeneous across `type`s, so all but `type` are optional and
/// number/string coercion mirrors the web display's lenient parsing.
public struct ControllerMessage {
    public let type: String
    public let action: String?      // input
    public let n: Int?              // input (repeat count; absent = 1)
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
        self.n = ControllerMessage.int(dict["n"])
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

    public static func error(message: String) -> [String: Any] {
        ["type": MSG.error, "message": message]
    }

    public static func playerState(lines: Int) -> [String: Any] {
        ["type": MSG.playerState, "lines": lines]
    }
}
