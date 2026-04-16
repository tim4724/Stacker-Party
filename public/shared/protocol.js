'use strict';

// Party-Server relay URL
var RELAY_URL = 'wss://ws.couch-games.com';

// Message types for game communication (inside Party-Server data field)
var MSG = {
  // Controller -> Display
  HELLO: 'hello',
  INPUT: 'input',
  SOFT_DROP: 'soft_drop',
  START_GAME: 'start_game',
  PLAY_AGAIN: 'play_again',
  RETURN_TO_LOBBY: 'return_to_lobby',
  PAUSE_GAME: 'pause_game',
  RESUME_GAME: 'resume_game',
  LEAVE: 'leave',
  SET_LEVEL: 'set_level',
  SET_MODE: 'set_mode',
  PING: 'ping',

  // Display -> Specific Controller
  WELCOME: 'welcome',
  GAME_OVER: 'game_over',
  LOBBY_UPDATE: 'lobby_update',
  PONG: 'pong',
  PLAYER_STATE: 'player_state',

  // Display -> All Controllers (broadcast)
  COUNTDOWN: 'countdown',
  GAME_START: 'game_start',
  GAME_END: 'game_end',
  GAME_PAUSED: 'game_paused',
  GAME_RESUMED: 'game_resumed',
  DISPLAY_CLOSED: 'display_closed',
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
  module.exports = { MSG, INPUT, ROOM_STATE, RELAY_URL };
}
