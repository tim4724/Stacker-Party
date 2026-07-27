// Type declarations for PartyCore (server engine). Hand-written; keep in sync
// with PartyCore.js. The UMD module exposes the class as a NAMED export
// (`exports.PartyCore`), so consumers do
// `const { PartyCore } = require('./server/PartyCore')`.
//
// PartyCore is the PULL-ONLY native-integration surface. It wraps a stateful
// Game and inverts Game's host-callback push (onEvent/onGameEnd) into a drained,
// ordered, plain-serializable events array; returns a VALUE-COPY snapshot (a deep
// clone the host may retain and mutate without touching the engine); and
// normalizes each frame's events + snapshot into a serializable host-effect
// `commands` list (no protocol.js coupling — the host maps command type ->
// MSG/sendTo/animation). It reads no wall clock, no timers, no DOM, no I/O: time
// is injected via `frame(nowMs)`.
//
// === LOADER CONTRACT (native hosts) ===========================================
// These UMD modules detect their environment with `typeof require !== 'undefined'
// ? require('./X') : window.X`. Bare JavaScriptCore (tvOS) / QuickJS (Android)
// have NO module system and NO `window`/`console`, so the host MUST, before
// loading any engine module:
//   1. Provide a global object the UMD fallback can read. Either define `require`
//      (returning the already-loaded module by relative path) OR define
//      `window`/`globalThis` and hang each module's exports off it under the
//      browser global names below. The modules write their exports onto that same
//      global, so loading them in dependency order makes each one's `window.X`
//      lookup resolve against the previously loaded module.
//   2. Provide a `console` shim (or accept that the engine's guarded
//      `typeof console !== 'undefined' && console.error(...)` calls no-op). Only
//      Game's board-tick error path touches console; it is guarded.
//
// Module load order (browser-global name in parens; each depends only on
// already-loaded modules):
//   constants.js      (window.GameConstants)     — no deps
//   Randomizer.js     (window.GameRandomizer)    — constants
//   Piece.js          (window.PieceModule)       — constants
//   GarbageManager.js (window.GameGarbageManager)— constants
//   PlayerBoard.js    (window.PlayerBoardModule) — constants, Randomizer, Piece
//   Game.js           (window.GameEngine)        — PlayerBoard, GarbageManager,
//                                                  Randomizer, constants
//   PartyCore.js      (window.GameEngine)        — Game, constants
// Game.js assigns `window.GameEngine = {}` (a reset); PartyCore.js then does
// `window.GameEngine = window.GameEngine || {}` and adds itself — so Game MUST be
// loaded before PartyCore, and both end up on `window.GameEngine`.
// RoomFlow.js (partyplug) is INDEPENDENT of this graph and is a separate 1Hz pull.
//
// === GRAVITY DETERMINISM ASSUMPTION ===========================================
// The engine's gravity uses only correctly-rounded IEEE-754 double arithmetic,
// which ECMAScript mandates to be bit-identical across V8/JSC/QuickJS. Therefore
// a host that LOADS this shared JS (rather than reimplementing the engine) will
// reproduce the V8-recorded golden replays bit-for-bit. The host's only
// obligation is a MONOTONIC clock fed to `frame(nowMs)`; deltaMs is capped (see
// MAX_FRAME_DELTA_MS) so a hitch can't diverge the simulation. Consequently a
// per-port conformance check is a golden REPLAY of the shared engine, not a
// reimplementation to be diffed.

export { PartyCore };

declare class PartyCore {
  /**
   * @param players Iterable of `[playerId, options]` entries (e.g. a Map). Each
   *   id seeds one board; the order fixes player order. `options` may be omitted/
   *   undefined.
   * @param seed Shared RNG seed so every player gets the same piece sequence.
   *   Omit/null to pick a random seed (non-deterministic — pass an explicit seed
   *   for golden replays).
   */
  constructor(
    players: Iterable<readonly [string, PartyCore.PlayerOptions | undefined]>,
    seed?: number | null
  );

  /** Cap (ms) applied to each `frame()` deltaMs (~3 frames at 60Hz). Re-exported
   *  from the shared constants module so the web rAF loop and native `frame()`
   *  can't drift. Value: 50. */
  static MAX_FRAME_DELTA_MS: number;

