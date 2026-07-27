import Foundation
import Network
import os

/// "The device's network path became usable again." Injected so tests can fire it
/// synthetically — `NWPathMonitor` reports the real system path and cannot be
/// driven from a test, and a loopback mock server stopping doesn't change that
/// path at all, so wiring the reconnect straight to the monitor would leave the
/// most important recovery path untestable.
public protocol NetworkReachability: AnyObject {
    /// Invoked on an arbitrary queue each time the path transitions to satisfied.
    var onBecameReachable: (() -> Void)? { get set }
    func start()
    func stop()
}

/// Production `NetworkReachability`: the real system path.
public final class PathMonitorReachability: NetworkReachability {
    public var onBecameReachable: (() -> Void)?
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.hexstacker.reachability")
    /// Edge-triggered: only a false -> true transition is a reconnect signal, so a
    /// path update that stays satisfied (interface change, DNS shuffle) is ignored.
    private var wasSatisfied = true

    public init() {}

    public func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let satisfied = path.status == .satisfied
            defer { self.wasSatisfied = satisfied }
            guard satisfied, !self.wasSatisfied else { return }
            self.onBecameReachable?()
        }
        monitor.start(queue: queue)
    }

    public func stop() { monitor.cancel() }
}

/// Every link-lifecycle transition, for diagnosing reconnect failures in the
/// field. Deliberately verbose but low-rate (a handful of lines per reconnect,
/// nothing per-frame). Stream it with:
///   xcrun simctl spawn <device> log stream --predicate \
///     'subsystem == "com.hexstacker.tv" AND category == "relay"'
private let relayLog = Logger(subsystem: "com.hexstacker.tv", category: "relay")

/// The display's WebSocket client for the Party-Server relay. Ported from
/// partyplug/PartyConnection.js + the display-side handshake in
/// DisplayConnection.js. The native display is always relay slot 0 and the room
/// creator. It carries every display -> controller message, plus controller input
/// whenever the WebRTC fastlane (Fastlane.swift) is not up.
///
/// Responsibilities: create/join handshake, send/broadcast envelopes, inbound
/// routing, capped-exponential reconnect with instance (shard) pinning, and the
/// 1 Hz self-heartbeat that detects a silently-dead socket.
public final class RelayClient: NSObject, RelayTransport {

    public enum ConnectionState { case idle, connecting, open, reconnecting, closed }

    // Consumer callbacks (delivered on `callbackQueue`, default .main).
    public var onCreated: ((_ room: String, _ instance: String?, _ region: String?) -> Void)?
    public var onJoined: ((_ room: String, _ peers: [Int]) -> Void)?
    public var onPeerJoined: ((_ index: Int) -> Void)?
    public var onPeerLeft: ((_ index: Int) -> Void)?
    public var onMessage: ((_ from: Int, _ data: [String: Any]) -> Void)?
    public var onRelayError: ((_ message: String) -> Void)?
    /// Relay evicted us because another client claimed "display" (close 4000).
    public var onReplaced: (() -> Void)?
    public var onConnectionState: ((ConnectionState) -> Void)?
    /// Fired when a reconnect is scheduled, carrying the 1-based attempt and the
    /// cap, so the overlay can show "Attempt N of M".
    public var onReconnecting: ((_ attempt: Int, _ max: Int) -> Void)?

    private let baseURL: String
    private let clientId: String
    private let maxClients: Int
    private let callbackQueue: DispatchQueue

    private let q = DispatchQueue(label: "com.hexstacker.relay")
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    // URLSession retains its delegate strongly for the session's lifetime. Making
    // RelayClient the delegate directly forms a session -> client cycle that only
    // invalidateAndCancel breaks (making `deinit` unreachable). This proxy is the
    // retained delegate instead and forwards weakly, so the client deallocates
    // normally and its `deinit` tears the session down.
    private let wsDelegate = WeakWebSocketDelegate()

    private var lastRoom: String?
    private var lastInstance: String?

