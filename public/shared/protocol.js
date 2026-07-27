'use strict';

// Party-Server relay URL
var RELAY_URL = 'wss://ws.hexstacker.com';

// First-party STUN server (self-hosted, see https://couch-games.com/privacy).
// Used by the fastlane to gather server-reflexive candidates so cross-network
// peers can find each other when host candidates aren't reachable.
var STUN_URL = 'stun:stun.hexstacker.com:3478';

// Message types for game communication (inside Party-Server data field)
var MSG = {
  // Controller -> Display
  HELLO: 'hello',
  INPUT: 'input',
  SOFT_DROP: 'soft_drop',
  SOFT_DROP_END: 'soft_drop_end',
  START_GAME: 'start_game',
  PLAY_AGAIN: 'play_again',
  RETURN_TO_LOBBY: 'return_to_lobby',
  PAUSE_GAME: 'pause_game',
  RESUME_GAME: 'resume_game',
  LEAVE: 'leave',
  SET_LEVEL: 'set_level',
  SET_COLOR: 'set_color',
  SET_NAME: 'set_name',
  SET_DISPLAY_MUTE: 'set_display_mute',
  PING: 'ping',

  // Display -> Specific Controller
  //
  // This is the whole set. Everything the display used to say ABOUT THE ROOM
  // (identity, roster, host, room state, countdown, pause, mute, results, and
  // which screen to show) now rides one retained snapshot published with
  // set_state, so there is no second channel left that could disagree with it.
  // See server/RoomBrain.js, which builds that snapshot for all three displays.
  //
  // Retired with the snapshot, and deliberately NOT kept as reserved names:
  // welcome, lobby_update, game_start, countdown, game_end, game_over,
  // game_paused, game_resumed, display_muted. A controller from before the
  // change simply never hears them; it was already being replaced wholesale
  // (they ship together), and leaving the constants around invites a new send.
  PONG: 'pong',
  PLAYER_STATE: 'player_state',

  // Display -> All Controllers (broadcast)
  ERROR: 'error'
};

// Input action types
var INPUT = {
  LEFT: 'left',
  RIGHT: 'right',
  ROTATE_CW: 'rotate_cw',
  HARD_DROP: 'hard_drop',
  HOLD: 'hold'
};

// Room states (display-side)
var ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results'
};

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MSG, INPUT, ROOM_STATE, RELAY_URL, STUN_URL };
}