  /** Signature of everything a renderer draws from a snapshot: equal signatures
   *  paint the same picture. Pure. `deliverFrame()` uses it to skip delivering a
   *  render-identical frame; exposed so a host can apply the same test to a
   *  snapshot it obtained some other way. */
  static sceneSig(snapshot: PartyCore.Snapshot): string;

  /** The wrapped Game engine. Internal/white-box (tests reach into `game.boards`
   *  / `game.garbageManager`); NOT part of the native contract — drive PartyCore
   *  through the methods below. */
  game: any;

  /** Spawn the first piece on every board. Call once after construction, before
   *  the first `frame()`/`update()`. */
  init(): void;

  // --- input passthroughs ---------------------------------------------------
  // Synchronous: engine events accumulate in the internal buffer and surface at
  // the next `drainEvents()`/`frame()` (mirrors the web's between-frame
  // processInput accumulation). All no-op for an unknown/dead player or after the
  // match has ended.
  /** Discrete action. `hard_drop` is silently throttled per player (150ms floor)
   *  so queued repeats can't rapid-fire. */
  processInput(playerId: string, action: PartyCore.InputAction): void;
  /** Begin continuous soft drop. `speed` is the soft-drop rate (cells/sec scale,
   *  engine-defined). */
  handleSoftDropStart(playerId: string, speed: number): void;
  handleSoftDropEnd(playerId: string): void;

  // --- lifecycle ------------------------------------------------------------
  /** Freeze gravity/timers (no-op once ended). `update()`/`frame()` self-gate
   *  while paused. */
  pause(): void;
  resume(): void;
  /** Cross-device claim: rekey the engine's per-player state from `oldId` to
   *  `newId` (boards, playerIds, hard-drop cooldown, garbage queues) via the
   *  canonical `Game.rekeyPlayer`. `false` (no-op) when `oldId` is unknown,
   *  equals `newId`, or `newId` already owns a board (forged-claim guard);
   *  `true` if a board moved. Native ports call this on a claim HELLO. */
  rekeyPlayer(oldId: string, newId: string): boolean;
  /** Advance the engine by `deltaMs`. Individually callable for the native
   *  granular path; self-gates on paused/ended. `frame()` calls this internally —
   *  don't also call it in the same tick. */
  update(deltaMs: number): void;

  // --- reads ----------------------------------------------------------------
  /** VALUE-COPY snapshot: a deep clone of the engine's live mutable refs, so the
   *  host may RETAIN it across frames and mutate it freely without affecting the
   *  engine. Web keeps a separate zero-copy live-ref path for its within-frame
   *  render; native calls this (or relies on `frame()`'s) only on gridVersion
   *  change. */
  snapshot(): PartyCore.Snapshot;
  /** VALUE-COPY snapshot of ONE seat (same shape, `players` narrowed to that
   *  player), for reflecting a single controller input without deep-copying the
   *  whole room. `null` when the id owns no board. */
  snapshotPlayer(playerId: string): PartyCore.Snapshot | null;
  /** Return the events accumulated since the last drain (emission order) and
   *  reset the buffer. `frame()` drains internally — don't also drain in the same
   *  tick or you'll split the frame's events. */
  drainEvents(): PartyCore.EngineEvent[];

  // --- frame clock ----------------------------------------------------------
  /**
   * CALLER RESPONSIBILITY. Forget the previous `nowMs` so the next `frame()`
   * re-primes with deltaMs=0 instead of a large catch-up step. The native host
   * MUST call this whenever it leaves the active loop (pause, results) — without
   * it, the first `frame()` after a gap (app resume, results screen) would feed a
   * huge elapsed delta (still capped at MAX_FRAME_DELTA_MS, but a full ~50ms jump)
   * into the engine. Mirrors the web DisplayRender prevFrameTime=0 reset.
   */
  resetFrameClock(): void;

  /**
   * Pull one engine frame. Converts `nowMs` into a delta, ticks the engine
   * (self-gating on paused/ended), and returns this frame's events, a value-copy
   * snapshot, and the normalized host-effect commands.
   *
   * deltaMs derivation:
   *   - First call after construction or `resetFrameClock()`: deltaMs = 0 (priming
   *     — establishes the clock, does NOT tick the engine).
   *   - Otherwise deltaMs = clamp(nowMs - prevNowMs, 0, MAX_FRAME_DELTA_MS). A
   *     BACKWARD `nowMs` (clock reset / resume hiccup) clamps to 0; a large gap
   *     clamps to MAX_FRAME_DELTA_MS.
   *
   * The host decides WHETHER to call `frame()` (only while playing && !paused,
   * matching the web rAF loop) and MUST call `resetFrameClock()` when leaving that
   * loop. The returned `snapshot` and the `blocks`/`clearCells`/`results` inside
   * `commands` are de-aliased copies, safe to retain/transform without corrupting
   * the parallel `events` entries.
   *
   * @param nowMs Monotonic timestamp (ms). Only deltas matter; the origin is free.
   */
  frame(nowMs: number): PartyCore.FrameResult;