    // Injectable so tests can exercise the whole budget in milliseconds instead of
    // the ~13s the production curve takes. Defaults are the shipped values.
    private let maxReconnectAttempts: Int
    private let reconnectBaseSeconds: TimeInterval
    private let reconnectCapSeconds: TimeInterval
    private var reconnectAttempt = 0
    private var shouldReconnect = true
    private var dropHandled = false
    private var reconnectTimer: DispatchSourceTimer?

    /// Set by `suspend()` (app backgrounded) and cleared on the next connect, so a
    /// reachability blip while parked can't resurrect the socket behind the
    /// foreground handshake.
    private var suspended = false
    /// Last state handed to `onConnectionState`, so the reachability path knows
    /// whether there is anything to recover.
    private var currentState: ConnectionState = .idle
    private let reachability: NetworkReachability?

    private var heartbeatTimer: DispatchSourceTimer?
    private var lastHeartbeatEcho: TimeInterval = 0
    private static let heartbeatDeadSeconds: TimeInterval = 6.0   // SELF_HEARTBEAT_DEAD_MS

    // The heartbeat only starts on created/joined, so a socket that completes the
    // WS upgrade but never gets a handshake answer (wedged shard) would otherwise
    // sit in .open forever with no probe armed. The web's liveness interval keeps
    // running across reconnects and re-detects this; this timer is the native
    // equivalent for the handshake window.
    private var handshakeTimer: DispatchSourceTimer?
    private static let handshakeTimeoutSeconds: TimeInterval = 6.0

    public init(baseURL: String = Protocol.relayURL,
                clientId: String = Protocol.displayClientId,
                maxClients: Int = Protocol.maxClients,
                callbackQueue: DispatchQueue = .main,
                maxReconnectAttempts: Int = 5,
                reconnectBaseSeconds: TimeInterval = 1.0,
                reconnectCapSeconds: TimeInterval = 5.0,
                reachability: NetworkReachability? = PathMonitorReachability()) {
        self.baseURL = baseURL
        self.clientId = clientId
        self.maxClients = maxClients
        self.callbackQueue = callbackQueue
        self.maxReconnectAttempts = maxReconnectAttempts
        self.reconnectBaseSeconds = reconnectBaseSeconds
        self.reconnectCapSeconds = reconnectCapSeconds
        self.reachability = reachability
        super.init()
        wsDelegate.client = self
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        self.session = URLSession(configuration: .default, delegate: wsDelegate, delegateQueue: delegateQueue)
        // The retry budget covers relay-side blips; this covers the device-side
        // outage it cannot. A Wi-Fi drop routinely outlasts the ~13s budget, and
        // before this the client parked on .closed forever, needing a button press
        // that only worked if the user happened to press it after the interface
        // had finished coming back up.
        self.reachability?.onBecameReachable = { [weak self] in
            self?.q.async { self?.networkBecameReachable() }
        }
        self.reachability?.start()
    }

    // MARK: - Public control

    public func connect() {
        q.async { self.connectLocked() }
    }

    /// Manual reconnect from the terminal (gave-up) `.closed` state. Re-arms the
    /// full auto-retry budget — mirrors the web display's `resetReconnectCount()`
    /// before `reconnectNow()`. A plain `connect()` here would leave
    /// `reconnectAttempt` past the cap, so the next drop would fall straight back
    /// to `.closed` (one attempt instead of the 5-attempt capped-exponential
    /// budget). Only surfaced for the gave-up overlay, never after eviction.
    public func reconnectNow() {
        q.async {
            relayLog.notice("MANUAL reconnect pressed (attempt counter reset)")
            self.reconnectAttempt = 0
            self.connectLocked()
        }
    }

    /// The device is back on a usable network. Reconnect straight away and re-arm
    /// the full budget, whether we are mid-backoff (no reason to sit out the rest
    /// of the curve once the cause is gone) or already parked on `.closed`.
    ///
    /// Deliberately NOT a replacement for the retry budget: this fires only for
    /// DEVICE-side path changes, so a relay-side drop on a healthy Wi-Fi never
    /// reaches here — that is what the attempts are for. The two cover different
    /// failure modes.
    private func networkBecameReachable() {
        guard shouldReconnect else { return }   // evicted (4000) — reconnecting would start a takeover war
        guard !suspended else { return }        // backgrounded; the foreground rejoin owns this
        guard currentState != .open else { return }   // already healthy; the path merely flapped
        relayLog.notice("network reachable again (state=\(String(describing: self.currentState), privacy: .public)) -> immediate reconnect")
        reconnectAttempt = 0
        connectLocked(reconnecting: true)
    }

