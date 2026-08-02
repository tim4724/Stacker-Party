import Foundation
import Network
import os

private let advertiseLog = Logger(subsystem: "com.hexstacker.tv", category: "advertise")

/// CouchPad room advertisement (contract §8): publishes the open room over
/// DNS-SD so the CouchPad launcher on a phone in the same house can offer a
/// one-tap join with no QR scan and no typed room code.
///
/// The room code is the entire payload. The launcher resolves it against the
/// relay (the same probe a typed code takes), and that answer, not the LAN,
/// supplies the join URL, the platform tag and whether the room is still open.
/// So an advertisement can name a room but cannot propose an origin, and this
/// display declares itself in exactly one place: the controller-URL template it
/// registers at create (Protocol.controllerURLTemplate). There is no version key
/// either: `_couchpad._tcp` plus a code some relay knows is the whole gate.
///
/// The launcher never dials the SRV port, so the TCP listener here exists only
/// because DNS-SD registration needs a port to publish; anything that does
/// connect is dropped.
///
/// The service instance name is deliberately left nil, which makes Bonjour use
/// the device's own name ("Spielzimmer"). That name is what the launcher shows
/// verbatim, so a player with two Apple TVs can tell the rooms apart.
/// UIDevice.name cannot serve here: since tvOS 16 it is a synonym for the model
/// and reads "Apple TV" on every box.
///
/// Everything about this is an accelerator, never the only route in. mDNS is
/// blocked on AP-isolated and guest networks, and the local-network permission
/// (already requested for the WebRTC fastlane) can be declined, so failures are
/// logged and swallowed. The QR and room code stay the universal path.
final class RoomAdvertiser {

    static let serviceType = "_couchpad._tcp"

    /// TXT key for the room code (§8).
    private static let codeKey = "c"

    private var listener: NWListener?
    private var advertisedRoom: String?

    /// Publish `room`, replacing any live record. Idempotent: every relay rejoin
    /// re-confirms the same room, and re-registering on each one would churn the
    /// network for nothing.
    func advertise(room: String) {
        if room == advertisedRoom, listener != nil { return }
        guard !room.isEmpty else {
            withdraw()
            return
        }
        withdraw()
        do {
            let listener = try NWListener(using: .tcp)
            listener.service = NWListener.Service(
                type: Self.serviceType,
                txtRecord: NWTXTRecord([Self.codeKey: room])
            )
            listener.newConnectionHandler = { $0.cancel() }
            listener.stateUpdateHandler = { state in
                // .failed is where a declined local-network permission surfaces.
                if case .failed(let error) = state {
                    advertiseLog.error("advertise failed: \(error.localizedDescription, privacy: .public)")
                }
            }
            listener.serviceRegistrationUpdateHandler = { change in
                if case .add(let endpoint) = change {
                    advertiseLog.notice("advertising as \(String(describing: endpoint), privacy: .public)")
                }
            }
            listener.start(queue: .main)
            self.listener = listener
            advertisedRoom = room
        } catch {
            advertiseLog.error("advertise listener refused to start: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Withdraw the record (an mDNS goodbye). Cancelling the listener is what
    /// sends it; a record that outlives its room only costs a player a wasted
    /// tap (the code then resolves to nothing and no card appears), but there is
    /// no reason to leave one up.
    func withdraw() {
        listener?.cancel()
        listener = nil
        advertisedRoom = nil
    }
}
