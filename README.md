# Tetris Party

Browser-based multiplayer Tetris where phones become controllers and a shared screen shows the action.

## Overview

Tetris Party supports 1--4 players on a single shared display. One browser window acts as the game screen (TV, monitor, or laptop), while each player joins by scanning a QR code with their phone. The phone becomes a touch-based controller with gesture input and haptic feedback. All game logic runs on a server-authoritative Node.js backend communicating over WebSockets.

## Architecture

```
[Phone 1] ──ws──┐
[Phone 2] ──ws──┤
[Phone 3] ──ws──┼──> [Node.js Server] ──ws──> [Display Browser]
[Phone 4] ──ws──┘    (authoritative)          (shared screen)
```

- **Server**: Runs all game logic at 60 Hz, broadcasts state at 20 Hz.
- **Display**: Renders every player's board on a single Canvas, purely presentational.
- **Controller**: Captures touch gestures and sends input actions over WebSocket.

## Features

- 1--4 players on one screen
- QR code join -- scan and play, no app install
- SRS rotation system with wall kicks
- 7-bag randomizer for fair piece distribution
- Competitive mode with garbage lines (attacker-colored indicator on incoming garbage)
- Race mode (40-line sprint)
- Touch gesture controls with haptic feedback
- Canvas rendering at 60 fps
- 20 Hz state broadcast to all clients
- 30-second reconnection grace period with paused/KO state restored on rejoin
- T-spin and back-to-back bonus scoring

## Quick Start

```bash
npm install
node server/index.js
```

1. Open `http://localhost:4000/display/` on a big screen (TV, monitor, or projector).
2. Scan the QR code shown on the display with your phone.
3. Once players have joined, start the game from the display screen.

## How to Play

1. **Set up the display.** Open the display URL in a browser on a large screen visible to all players.
2. **Join the game.** Each player scans the QR code with their phone. The phone browser opens a controller page automatically.
3. **Start.** The display host selects a game mode and starts the match. A 3-second countdown begins.
4. **Play.** Use touch gestures on your phone to control your falling pieces. Your board is shown on the shared display alongside other players.
5. **Win.** In competitive mode, the last player alive wins. In race mode, the first to clear 40 lines wins.

## Controller Gestures

| Gesture | Action |
|---|---|
| Drag left/right | Move piece horizontally (ratcheting at 44 px steps) |
| Tap | Rotate clockwise |
| Flick down | Hard drop |
| Drag down + hold | Soft drop (variable speed based on drag distance) |
| Flick up | Hold piece |

All gestures provide haptic feedback on supported devices. The controller uses axis locking so horizontal and vertical movements do not interfere with each other.

## Game Modes

### Competitive

Players compete head-to-head. Clearing multiple lines or scoring T-spins sends garbage lines to opponents. Back-to-back difficult clears receive a 1.5x bonus. The last player standing wins.

### Race

Players race to clear a target number of lines (default: 40). A 5-minute time limit applies. The first player to reach the goal wins. No garbage is exchanged between players.

## Project Structure

```
server/
  index.js           # HTTP + WebSocket server, room routing
  Room.js            # Room lifecycle, lobby, countdown, game loop
  Game.js            # Per-player game state coordination
  PlayerBoard.js     # Board grid, piece placement, line clears
  Piece.js           # Piece definitions, SRS rotation and wall kicks
  Randomizer.js      # 7-bag random piece generator
  Scoring.js         # Score calculation, combos, T-spins, back-to-back
  GarbageManager.js  # Garbage line generation and distribution
  constants.js       # Timing, scoring tables, room limits

public/
  display/
    index.html       # Display page entry point
    display.js       # Display WebSocket client, state management
    BoardRenderer.js # Canvas rendering of player boards
    UIRenderer.js    # HUD, scores, countdown, results overlay
    Animations.js    # Line clear and garbage animations
    Music.js         # Background music and sound effect playback
    display.css      # Display layout styles
  controller/
    index.html       # Controller page entry point
    controller.js    # Controller WebSocket client, input relay
    TouchInput.js    # Touch gesture recognition engine
    controller.css   # Controller layout styles
  shared/
    protocol.js           # Message types and constants (server + client)
    colors.js             # Piece color definitions
    theme.css             # Shared design tokens and UI components
    theme.js              # Theme constants exposed to JavaScript
    WelcomeBackground.js  # Animated particle background
    CanvasUtils.js        # Shared canvas drawing utilities
    results.css           # Results screen styles
```

## Tech Stack

- **Runtime**: Node.js
- **WebSocket**: [ws](https://github.com/websockets/ws)
- **QR codes**: [qrcode](https://github.com/soldair/node-qrcode)
- **Frontend**: Vanilla JavaScript, Canvas API
- **Dependencies**: 2 npm packages total (`ws`, `qrcode`)

No build step. No bundler. No framework. Serve and play.