    /// Deliberate close while the app is backgrounded: tear down the socket and
    /// timers with NO auto-reconnect, but keep the room pinned and the session
    /// alive so a foreground `reconnectNow()` re-joins slot 0. Closing promptly
    /// (rather than letting the socket linger until the relay's idle timeout
    /// kills it mid-suspension) hands the controllers an immediate peer_left(0),
    /// so they react to the display's absence instead of sitting in a
    /// live-looking room with nobody behind it. If the room is gone by the time
    /// we return, the relay answers the join with "Room not found" and the
    /// coordinator recovers by creating a fresh room.
    public func suspend() {
        q.async {
            self.cancelReconnectTimer()
            self.cancelHandshakeTimer()
            self.stopHeartbeat()
            self.suspended = true
            self.dropHandled = true          // suppress the drop handler for this deliberate cancel
            let old = self.task
            self.task = nil
            old?.cancel(with: .goingAway, reason: nil)
            self.setState(.closed)
        }
    }

    /// Forget the pinned room WITHOUT touching the socket: the next
    /// (re)connect handshake sends `create` instead of `join`. Used when the
    /// display suspends with an EMPTY lobby — the memberless room dies with
    /// our socket at the relay anyway, so resuming it would only bounce a
    /// join off "Room not found" before recreating.
    public func unpinRoom() {
        q.async {
            self.lastRoom = nil
            self.lastInstance = nil
        }
    }

    /// Forget the current room and open a fresh one. Clears the pinned room so the
    /// next handshake sends `create` (not `join`), then tears the socket down and
    /// reconnects. Recovery path for a relay `error` of "Room not found"/"Room is
    /// full" on a reconnect (mirrors the web display's resetToWelcome, which
    /// closes the party and lets the fresh session create a new room).
    public func recreateRoom() {
        q.async {
            relayLog.notice("recreateRoom — unpinning \(self.lastRoom ?? "nil", privacy: .public) and opening a fresh one")
            self.lastRoom = nil
            self.lastInstance = nil
            self.reconnectAttempt = 0
            self.stopHeartbeat()
            self.dropHandled = true          // suppress the drop handler for this deliberate cancel
            let old = self.task
            self.task = nil
            old?.cancel(with: .goingAway, reason: nil)
            self.connectLocked()             // lastRoom == nil → onSocketOpened sends `create`
        }
    }

    /// Stop for good (no reconnect) and invalidate the URLSession. The session's
    /// delegate is a weak-forwarding proxy (see `wsDelegate`), so the session does
    /// NOT keep RelayClient alive and `deinit` already tears the session down;
    /// this is the explicit-teardown path for stopping the socket + timers while
    /// keeping the instance (e.g. before a deliberate shutdown).
    public func disconnect() {
        q.async {
            self.shouldReconnect = false
            self.cancelReconnectTimer()
            self.cancelHandshakeTimer()
            self.stopHeartbeat()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setState(.closed)
            self.session.invalidateAndCancel()
        }
    }

    // Reachable because the session holds only the weak proxy, not RelayClient.
    deinit {
        reachability?.stop()
        session.invalidateAndCancel()
    }

    /// Unicast an app payload to one peer index.
    public func sendTo(_ index: Int, _ data: [String: Any]) {
        q.async { self.sendEnvelope(["type": "send", "data": data, "to": index]) }
    }

    /// Broadcast an app payload to all other peers (omit `to`).
    public func broadcast(_ data: [String: Any]) {
        q.async { self.sendEnvelope(["type": "send", "data": data]) }
    }

