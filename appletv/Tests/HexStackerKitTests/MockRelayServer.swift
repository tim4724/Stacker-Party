import Foundation
import Network

/// A minimal in-process WebSocket relay that stands in for `ws.hexstacker.com`,
/// so the REAL `RelayClient` (URLSession WebSocket, create/join handshake,
/// reconnect, heartbeat) is exercised over a real loopback socket instead of the
/// headless `FakeTransport`. It speaks just enough of the Party-Server wire
/// protocol: it answers `create` → `created` and `join` → `joined`, echoes the
/// display self-heartbeat (so RelayClient's 6 s dead-socket watchdog never trips
/// mid-test), records every inbound envelope for assertions, and lets a test push
/// `peer_joined` / `peer_left` / `message` / `error` frames or drop the socket to
/// drive the reconnect path.
///
/// Loopback-only (`requiredInterfaceType = .loopback`) so `swift test` never
/// triggers the macOS incoming-connection firewall prompt, and an ephemeral port
/// so parallel test cases never collide.
final class MockRelayServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "mock.relay.server")
    private let lock = NSLock()

    private var connections: [NWConnection] = []
    private var latest: NWConnection?
    private var _received: [[String: Any]] = []
    private var _connectionCount = 0

    /// Room code handed back in `created`. Fixed so tests can assert the room pin.
    let roomCode = "TEST42"
    let instance = "inst1"
    /// Peers reported in a `joined` reply (the reconnect roster the test asserts).
    var peersOnJoin: [Int] = []

    /// `port` pins the listener instead of taking an ephemeral one, so a test can
    /// stop the server (an outage) and bring a fresh one back up at the SAME
    /// endpoint the client is still retrying — which is what "the network came
    /// back" looks like from the client's side. `allowLocalEndpointReuse` makes
    /// the immediate re-bind work.
    init(port: UInt16? = nil) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredInterfaceType = .loopback
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        if let port, let p = NWEndpoint.Port(rawValue: port) {
            listener = try NWListener(using: params, on: p)
        } else {
            listener = try NWListener(using: params)
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    }

    /// Start listening and block until the ephemeral port is assigned.
    func start(timeout: TimeInterval = 5) throws {
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.start(queue: queue)
        if ready.wait(timeout: .now() + timeout) == .timedOut {
            throw NSError(domain: "MockRelayServer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "listener did not become ready"])
        }
    }

    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var baseURL: String { "ws://127.0.0.1:\(port)" }

    /// Every inbound envelope the server has decoded, in arrival order.
    var received: [[String: Any]] {
        lock.lock(); defer { lock.unlock() }; return _received
    }

    /// How many sockets have connected over this server's lifetime (a reconnect
    /// shows up as a second connection).
    var connectionCount: Int {
        lock.lock(); defer { lock.unlock() }; return _connectionCount
    }

    func receivedEnvelopes(type: String) -> [[String: Any]] {
        received.filter { ($0["type"] as? String) == type }
    }

    // MARK: - Test-driven pushes (to the most recent connection)

    func pushPeerJoined(_ index: Int) { pushToLatest(["type": "peer_joined", "index": index]) }
    func pushPeerLeft(_ index: Int) { pushToLatest(["type": "peer_left", "index": index]) }
    func pushMessage(from: Int, data: [String: Any]) {
        pushToLatest(["type": "message", "from": from, "data": data])
    }
    func pushError(_ message: String) { pushToLatest(["type": "error", "message": message]) }

    /// Force-close the current socket so RelayClient sees a drop and reconnects.
    func dropCurrentConnection() {
        lock.lock(); let c = latest; lock.unlock()
        c?.cancel()
    }

    /// Close the current socket with a WebSocket close frame carrying `code`
    /// (4000 = evicted: another client claimed this clientId's slot).
    func closeCurrentConnection(code: UInt16) {
        lock.lock(); let c = latest; lock.unlock()
        guard let c else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        meta.closeCode = .privateCode(code)
        let ctx = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        c.send(content: nil, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }

    func stop() {
        listener.cancel()
        lock.lock(); let conns = connections; connections = []; latest = nil; lock.unlock()
        conns.forEach { $0.cancel() }
    }

    // MARK: - Internals

    private func accept(_ conn: NWConnection) {
        lock.lock(); connections.append(conn); latest = conn; _connectionCount += 1; lock.unlock()
        conn.start(queue: queue)
        receive(on: conn)
    }

    private func pushToLatest(_ dict: [String: Any]) {
        lock.lock(); let c = latest; lock.unlock()
        if let c { send(dict, on: c) }
    }

    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let data, !data.isEmpty,
               let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                   as? NWProtocolWebSocket.Metadata {
                if meta.opcode == .close { return }   // stop the loop on a close frame
                if (meta.opcode == .text || meta.opcode == .binary),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.handle(obj, on: conn)
                }
            }
            if error == nil { self.receive(on: conn) }
        }
    }

    private func handle(_ obj: [String: Any], on conn: NWConnection) {
        lock.lock(); _received.append(obj); lock.unlock()
        switch obj["type"] as? String {
        case "create":
            send(["type": "created", "room": roomCode, "instance": instance, "region": "eu"], on: conn)
        case "join":
            let room = (obj["room"] as? String) ?? roomCode
            send(["type": "joined", "room": room, "peers": peersOnJoin], on: conn)
        case "send":
            // Echo the display self-heartbeat (a `send` to slot 0) so RelayClient's
            // 6 s dead-socket watchdog stays quiet during a longer test wait.
            if let to = obj["to"] as? Int, to == 0,
               let data = obj["data"] as? [String: Any], (data["type"] as? String) == "_heartbeat" {
                send(["type": "message", "from": 0, "data": data], on: conn)
            }
        default:
            break
        }
    }

    private func send(_ dict: [String: Any], on conn: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
        conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }
}
