import Testing
import Foundation
@testable import HexStackerKit

/// Integration tests for the REAL `RelayClient` over a real loopback WebSocket
/// (`MockRelayServer`). These cover the URLSession WebSocket path the headless
/// `FakeTransport` suites can't reach: socket connect, the create/join handshake,
/// inbound frame decode + dispatch, outbound envelope shape, and auto-reconnect
/// with `clientId` re-join. No external network — the mock relay listens on
/// loopback with an ephemeral port. Runs under `swift test` on macOS.
///
/// The real client is intentionally not deterministic to the millisecond (real
/// sockets, real reconnect backoff), so assertions poll with generous deadlines.
/// Serialized: on a cold CI runner, concurrent URLSession connects to parallel
/// NWListeners have taken >10 s to open, blowing every in-flight deadline at
/// once; one live socket at a time keeps the timing assumptions honest.
@Suite(.serialized) struct RelayClientLiveTests {

    /// RelayClient delivers callbacks on `cbQueue` (a background serial queue), so
    /// a plain sleep-poll from the test thread observes the captured state without
    /// needing to pump the test thread's run loop.
    private let cbQueue = DispatchQueue(label: "relay.test.cb")

    private func waitUntil(_ timeout: TimeInterval = 5, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if cond() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return cond()
    }

