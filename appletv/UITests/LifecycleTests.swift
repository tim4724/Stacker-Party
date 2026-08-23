import XCTest

/// The app-suspend round trip (hardware session, 2026-08-08: two Bluetooth pads,
/// Home and back — the match then started with the countdown frozen on "3",
/// crawling to GO, and no boards). The scene's update() is the display's only
/// tick pump, so what this pins is that the pump is alive again after a
/// background + return: a match started afterwards runs its 3-2-1-GO at wall
/// speed instead of dilating. HEXLOBBY seeds fixture players (no relay), so the
/// flow is exactly the shell's — lobby, remote start, countdown, game screen.
final class LifecycleTests: XCTestCase {

    override func setUp() { continueAfterFailure = false }

    func testCountdownRunsAtWallSpeedAfterABackgroundRoundTrip() {
        let app = XCUIApplication()
        app.launchEnvironment["HEXLOBBY"] = "1"
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "app did not launch")
        Thread.sleep(forTimeInterval: 2.0)   // lobby entrance settles

        // Home and back — the round trip that left the scene's pump paused.
        XCUIDevice.shared.press(.home)
        _ = app.wait(for: .runningBackground, timeout: 10)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "app did not return to the foreground")
        Thread.sleep(forTimeInterval: 1.0)

        // Start the match: Play/Pause is the context Start in the lobby. The
        // countdown digit carries its own identifier because the board HUDs
        // also expose bare digit labels (start level, score).
        XCUIRemote.shared.press(.playPause)
        let digit = app.descendants(matching: .any).matching(identifier: "countdown-digit").firstMatch
        XCTAssertTrue(digit.waitForExistence(timeout: 5),
                      "the 3-2-1 did not go up on start\n\(app.debugDescription)")

        // 3-2-1-GO is 3.5s of wall time; the starved-pump bug held "3" for tens
        // of seconds. 8s from here is a healthy run with generous margin.
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: digit)
        waitForExpectations(timeout: 8)
        XCTAssertEqual(app.state, .runningForeground)
    }
}
