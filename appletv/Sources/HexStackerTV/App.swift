import GameController
import SwiftUI

@main
struct HexStackerApp: App {
    var body: some Scene {
        WindowGroup {
            RootHost()
                .ignoresSafeArea()
        }
    }
}

/// UIKit shim between the SwiftUI lifecycle and the chrome: the root view
/// controller owns the remote's focus-independent buttons (Play/Pause, Menu)
/// via pressesBegan. SwiftUI's onPlayPauseCommand/onExitCommand ride the focus
/// chain and are never delivered while nothing is focusable (countdown, live
/// gameplay), which is exactly when Play/Pause = pause and Menu = pause
/// matter. As the root, this controller sits in every responder chain, focused
/// or not. Select and the d-pad stay with the native focus engine.
private struct RootHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> PressHostController { PressHostController() }
    func updateUIViewController(_ controller: PressHostController, context: Context) {}
}

/// A GCEventViewController so the app can decide, per screen, whether a gamepad's
/// presses drive the focus engine or go only to the game. See
/// DisplayModel.syncPadInputOwnership for the rule and why it is not the same as
/// making the views unfocusable.
final class PressHostController: GCEventViewController {
    private let model = DisplayModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.setPadOwnsInput = { [weak self] padOwns in
            // The property is phrased the other way round: it asks whether
            // controller input should still reach the UI.
            self?.controllerUserInteractionEnabled = !padOwns
        }
        GCController.controllers().forEach(bindRemoteMenu)
        menuBinding = NotificationCenter.default.addObserver(
            forName: .GCControllerDidConnect, object: nil, queue: .main
        ) { [weak self] note in
            guard let controller = note.object as? GCController else { return }
            self?.bindRemoteMenu(controller)
        }
        // Pin Dynamic Type: the chrome is a fixed proportional canvas (Dimens.swift's
        // Vp), so text that scales independently of it has nowhere to go. tvOS ships no
        // text-size control today, which makes this a no-op, and that is the point. It
        // states the constraint instead of leaving it to Apple's settings screen, and
        // matches the Android pin (MainActivity's LocalDensity). Font.custom(_:size:)
        // is Dynamic-Type-relative, so without this the sizes are not actually fixed.
        let host = UIHostingController(
            rootView: DisplayRootView(model: model).dynamicTypeSize(.large))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Brand plum instead of the default systemBackground: the hosting
        // view is visible for a beat between the launch screen and SwiftUI's
        // first frame, and systemBackground flashed light grey there.
        view.backgroundColor = SKTheme.bgPrimary
        host.view.backgroundColor = SKTheme.bgPrimary
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private var menuBinding: NSObjectProtocol?

    deinit {
        if let menuBinding { NotificationCenter.default.removeObserver(menuBinding) }
    }

    /// The Siri Remote is itself a game controller, so suppressing controller
    /// UIEvents takes ITS Menu button away along with the pad's and `pressesBegan`
    /// simply stops firing — which left no way out of a running match. Menu is
    /// therefore read straight from GameController for the remote, identified as
    /// the controller with no `extendedGamepad`, the same test by which
    /// `GameControllerPadSource` decides what is not a pad.
    ///
    /// Gated on us actually owning input, because otherwise the press ALSO
    /// arrives as a `.menu` UIPress below and the pause would toggle twice.
    private func bindRemoteMenu(_ controller: GCController) {
        guard controller.extendedGamepad == nil else { return }
        controller.microGamepad?.buttonMenu.pressedChangedHandler = { [weak self] _, _, pressed in
            guard let self, pressed, !self.controllerUserInteractionEnabled,
                  !self.model.galleryMode else { return }
            _ = self.menu()
        }
    }

    /// ONE press, from whichever of the two doors it arrives at. Ownership decides
    /// which door that should be, but it cannot be the whole guard: `handleMenu`
    /// resuming a paused match flips ownership synchronously, so a press that came
    /// in as a UIPress lands in the GameController handler a moment later with the
    /// flag now saying "ours" — and dismissing the pause overlay immediately put it
    /// straight back up. The two deliveries are the same physical press, so the
    /// second is dropped on time rather than on state.
    private var lastMenuAt: CFTimeInterval = 0
    private func menu() -> Bool {
        let now = CACurrentMediaTime()
        guard now - lastMenuAt > 0.3 else { return true }
        lastMenuAt = now
        return model.handleMenu()
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard !model.galleryMode else {
            // Gallery: Play/Pause advances the carousel; everything else is
            // swallowed so a stray press can't disturb a frozen capture.
            for press in presses where press.type == .playPause { model.advanceGallery() }
            return
        }
        var handled = false
        for press in presses {
            switch press.type {
            case .playPause:
                model.playPause()
                handled = true
            case .menu:
                // At the top level handleMenu() declines and the press falls
                // through to super for the default exit to the home screen.
                handled = menu()
            default:
                break
            }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }
}
