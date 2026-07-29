'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Brotli quality is a pure size/time trade with NO behavioural difference: the
// server negotiates the sibling and the browser decompresses it the same way at
// any quality. Quality 11 costs ~450ms of CPU per artifact against quality 5's
// ~4ms, and buys ~9% off the wire — worth paying only for the bytes real users
// download. That is the Docker image, and it opts in with BUILD_COMPRESSION=max
// (asserted by tests/build-compression.test.js).
//
// Everything else takes the fast path: local builds, `npm start`, the Playwright
// webServer, and the AirConsole ZIP — which deletes the `.br`/`.gz` siblings
// outright, so max quality there was pure waste.
const BROTLI_QUALITY = process.env.BUILD_COMPRESSION === 'max' ? 11 : 5;

// Write `buf` to filePath plus its `.br`/`.gz` siblings. Used for the
// content-hashed JS/CSS bundles that server/index.js serves via Accept-Encoding
// negotiation; only the primary file is written, callers pass the exact bytes to
// serve. Async (not the *Sync variants) so the two codecs run on the libuv
// threadpool and, more importantly, so concurrent callers actually overlap —
// build.js builds six artifacts under one Promise.all, which the old sync
// compression serialized back into one core.
async function writeCompressed(filePath, buf) {
  const [br, gz] = await Promise.all([
    brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gzip(buf, { level: 9 }),
  ]);
  fs.writeFileSync(filePath, buf);
  fs.writeFileSync(filePath + '.br', br);
  fs.writeFileSync(filePath + '.gz', gz);
}

module.exports = { writeCompressed: writeCompressed, BROTLI_QUALITY: BROTLI_QUALITY };