    @Test func createHandshakeAndInboundDispatch() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, inst, _ in state.set { $0.room = room; $0.instance = inst } }
        client.onPeerJoined = { idx in state.set { $0.joined.append(idx) } }
        client.onMessage = { from, data in state.set { $0.messages.append((from, data)) } }

        client.connect()

        // The socket connected, the client sent `create`, and the server's
        // `created` reply was decoded back into onCreated with the room +
        // instance. The first open on a cold CI runner has taken >10 s.
        #expect(waitUntil(15) { state.get().room != nil }, "onCreated fired")
        #expect(state.get().room == server.roomCode)
        #expect(state.get().instance == server.instance)
        #expect(waitUntil { !server.receivedEnvelopes(type: "create").isEmpty }, "server saw a create")
        #expect(server.receivedEnvelopes(type: "create").first?["clientId"] as? String == "display",
                "create carries the display clientId")
        #expect(server.receivedEnvelopes(type: "create").first?["url"] as? String == HexStackerKit.Protocol.controllerURLTemplate,
                "create registers the controller-URL template for code-only joins")

        // Inbound peer_joined + message frames are decoded and dispatched.
        server.pushPeerJoined(1)
        #expect(waitUntil { state.get().joined == [1] }, "peer_joined dispatched")
        server.pushMessage(from: 1, data: ["type": "hello", "name": "Alice"])
        #expect(waitUntil { state.get().messages.count == 1 }, "message dispatched")
        #expect(state.get().messages.first?.0 == 1, "message carries the sender index")
        #expect((state.get().messages.first?.1["name"] as? String) == "Alice", "payload decoded")

        // Outbound: sendTo wraps the payload in a `send` envelope addressed to the peer.
        client.sendTo(1, ["type": "welcome"])
        #expect(waitUntil {
            server.receivedEnvelopes(type: "send").contains {
                ($0["to"] as? Int) == 1 && (($0["data"] as? [String: Any])?["type"] as? String) == "welcome"
            }
        }, "sendTo delivered a well-formed unicast envelope")

        // Broadcast omits `to`.
        client.broadcast(["type": "game_start"])
        #expect(waitUntil {
            server.receivedEnvelopes(type: "send").contains {
                $0["to"] == nil && (($0["data"] as? [String: Any])?["type"] as? String) == "game_start"
            }
        }, "broadcast omits the recipient")
    }

    @Test func reconnectsWithJoinAfterDrop() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }
        server.peersOnJoin = [1]

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.onJoined = { _, peers in state.set { $0.rejoinPeers = peers } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")
        #expect(server.connectionCount == 1)

        // The relay link drops. RelayClient must auto-reconnect (first backoff ~1 s)
        // and re-handshake with `join` + the pinned clientId — NOT another `create`,
        // which is what restores it to slot 0 on the relay.
        server.dropCurrentConnection()
        #expect(waitUntil(8) { server.connectionCount >= 2 }, "client reopened a socket")
        #expect(waitUntil(8) { !server.receivedEnvelopes(type: "join").isEmpty }, "reconnect sent join")
        let join = server.receivedEnvelopes(type: "join").first
        #expect(join?["clientId"] as? String == "display", "join carries the display clientId (slot-0 restore)")
        #expect(join?["room"] as? String == server.roomCode, "join re-pins the created room")
        #expect(server.receivedEnvelopes(type: "create").count == 1, "reconnect does not create a second room")
        #expect(waitUntil(3) { state.get().rejoinPeers == [1] }, "onJoined delivered the reconnect roster")
    }

    @Test func suspendClosesWithoutReconnectAndResumesWithJoin() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.onJoined = { _, peers in state.set { $0.rejoinPeers = peers } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")

        // Backgrounding suspends the socket. This is a deliberate close, so the
        // auto-reconnect that follows an ordinary drop must NOT fire.
        client.suspend()
        Thread.sleep(forTimeInterval: 1.5)   // past the first ~1 s backoff
        #expect(server.connectionCount == 1, "suspend did not auto-reconnect")

        // Foregrounding resumes with a fresh socket and a `join` that re-pins the
        // room + clientId (slot-0 restore), not a second `create`.
        client.reconnectNow()
        #expect(waitUntil(8) { server.connectionCount == 2 }, "resume opened a new socket")
        #expect(waitUntil(8) { !server.receivedEnvelopes(type: "join").isEmpty }, "resume sent join")
        let join = server.receivedEnvelopes(type: "join").first
        #expect(join?["clientId"] as? String == "display", "join carries the display clientId")
        #expect(join?["room"] as? String == server.roomCode, "join re-pins the suspended room")
        #expect(server.receivedEnvelopes(type: "create").count == 1, "resume does not create a second room")
        #expect(waitUntil(3) { state.get().rejoinPeers != nil }, "onJoined fired on resume")
    }

    @Test func roomClosedCloseUnpinsRoomAndRecreates() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")

        // The relay tore the room down (close 4001): the pinned room is dead,
        // so the auto-reconnect must open a FRESH room with `create`, not
        // bounce a `join` off "Room not found".
        server.closeCurrentConnection(code: 4001)
        #expect(waitUntil(8) { server.connectionCount >= 2 }, "client reconnected after 4001")
        #expect(waitUntil(8) { server.receivedEnvelopes(type: "create").count == 2 }, "reconnect sent a fresh create")
        #expect(server.receivedEnvelopes(type: "join").isEmpty, "no join against the closed room")
    }

    @Test func evictionCloseFiresOnReplacedWithoutReconnect() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.onReplaced = { state.set { $0.replaced = true } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")

        // The relay evicts this display (another client claimed the "display"
        // clientId): the 4000 close must surface as onReplaced (regardless of
        // whether URLSession reports it via the didCloseWith delegate or the
        // pending receive's failure) and must NOT auto-rejoin, which would
        // evict the replacement right back (takeover ping-pong).
        server.closeCurrentConnection(code: 4000)
        #expect(waitUntil(5) { state.get().replaced }, "onReplaced fired on close 4000")
        // A would-be reconnect fires after ~1 s of backoff; give it room to
        // (wrongly) appear before asserting it didn't.
        Thread.sleep(forTimeInterval: 1.5)
        #expect(server.connectionCount == 1, "evicted client did not reconnect")
    }

    /// Thread-safe capture of results delivered on the async callback queue.
    // MARK: - Recovery after the retry budget is spent

    /// Test double for the system path monitor: the test decides when the device
    /// "gets its network back". A real NWPathMonitor can't be driven from here,
    /// and stopping a loopback server doesn't change the system path at all.
    private final class FakeReachability: NetworkReachability {
        var onBecameReachable: (() -> Void)?
        private(set) var started = false
        func start() { started = true }
        func stop() { started = false }
        func fire() { onBecameReachable?() }
    }

    /// The reported field bug, reproduced end to end: Wi-Fi drops for longer than
    /// the retry budget, so all 5 attempts fail against a dead network and the
    /// client parks on `.closed`. Before the reachability escape it stayed there
    /// FOREVER — the captured device log showed 15 connects, every one failing in
    /// 2-33 ms (vs ~135 ms for a real handshake), then nothing ever again. The
    /// only recovery was a button press that happened to land after the interface
    /// had finished coming back up; pressing too early just burned another budget.
    @Test func reconnectsWhenTheNetworkReturnsAfterGivingUp() throws {
        let reach = FakeReachability()
        let server = try MockRelayServer(); try server.start()
        let port = server.port
        let baseURL = server.baseURL

        // Tight budget: same 5-attempt shape, milliseconds instead of ~13s.
        let client = RelayClient(baseURL: baseURL, clientId: "display", callbackQueue: cbQueue,
                                 maxReconnectAttempts: 5,
                                 reconnectBaseSeconds: 0.02, reconnectCapSeconds: 0.05,
                                 reachability: reach)
        defer { client.disconnect() }

        let state = Captured()
        let states = StateLog()
        client.onCreated = { room, inst, _ in state.set { $0.room = room; $0.instance = inst } }
        client.onJoined = { _, peers in state.set { $0.rejoinPeers = peers } }
        client.onConnectionState = { states.append($0) }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "connected and created a room")
        #expect(reach.started, "the client subscribes to reachability")

        // The outage: the relay endpoint goes away entirely, like Wi-Fi dropping.
        server.stop()
        #expect(waitUntil(10) { states.contains(.closed) },
                "the budget is spent and the client gives up")

        // Nothing retries on its own — this is the parked state the field log ended in.
        let attemptsAtGiveUp = server.connectionCount
        Thread.sleep(forTimeInterval: 0.5)
        states.clearAfterGiveUp()

        // Network back: the endpoint is live again, but the client has no reason
        // to know that until the path monitor tells it.
        let revived = try MockRelayServer(port: port); try revived.start()
        revived.peersOnJoin = [1, 2]
        defer { revived.stop() }
        Thread.sleep(forTimeInterval: 0.2)
        #expect(revived.connectionCount == 0,
                "still parked: a live endpoint alone does not wake the client")

        reach.fire()   // <- NWPathMonitor: .satisfied

        #expect(waitUntil(15) { state.get().rejoinPeers != nil },
                "the reachability signal reconnects and rejoins the pinned room")
        #expect(state.get().rejoinPeers == [1, 2], "the roster came back with the rejoin")
        #expect(revived.connectionCount > 0, "the client actually dialled the revived endpoint")
        #expect(server.connectionCount == attemptsAtGiveUp,
                "no attempts leaked to the dead endpoint while parked")
    }

    /// The escape must not fire when there is nothing to escape from: a path that
    /// merely flaps while the socket is healthy would otherwise tear down a live
    /// room and re-handshake for no reason.
    @Test func reachabilityIsIgnoredWhileTheLinkIsHealthy() throws {
        let reach = FakeReachability()
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue,
                                 reachability: reach)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "connected")

        let connectsWhenHealthy = server.connectionCount
        reach.fire(); reach.fire()
        Thread.sleep(forTimeInterval: 0.3)
        #expect(server.connectionCount == connectsWhenHealthy,
                "a satisfied path while .open must not re-dial")
    }

    /// Ordered log of connection states, for asserting the give-up and what
    /// follows it.
    private final class StateLog {
        private var v: [RelayClient.ConnectionState] = []
        private let l = NSLock()
        func append(_ s: RelayClient.ConnectionState) { l.lock(); v.append(s); l.unlock() }
        func contains(_ s: RelayClient.ConnectionState) -> Bool {
            l.lock(); defer { l.unlock() }; return v.contains(s)
        }
        func clearAfterGiveUp() { l.lock(); v.removeAll(); l.unlock() }
    }

    private final class Captured {
        struct State {
            var room: String?
            var instance: String?
            var joined: [Int] = []
            var messages: [(Int, [String: Any])] = []
            var rejoinPeers: [Int]?
            var replaced = false
        }
        private var s = State()
        private let l = NSLock()
        func set(_ f: (inout State) -> Void) { l.lock(); f(&s); l.unlock() }
        func get() -> State { l.lock(); defer { l.unlock() }; return s }
    }
}