    /// Publish the retained room snapshot (see `RelayTransport.setState`).
    /// There is deliberately no `close_room` counterpart: tvOS has no "quit" action
    /// (Home backgrounds the app, and the party must survive that), so nothing would
    /// ever call it. See DisplayCoordinator.displayDidEnterBackground.
    public func setState(_ data: [String: Any]) {
        q.async { self.sendEnvelope(["type": "set_state", "data": data]) }
    }

    // MARK: - Connection lifecycle

    // `reconnecting` forces the .reconnecting state even with the attempt counter
    // at 0 — the heartbeat path's immediate retry is unnumbered (web reconnectNow
    // parity), but must still freeze the sim and show the overlay.
    private func connectLocked(reconnecting: Bool = false) {
        cancelReconnectTimer()
        cancelHandshakeTimer()
        dropHandled = false
        suspended = false
        setState(reconnecting || reconnectAttempt > 0 ? .reconnecting : .connecting)

        guard let url = currentURL() else {
            shouldReconnect = false
            setState(.closed)
            emit { self.onRelayError?("invalid relay URL") }
            return
        }
        relayLog.notice("connect attempt=\(self.reconnectAttempt, privacy: .public) pinned=\(self.lastRoom != nil, privacy: .public) url=\(url.absoluteString, privacy: .public)")
        let old = task
        let newTask = session.webSocketTask(with: url)
        task = newTask
        newTask.resume()
        listen(on: newTask)

        // Old task's late callbacks are ignored (identity guard).
        old?.cancel(with: .goingAway, reason: nil)
    }

    private func currentURL() -> URL? {
        if let room = lastRoom, let instance = lastInstance {
            let r = room.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? room
            let i = instance.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? instance
            return URL(string: "\(baseURL)/\(r)?instance=\(i)") ?? URL(string: baseURL)
        }
        return URL(string: baseURL)
    }