  // --- delivery (what a native host should actually pull) --------------------
  /**
   * `frame()` filtered for the JS<->native boundary, and what both TV ports call
   * every tick. Events and commands always ride in full; the `snapshot` is
   *
   *   - ABSENT when this frame is render-identical to the last delivered one
   *     (see `PartyCore.sceneSig`) — keep rendering the retained snapshot, and
   *     skip both the decode and the repaint;
   *   - otherwise present, with each player's `grid` OMITTED while its
   *     `gridVersion` is unchanged since the last delivery. The host re-attaches
   *     the rows it cached (both EngineBridge implementations do).
   *
   * Both filters are stateful (per instance, reset by a new game and by
   * `rekeyPlayer`), which is exactly why they live here rather than in each
   * host's bootstrap shim.
   */
  deliverFrame(nowMs: number): PartyCore.DeliveredFrame;
  /** `snapshot()` with the same grid stripping `deliverFrame` applies. Does NOT
   *  affect the scene signature: an out-of-band pull is not a delivered frame. */
  deliverSnapshot(): PartyCore.DeliveredSnapshot;
}

declare namespace PartyCore {
  /** Discrete controller actions accepted by `processInput`. Soft drop is its own
   *  start/end pair, not an action here. */
  type InputAction = 'left' | 'right' | 'rotate_cw' | 'hard_drop' | 'hold';

  interface PlayerOptions {
    /** Starting level (gravity tier). Default 1. */
    startLevel?: number;
  }

  interface FrameResult {
    events: EngineEvent[];
    snapshot: Snapshot;
    commands: HostCommand[];
  }

  /** A snapshot as DELIVERED: `grid` is absent on players whose rows the host
   *  already holds (unchanged `gridVersion`). */
  type DeliveredSnapshot = Omit<Snapshot, 'players'> & {
    players: (Omit<PlayerSnapshot, 'grid'> & { grid?: number[][] })[];
  };

  /** `deliverFrame()`: `snapshot` absent on a render-identical frame. */
  interface DeliveredFrame {
    events: EngineEvent[];
    snapshot?: DeliveredSnapshot;
    commands: HostCommand[];
  }

  // --- snapshot -------------------------------------------------------------
  interface Snapshot {
    players: PlayerSnapshot[];
    /** Total simulated time (ms) since `init()`. */
    elapsed: number;
  }

  interface PlayerSnapshot {
    id: string;
    /** Visible rows (buffer rows excluded), each a row of cells. 0 = empty, else
     *  a piece typeId. */
    grid: number[][];
    /** Active piece, or null when none is in play. */
    currentPiece: PieceState | null;
    /** Hard-drop landing preview for `currentPiece` (null when no active piece).
     *  `typeId` is surfaced (copied from currentPiece) so a renderer can color the
     *  ghost without reaching into currentPiece. */
    ghost: GhostState | null;
    /** Held piece type, or null. */
    holdPiece: string | null;
    /** Up to the next 3 upcoming piece types. */
    nextPieces: string[];
    level: number;
    lines: number;
    alive: boolean;
    /** Incoming garbage lines: board-pending + delayed GarbageManager queue. */
    pendingGarbage: number;
    /** Cells currently animating a line clear (`[col, row]`, visible coords), or
     *  null. */
    clearingCells: Array<[number, number]> | null;
    /** Bumped on lock/clear/garbage. Native may copy the snapshot only when this
     *  changes. */
    gridVersion: number;
  }

  interface PieceState {
    /** Piece type name (e.g. shape key). */
    type: string;
    /** Numeric piece id (matches grid cell values). */
    typeId: number;
    anchorCol: number;
    /** Visible-space anchor row (buffer rows already subtracted). */
    anchorRow: number;
    /** Shape cells in axial offsets from the anchor. */
    cells: Array<{ q: number; r: number }>;
    /** Absolute occupied cells as `[col, row]` in visible space. */
    blocks: Array<[number, number]>;
  }

