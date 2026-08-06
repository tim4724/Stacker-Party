import XCTest

/// Captures every frozen display state for the cross-platform gallery in a SINGLE
/// app launch. The app (HEXGALLERY) presents a fresh scene per state and reports
/// the rendered state's name through an accessibility marker; this test reads that
/// name, captures the screen, and presses Play/Pause to advance. One launch (vs
/// the old one cold launch per state) is the bulk of the macOS CI speed-up, and
/// each captured screen still doubles as a "this state renders without crashing"
/// check.
///
/// The app owns the ordered state list (`DisplayModel.galleryStates`, which
/// mirrors the `tvos` entries in scripts/gallery/scenarios.json) and reports each
/// name, so attachment names can't drift out of order. The TV Gallery workflow
/// matches attachments by that name.
final class ScreenshotTests: XCTestCase {

    override func setUp() {
        // One bad screen shouldn't hide the rest of the gallery.
        continueAfterFailure = true
    }

    func testCaptureEveryDisplayState() {
        let app = XCUIApplication()
        app.launchEnvironment["HEXGALLERY"] = "1"
        // Capture in English regardless of the simulator locale, so the gallery
        // columns read the same as the web/Android references.
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20),
                      "app did not reach the foreground")

        // The render view exposes the carousel state: label = total count,
        // value = currently-rendered state name ("pending" until the first frame).
        let marker = app.descendants(matching: .any)
            .matching(identifier: "hexshot-marker").firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 20), "gallery marker never appeared")

        let total = Int(marker.label) ?? 0
        XCTAssertGreaterThan(total, 0, "gallery reported no states (label=\(marker.label))")

        var lastName = "pending"
        var lastShot: Data?
        for i in 0..<total {
            // Wait for the marker's value to CHANGE to the next state's name (it
            // holds the previous name through the scene swap, so a changed value
            // means the new frozen frame is on screen and settled). Polled by
            // hand at 5 Hz: XCTNSPredicateExpectation only polls at 1 Hz, which
            // added most of a second per state. 60s deadline: locally a state
            // settles in ~0.3s, but the shared CI runner rasterizes the heavy
            // board states (full stacks, per-board QRs) an order of magnitude
            // slower on bad days (a 15s deadline used to flake), so keep the
            // margin wide.
            let waitStart = Date()
            let deadline = waitStart.addingTimeInterval(60)
            var name = (marker.value as? String) ?? ""
            while name == lastName, Date() < deadline {
                usleep(200_000)
                name = (marker.value as? String) ?? ""
            }
            XCTAssertNotEqual(name, lastName,
                              "state \(i): app never signalled the next frozen frame")

            let shotStart = Date()
            let screenshot = XCUIScreen.main.screenshot()
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = name
            attachment.lifetime = .keepAlways   // keep on success, not just failure
            add(attachment)
            // The marker says the APP rendered; it says nothing about what the
            // screen is showing. On a simulator whose window server hasn't come
            // up, every capture is the same frozen boot framebuffer. A real run
            // shipped 24 Apple logos to the gallery (22 sharing one hash) and
            // still went green. Distinct frozen states never render identical
            // frames, so an exact repeat means we captured the screen, not the app.
            let png = screenshot.pngRepresentation
            XCTAssertNotEqual(png, lastShot, "state \(name): captured a frame "
                              + "byte-identical to the previous state, so the display "
                              + "is almost certainly still on the simulator boot screen")
            lastShot = png
            let now = Date()
            NSLog("hexshot[%d] %@: wait=%.2fs shot=%.2fs", i, name,
                  shotStart.timeIntervalSince(waitStart), now.timeIntervalSince(shotStart))
            lastName = name

            if i < total - 1 { XCUIRemote.shared.press(.playPause) }
        }
    }
}