    private func listen(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.q.async {
                guard task === self.task else { return }   // stale socket
                switch result {
                case .failure:
                    // A server-initiated close surfaces here as a receive failure,
                    // racing the didCloseWith delegate (which the identity guard
                    // ignores once `task` is cleared). Read the close code off the
                    // task itself so an eviction (4000) isn't consumed as an
                    // ordinary drop, which would auto-rejoin and start the
                    // takeover war onReplaced exists to prevent.
                    let code = task.closeCode
                    self.handleDrop(closeCode: code == .invalid ? nil : code.rawValue)
                case .success(let message):
                    switch message {
                    case .string(let s): self.handleFrame(s)
                    case .data(let d):
                        if let s = String(data: d, encoding: .utf8) { self.handleFrame(s) }
                    @unknown default: break
                    }
                    self.listen(on: task)   // re-arm
                }
            }
        }
    }

    private func handleDrop(closeCode: Int?) {
        if dropHandled {
            relayLog.debug("drop ignored (already handled) code=\(closeCode ?? -1, privacy: .public)")
            return
        }
        relayLog.notice("DROP code=\(closeCode ?? -1, privacy: .public) attemptWas=\(self.reconnectAttempt, privacy: .public)")
        dropHandled = true
        stopHeartbeat()
        cancelHandshakeTimer()
        task = nil

        if closeCode == 4000 {
            shouldReconnect = false
            setState(.closed)
            emit { self.onReplaced?() }
            return
        }
        // 4001: the room itself is gone (relay teardown). A connected host can't
        // receive this today (only the host closes rooms, and the hostless grace
        // arms only while slot 0 is vacant), so this is future-proofing: unpin
        // the dead room and let the normal reconnect path below open a FRESH
        // room (`create`) instead of bouncing a join off "Room not found".
        if closeCode == 4001 {
            lastRoom = nil
            lastInstance = nil
        }

        reconnectAttempt += 1
        if shouldReconnect && reconnectAttempt <= maxReconnectAttempts {
            // Backoff: 1s, 1.5s, 2.25s, 3.375s, capped 5s.
            let delay = min(reconnectBaseSeconds * pow(1.5, Double(reconnectAttempt - 1)), reconnectCapSeconds)
            // Emit the attempt count BEFORE the state change so the overlay paints
            // "Attempt N of M" straight away — callbacks run in order on .main, so
            // the overlay reads the fresh count the moment it appears (the counter
            // starts visibly at 1, not 2).
            let attempt = reconnectAttempt, max = maxReconnectAttempts
            relayLog.notice("retry \(attempt, privacy: .public)/\(max, privacy: .public) in \(delay, privacy: .public)s")
            emit { self.onReconnecting?(attempt, max) }
            setState(.reconnecting)
            scheduleReconnect(after: delay)
        } else {
            relayLog.error("GAVE UP after \(self.reconnectAttempt - 1, privacy: .public) attempts -> .closed")
            setState(.closed)
        }
    }

    private func scheduleReconnect(after seconds: TimeInterval) {
        cancelReconnectTimer()
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + seconds)
        timer.setEventHandler { [weak self] in self?.connectLocked() }
        timer.resume()
        reconnectTimer = timer
    }

    private func cancelReconnectTimer() {
        reconnectTimer?.cancel()
        reconnectTimer = nil
    }

    /// Force an immediate reconnect (used when the heartbeat goes silent).
    private func forceReconnect() {
        guard shouldReconnect else { return }
        stopHeartbeat()
        dropHandled = true
        let old = task
        task = nil
        old?.cancel(with: .goingAway, reason: nil)
        // This immediate retry is unnumbered — web reconnectNow parity: the
        // overlay shows heading-only until the retry fails, and that failure's
        // handleDrop numbers attempt 1. Numbering it here would burn attempt 1
        // on a connect that dies within milliseconds when the network is truly
        // down, so the counter would visibly start at 2 (and one backoff retry
        // would be lost). Emit 0 so the overlay drops any count from a previous
        // cycle, and force .reconnecting despite the counter being 0 — the
        // display only freezes the sim + shows the overlay on
        // .reconnecting/.closed, so `.connecting` would let the game run blind
        // (gravity + liveness sweeps) for the whole reconnect window.
        let max = maxReconnectAttempts
        emit { self.onReconnecting?(0, max) }
        connectLocked(reconnecting: true)
    }

    // MARK: - Inbound frames

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case "message":
            // Drop frames with no parseable sender rather than forwarding a -1
            // sentinel into the coordinator's per-peer handling.
            guard let from = Self.intValue(obj["from"]) else { return }
            let payload = obj["data"] as? [String: Any] ?? [:]
            // Intercept the self-heartbeat echo (slot 0) for liveness/RTT.
            if from == 0, (payload["type"] as? String) == MSG.heartbeat {
                lastHeartbeatEcho = Date().timeIntervalSince1970
                return
            }
            emit { self.onMessage?(from, payload) }

        case "created":
            let room = obj["room"] as? String ?? ""
            let instance = obj["instance"] as? String
            let region = obj["region"] as? String
            relayLog.notice("<- created room=\(room, privacy: .public) instance=\(instance ?? "nil", privacy: .public)")
            lastRoom = room
            lastInstance = instance
            reconnectAttempt = 0
            cancelHandshakeTimer()
            startHeartbeat()
            emit { self.onCreated?(room, instance, region) }

        case "joined":
            let room = obj["room"] as? String ?? lastRoom ?? ""
            let peers = (obj["peers"] as? [Any])?.compactMap { Self.intValue($0) } ?? []
            relayLog.notice("<- joined room=\(room, privacy: .public) peers=\(peers.count, privacy: .public)")
            lastRoom = room
            reconnectAttempt = 0
            cancelHandshakeTimer()
            startHeartbeat()
            emit { self.onJoined?(room, peers) }

        case "peer_joined":
            if let idx = Self.intValue(obj["index"]) { emit { self.onPeerJoined?(idx) } }

        case "peer_left":
            if let idx = Self.intValue(obj["index"]) { emit { self.onPeerLeft?(idx) } }

        case "error":
            let message = obj["message"] as? String ?? "unknown relay error"
            // NOTE: deliberately does NOT cancel the handshake timer — a non-fatal
            // error leaves the create/join still outstanding, so the deadline must
            // keep running. The fatal ones route through recreateRoom(), whose
            // connectLocked() cancels it.
            relayLog.notice("<- error \"\(message, privacy: .public)\"")
            emit { self.onRelayError?(message) }

        default:
            break   // e.g. AirConsole-only frames; ignored on the WS port
        }
    }

    // MARK: - Outbound

    private func onSocketOpened() {
        // Reconnect path sends join (clientId restores slot 0); first send creates.
        // The create registers the controller-URL template so clients holding
        // only the room code can resolve the controller page from the relay.
        if let room = lastRoom {
            relayLog.notice("socket open -> sending join room=\(room, privacy: .public)")
            sendEnvelope(["type": "join", "clientId": clientId, "room": room])
        } else {
            relayLog.notice("socket open -> sending create")
            sendEnvelope(["type": "create", "clientId": clientId, "maxClients": maxClients,
                          "url": Protocol.controllerURLTemplate])
        }
        startHandshakeTimeout()
        setState(.open)
    }

    /// Arm the created/joined answer deadline; a silent relay is treated as a
    /// drop so the capped backoff (and eventually the gave-up overlay) applies.
    private func startHandshakeTimeout() {
        cancelHandshakeTimer()
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + Self.handshakeTimeoutSeconds)
        timer.setEventHandler { [weak self] in
            guard let self, let old = self.task else { return }
            relayLog.error("handshake TIMEOUT after \(Self.handshakeTimeoutSeconds, privacy: .public)s — relay never answered create/join")
            self.task = nil
            old.cancel(with: .goingAway, reason: nil)
            self.handleDrop(closeCode: nil)
        }
        timer.resume()
        handshakeTimer = timer
    }

    private func cancelHandshakeTimer() {
        handshakeTimer?.cancel()
        handshakeTimer = nil
    }

    private func sendEnvelope(_ dict: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in /* failures surface via the receive loop */ }
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        stopHeartbeat()
        lastHeartbeatEcho = Date().timeIntervalSince1970
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.heartbeatTick() }
        timer.resume()
        heartbeatTimer = timer
    }

    private func stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
    }

    private func heartbeatTick() {
        let now = Date().timeIntervalSince1970
        if now - lastHeartbeatEcho > Self.heartbeatDeadSeconds {
            forceReconnect()
            return
        }
        sendEnvelope(["type": "send", "data": ["type": MSG.heartbeat], "to": 0])
    }

    // MARK: - Helpers

    private func setState(_ s: ConnectionState) {
        currentState = s
        emit { self.onConnectionState?(s) }
    }

    private func emit(_ block: @escaping () -> Void) {
        callbackQueue.async(execute: block)
    }

    private static func intValue(_ v: Any?) -> Int? {
        if let n = v as? Int { return n }
        if let n = v as? NSNumber { return n.intValue }   // JSON numbers land here; .intValue never traps
        if let d = v as? Double { return (d.isFinite && abs(d) < 9.0e15) ? Int(d) : nil }
        if let s = v as? String { return Int(s) }
        return nil
    }
}

// MARK: - WebSocket delegate (forwarded weakly, see `wsDelegate`)

extension RelayClient {
    fileprivate func socketDidOpen(_ webSocketTask: URLSessionWebSocketTask) {
        q.async {
            guard webSocketTask === self.task else { return }
            self.onSocketOpened()
        }
    }

    fileprivate func socketDidClose(_ webSocketTask: URLSessionWebSocketTask, closeCode: Int) {
        q.async {
            guard webSocketTask === self.task else { return }
            self.handleDrop(closeCode: closeCode)
        }
    }
}

/// The session's strongly-retained delegate; holds the client weakly so the
/// session never keeps RelayClient alive (see `RelayClient.wsDelegate`).
private final class WeakWebSocketDelegate: NSObject, URLSessionWebSocketDelegate {
    weak var client: RelayClient?

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        client?.socketDidOpen(webSocketTask)
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        client?.socketDidClose(webSocketTask, closeCode: closeCode.rawValue)
    }
}
