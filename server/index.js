'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const Room = require('./Room.js');
const { MSG } = require('../public/shared/protocol.js');
const { applyVisualScenario } = require('./visualTestScenarios.js');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // e.g. https://main.tetris-party.duckdns.org
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_VERSION = require('../package.json').version;
const E2E_TEST_MODE = process.env.E2E_TEST_MODE === '1';

// --- MIME types ---
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const testState = {
  nextJoinDelayMs: 0
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function destroyAllRooms() {
  for (const room of rooms.values()) {
    room.destroy();
  }
  rooms.clear();
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function extractRoomCode(urlPath) {
  const match = urlPath.match(/^\/api\/test\/room\/([A-Z]{4})\/scenario$/);
  return match ? match[1] : null;
}

// --- HTTP Static Server ---
const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0]; // strip query params

  if (E2E_TEST_MODE && req.method === 'POST' && urlPath === '/api/test/reset') {
    destroyAllRooms();
    testState.nextJoinDelayMs = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (E2E_TEST_MODE && req.method === 'POST' && urlPath === '/api/test/delay-next-join') {
    try {
      const body = await readJsonBody(req);
      testState.nextJoinDelayMs = Math.max(0, Number(body.ms) || 0);
      sendJson(res, 200, { ok: true, nextJoinDelayMs: testState.nextJoinDelayMs });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (E2E_TEST_MODE && req.method === 'POST') {
    const roomCode = extractRoomCode(urlPath);
    if (roomCode) {
      const room = rooms.get(roomCode);
      if (!room) {
        sendJson(res, 404, { ok: false, error: 'Room not found' });
        return;
      }

      try {
        const body = await readJsonBody(req);
        applyVisualScenario(room, body.scenario, body.options || {});
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }
  }

  // Health check endpoint
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Version endpoint
  if (urlPath === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: APP_VERSION }));
    return;
  }

  // Map directory paths to index.html
  if (urlPath === '/') {
    urlPath = '/display/index.html';
  } else if (urlPath.length > 1 && !urlPath.includes('.') && urlPath.split('/').filter(Boolean).length === 1) {
    // Single path segment with no file extension → room code → serve controller
    urlPath = '/controller/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    // Prevent mobile browsers from serving stale controller/display code.
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }

    res.writeHead(200, headers);
    res.end(data);
  });
});

// --- Get local network IP ---
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Room management ---
const rooms = new Map(); // roomCode -> Room

// Track which ws belongs to which room/player
const clientInfo = new WeakMap(); // ws -> { roomCode, playerId, type }

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

// --- Controller liveness check ---
// Controllers send heartbeats every 2s. The server marks isAlive=true on any
// incoming message and periodically checks that controllers are still alive.
// Display connections (stable desktop browsers) are not checked.
const LIVENESS_CHECK_MS = 5000;

const livenessInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const info = clientInfo.get(ws);
    if (!info || info.type !== 'controller') continue;
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
  }
}, LIVENESS_CHECK_MS);