  interface GhostState {
    /** Equals the current piece's typeId (or null if there is no current piece). */
    typeId: number | null;
    anchorCol: number;
    anchorRow: number;
    blocks: Array<[number, number]>;
  }

  // --- engine events (the complete, ordered record; from onEvent + onGameEnd) -
  type EngineEvent =
    | PieceLockEvent
    | LineClearEvent
    | PlayerKOEvent
    | GarbageCancelledEvent
    | GarbageSentEvent
    | GameEndEvent;

  interface PieceLockEvent {
    type: 'piece_lock';
    playerId: string;
    /** Locked cells, `[col, row]` visible space. */
    blocks: Array<[number, number]>;
    typeId: number;
  }
  interface LineClearEvent {
    type: 'line_clear';
    playerId: string;
    lines: number;
    /** Full row indices that cleared. */
    rows: number[];
    /**
     * Visible [col, row] cells of the cleared lines. Non-null: a line_clear event
     * only fires when lines > 0, where the engine always supplies the array.
     */
    clearCells: Array<[number, number]>;
  }
  interface PlayerKOEvent {
    type: 'player_ko';
    playerId: string;
  }
  interface GarbageCancelledEvent {
    type: 'garbage_cancelled';
    playerId: string;
    lines: number;
  }
  interface GarbageSentEvent {
    type: 'garbage_sent';
    senderId: string;
    toId: string;
    lines: number;
  }
  /** Terminal event (the inverted onGameEnd callback). */
  interface GameEndEvent {
    type: 'game_end';
    elapsed: number;
    results: ResultEntry[];
  }

  interface ResultEntry {
    playerId: string;
    alive: boolean;
    lines: number;
    level: number;
    /** 1-based final placement (alive first, then lines desc). */
    rank: number;
  }

  // --- host commands (normalized per-frame host effects) --------------------
  // Note: there is NO `gameOver` command. A player's elimination is surfaced as
  // `playerKO` + `playerState{alive:false}` + `playerEliminated`; the host maps
  // `playerEliminated` to its own MSG.GAME_OVER send. The match-end command is
  // `gameEnd`.
  type HostCommand =
    | PieceLockCommand
    | LineClearCommand
    | PlayerStateCommand
    | PlayerKOCommand
    | PlayerEliminatedCommand
    | GarbageCancelledCommand
    | GarbageSentCommand
    | GameEndCommand;

  interface PieceLockCommand {
    type: 'pieceLock';
    playerId: string;
    blocks: Array<[number, number]>;
    typeId: number;
  }
  interface LineClearCommand {
    type: 'lineClear';
    playerId: string;
    clearCells: Array<[number, number]>;
    lines: number;
  }
  /**
   * The per-player facts a controller acts on the instant they change, rather
   * than on the next retained-snapshot push. Emitted in two forms:
   *   - after `line_clear`: `{ lines, alive }` (alive can be false, when the same
   *     frame's clear also topped the player out).
   *   - after `player_ko`: only `{ alive: false }`.
   *
   * Deliberately NOT the player's whole HUD: `level` and a pre-resolved
   * `garbageIncoming` used to ride along here and no controller ever read either,
   * so they were dropped rather than kept "for completeness". Anything a
   * controller needs on reconnect belongs in the room snapshot, not here.
   */
  interface PlayerStateCommand {
    type: 'playerState';
    playerId: string;
    lines?: number;
    alive?: boolean;
  }
  interface PlayerKOCommand {
    type: 'playerKO';
    playerId: string;
  }
  /** "This player is out." The host maps it to its controller GAME_OVER send. */
  interface PlayerEliminatedCommand {
    type: 'playerEliminated';
    playerId: string;
  }
  interface GarbageCancelledCommand {
    type: 'garbageCancelled';
    playerId: string;
    lines: number;
  }
  interface GarbageSentCommand {
    type: 'garbageSent';
    senderId: string;
    toId: string;
    lines: number;
  }
  /** Match end. RAW results — the host keeps roster enrichment (playerName/
   *  colorIndex/newPlayer) and the actual broadcast; `frame()` has no roster. */
  interface GameEndCommand {
    type: 'gameEnd';
    elapsed: number;
    results: ResultEntry[];
  }
}
