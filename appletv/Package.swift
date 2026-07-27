// swift-tools-version:5.9
import PackageDescription

// HexStackerKit is the platform-agnostic core of the Apple TV port:
//  - EngineBridge: runs the canonical server/*.js game engine in JavaScriptCore
//  - Snapshot model: Codable structs mirroring Game.getSnapshot()
//  - RelayClient: the Party-Server display peer over WebSocket
//  - DisplayCoordinator: the display brain, with room state owned by the shared
//    server/RoomCore.js running inside the same JavaScriptCore context
//
// It depends only on system frameworks (JavaScriptCore, Foundation), so it
// builds and unit-tests on macOS via `swift test` WITHOUT full Xcode or the
// tvOS SDK. The tvOS app target (Sources/HexStackerTV, built through the
// XcodeGen project) consumes this same package and adds SpriteKit rendering,
// SwiftUI lobby, audio and QR.
let package = Package(
    name: "HexStacker",
    platforms: [
        .macOS(.v13),
        .tvOS(.v17),
    ],
    products: [
        .library(name: "HexStackerKit", targets: ["HexStackerKit"]),
    ],
    targets: [
        .target(
            name: "HexStackerKit",
            path: "Sources/HexStackerKit"
        ),
        // The single verification tier: engine determinism + full game loop
        // (EngineBridgeTests/DisplayCoordinatorTests), cross-engine render parity
        // (ParityTests), fastlane netcode (FastlaneTests), room/host FSM + geometry
        // (KitTests), localization, and the real RelayClient over a loopback socket
        // (RelayClientLiveTests). Runs under `swift test` with only Command Line
        // Tools installed (no full Xcode required); the suite rebuilds the engine
        // bundle from source (TestSupport) so it can never test a stale artifact.
        .testTarget(
            name: "HexStackerKitTests",
            dependencies: ["HexStackerKit"],
            path: "Tests/HexStackerKitTests"
        ),
    ]
)