wss.on('close', () => clearInterval(livenessInterval));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const info = clientInfo.get(ws);

    // --- First message: identify client type ---
    if (!info) {
      handleNewConnection(ws, msg);
      return;
    }

    // --- Subsequent messages: route to room ---
    const room = rooms.get(info.roomCode);
    if (!room) return;

    if (info.type === 'display') {
      handleDisplayMessage(room, msg);
    } else if (info.type === 'controller') {
      handleControllerMessage(room, info.playerId, msg);
    }
  });

  ws.on('close', () => {
    const info = clientInfo.get(ws);
    if (!info) return;

    const room = rooms.get(info.roomCode);
    if (!room) return;

    if (info.type === 'display') {
      console.log(`Display disconnected from room ${info.roomCode}`);
      room.displayWs = null;
      room._displayGraceTimer = setTimeout(() => {
        room._displayGraceTimer = null;
        room.destroy();
        rooms.delete(info.roomCode);
        console.log(`Room ${info.roomCode} destroyed (display timeout)`);
      }, 15000);
    } else if (info.type === 'controller') {
      // Skip if this is a stale ws replaced by a reconnect
      const player = room.players.get(info.playerId);
      if (player && player.ws !== ws) return;
      console.log(`Player ${info.playerId} disconnected from room ${info.roomCode}`);
      room.removePlayer(info.playerId);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// --- Handle new connections ---
async function handleNewConnection(ws, msg) {
  if (msg.type === MSG.CREATE_ROOM) {
    // Display reconnecting to an existing room during grace period
    if (msg.roomCode && rooms.has(msg.roomCode)) {
      const room = rooms.get(msg.roomCode);
      if (room._displayGraceTimer) {
        clearTimeout(room._displayGraceTimer);
        room._displayGraceTimer = null;
        room.displayWs = ws;
        clientInfo.set(ws, { roomCode: msg.roomCode, type: 'display' });
        room.resyncDisplay();
        console.log(`Display reconnected to room ${msg.roomCode}`);
        return;
      }
    }

    const roomCode = (msg.roomCode && !rooms.has(msg.roomCode))
      ? msg.roomCode
      : Room.generateRoomCode();
    const room = new Room(roomCode, ws);
    rooms.set(roomCode, room);

    clientInfo.set(ws, { roomCode, type: 'display' });

    let joinUrl;
    if (PUBLIC_URL) {
      joinUrl = `${PUBLIC_URL}/${roomCode}`;
    } else {
      const localIP = getLocalIP();
      joinUrl = `http://${localIP}:${PORT}/${roomCode}`;
    }
    room.joinUrl = joinUrl;
    const qrMatrix = room.getQRMatrix(joinUrl);

    send(ws, MSG.ROOM_CREATED, { roomCode, qrMatrix, joinUrl });
    console.log(`Room ${roomCode} created. Join: ${joinUrl}`);

  } else if (msg.type === MSG.JOIN) {
    const delayMs = E2E_TEST_MODE ? testState.nextJoinDelayMs : 0;
    testState.nextJoinDelayMs = 0;

    if (delayMs > 0) {
      setTimeout(() => {
        if (ws.readyState !== 1) return;
        processJoinMessage(ws, msg);
      }, delayMs);
    } else {
      processJoinMessage(ws, msg);
    }

  } else if (msg.type === MSG.REJOIN) {
    const room = rooms.get(msg.roomCode);
    if (!room) {
      send(ws, MSG.ERROR, { message: 'Room not found' });
      return;
    }

    const playerId = room.reconnectByToken(ws, msg.reconnectToken);
    if (playerId !== null) {
      const player = room.players.get(playerId);
      clientInfo.set(ws, { roomCode: msg.roomCode, playerId, type: 'controller' });
      send(ws, MSG.JOINED, {
        playerId,
        playerName: player.name,
        playerColor: player.color,
        reconnected: true,
        isHost: playerId === room.hostId,
        playerCount: room.players.size,
        roomState: room.state,
        ...room.getReconnectState(playerId)
      });
      console.log(`Player ${playerId} reconnected to room ${msg.roomCode}`);
    } else {
      send(ws, MSG.ERROR, { message: 'Reconnection failed' });
    }
  }
}

function processJoinMessage(ws, msg) {
  const room = rooms.get(msg.roomCode);
  if (!room) {
    send(ws, MSG.ERROR, { message: 'Room not found' });
    return;
  }

  if (msg.rejoinId) {
    const result = room.rejoinById(parseInt(msg.rejoinId), ws);
    if (result) {
      clientInfo.set(ws, { roomCode: msg.roomCode, playerId: result.playerId, type: 'controller' });
      send(ws, MSG.JOINED, {
        playerId: result.playerId,
        playerName: result.name,
        playerColor: result.color,
        reconnectToken: result.reconnectToken,
        isHost: result.isHost,
        reconnected: true,
        playerCount: room.players.size,
        roomState: room.state,
        ...room.getReconnectState(result.playerId)
      });
      console.log(`Player ${result.playerId} rejoined room ${msg.roomCode} via QR`);
      return;
    }
  }

  const result = room.addPlayer(ws, msg.name);
  if (result) {
    clientInfo.set(ws, { roomCode: msg.roomCode, playerId: result.playerId, type: 'controller' });
    send(ws, MSG.JOINED, {
      playerId: result.playerId,
      playerName: result.name,
      playerColor: result.color,
      reconnectToken: result.reconnectToken,
      isHost: result.isHost,
      playerCount: room.players.size
    });
    console.log(`Player ${result.playerId} (${result.name}) joined room ${msg.roomCode}`);
  }
}

// --- Handle display messages ---
function handleDisplayMessage(room, msg) {
  switch (msg.type) {
    case MSG.START_GAME:
      room.startGame();
      break;
    case MSG.RETURN_TO_LOBBY:
      room.returnToLobby();
      break;
    case MSG.PLAY_AGAIN:
      room.playAgain();
      break;
    case MSG.PAUSE_GAME:
      room.pauseGame();
      break;
    case MSG.RESUME_GAME:
      room.resumeGame();
      break;
  }
}

// --- Handle controller messages ---
function handleControllerMessage(room, playerId, msg) {
  switch (msg.type) {
    case MSG.INPUT:
      room.handleInput(playerId, msg.action, msg.seq);
      break;
    case MSG.SOFT_DROP_START:
      room.handleSoftDropStart(playerId, msg.speed);
      break;
    case MSG.SOFT_DROP_END:
      room.handleSoftDropEnd(playerId);
      break;
    case MSG.START_GAME:
      if (playerId === room.hostId) {
        room.startGame();
      }
      break;
    case MSG.PLAY_AGAIN:
      if (playerId === room.hostId) {
        room.playAgain();
      }
      break;
    case MSG.RETURN_TO_LOBBY:
      if (playerId === room.hostId) {
        room.returnToLobby();
      }
      break;
    case MSG.PAUSE_GAME:
      if (playerId === room.hostId) {
        room.pauseGame();
      }
      break;
    case MSG.RESUME_GAME:
      if (playerId === room.hostId) {
        room.resumeGame();
      }
      break;
    case MSG.HEARTBEAT:
      // Keepalive — isAlive already set on message receipt
      break;
    case MSG.LEAVE:
      room.removePlayer(playerId, true);
      break;
  }
}

// --- Helper ---
function send(ws, type, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// --- Start server ---
server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`Tetris server running on http://localhost:${PORT}`);
  console.log(`Local network: http://${localIP}:${PORT}`);
  console.log(`Display: http://localhost:${PORT}/`);
});
