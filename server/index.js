'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_VERSION = require('../package.json').version;

// Explicit allowlist of engine modules serveable via /engine/ route
const ENGINE_FILES = new Set([
  'constants.js',
  'Game.js',
  'GarbageManager.js',
  'Piece.js',
  'PlayerBoard.js',
  'Randomizer.js',
  'Scoring.js',
]);

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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function generateQRMatrix(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const modules = Array.from(qr.modules.data);
  const quiet = 1;
  const padded = size + quiet * 2;
  const paddedModules = new Array(padded * padded).fill(0);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      paddedModules[(row + quiet) * padded + (col + quiet)] = modules[row * size + col];
    }
  }
  return { size: padded, modules: paddedModules };
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // QR code endpoint
  if (urlPath === '/api/qr' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const text = url.searchParams.get('text');
    if (!text || text.length > 2048) {
      sendJson(res, 400, { error: !text ? 'Missing text parameter' : 'Text too long' });
      return;
    }
    try {
      const qrMatrix = generateQRMatrix(text);
      sendJson(res, 200, qrMatrix);
    } catch (err) {
      sendJson(res, 500, { error: 'QR generation failed' });
    }
    return;
  }

  // Serve game engine modules to browser
  if (urlPath.startsWith('/engine/')) {
    const engineFile = urlPath.slice('/engine/'.length);
    if (ENGINE_FILES.has(engineFile)) {
      const enginePath = path.join(__dirname, engineFile);
      fs.readFile(enginePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-cache, must-revalidate'
        });
        res.end(data);
      });
      return;
    }
  }

  // Health check endpoint
  if (urlPath === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Version endpoint
  if (urlPath === '/api/version') {
    sendJson(res, 200, { version: APP_VERSION });
    return;
  }

  // Base URL endpoint — returns the LAN-accessible origin for join URLs/QR codes
  if (urlPath === '/api/baseurl') {
    const baseUrl = process.env.BASE_URL || `http://${getLocalIP()}:${PORT}`;
    sendJson(res, 200, { baseUrl });
    return;
  }


  // Map directory paths to index.html
  if (urlPath === '/') {
    urlPath = '/display/index.html';
  } else if (urlPath.length > 1 && !urlPath.includes('.') && urlPath.split('/').filter(Boolean).length === 1) {
    // Single path segment with no file extension -> room code -> serve controller
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

    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }

    // Inject relay URL override into HTML pages when env var is set
    if (ext === '.html' && process.env.RELAY_URL) {
      const inject = `<script>window.__RELAY_URL__=${JSON.stringify(process.env.RELAY_URL).replace(/</g, '\\u003c')}</script>`;
      const html = data.toString().replace('<head>', '<head>' + inject);
      res.writeHead(200, headers);
      res.end(html);
      return;
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

// --- Start server ---
server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`Tetris server running on http://localhost:${PORT}`);
  console.log(`Local network: http://${localIP}:${PORT}`);
  console.log(`Display: http://localhost:${PORT}/`);
});
