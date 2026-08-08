'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Build-time ad-clip composite rig — loaded only by artwork/ad-clip/capture.js
// driving Playwright against the running dev server. The artwork/ tree is not
// copied into the Docker image, so /artwork/ad-clip/* naturally 404s in prod.
const AD_CLIP_COMPOSITE_DIR = path.join(__dirname, '..', 'artwork', 'ad-clip', 'composite');
// PartyPlug — reusable party-game framework (transport layer), shared across
// games and intentionally outside public/ so it isn't tied to this one app's
// assets. Served under /partyplug/ via the baseDir remap below.
const PARTYPLUG_DIR = path.join(__dirname, '..', 'partyplug');
const APP_VERSION = require('../package.json').version;
const APP_ENV = String(process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development')).toLowerCase();
const GIT_SHA = String(process.env.GIT_SHA || '').trim();

function getShortSha(sha) {
  return sha ? sha.slice(0, 7) : null;
}

// Computed once at boot — same for every HTML response.
const VERSION_LABEL = APP_VERSION + (APP_ENV !== 'production' && getShortSha(GIT_SHA) ? ' (#' + getShortSha(GIT_SHA) + ')' : '');

// Web bundles: in production we serve one content-hashed, immutably-cached
// bundle per app instead of ~20 no-store script tags (see scripts/build.js). The
// canonical load order is single-sourced in scripts/asset-manifest.js so dev
// (which serves the individual files for instant edits) can't drift from the
// build. WEB_MANIFEST maps app -> hashed filename; it's absent until `npm run
// build` has run, so dev and an unbuilt prod both fall back to individual tags.
//
// SERVE_BUNDLES=1 forces bundle serving independent of APP_ENV: it lets the e2e
// suite exercise the real concatenated artifact (where strict-mode flattening /
// cross-file hoisting live) without flipping the rest of production mode — most
// importantly keeping the dev CSP that the AirConsole mock's http.airconsole.com
// framing relies on.
const { CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS, CONTROLLER_STYLES, DISPLAY_STYLES, PRERENDERED_PAGES, resolveAsset } = require('../scripts/asset-manifest.js');
const { renderShell } = require('../scripts/render-shell.js');
const SERVE_BUNDLES = APP_ENV === 'production' || process.env.SERVE_BUNDLES === '1';
const WEB_MANIFEST = (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'web-manifest.json'), 'utf8'));
  } catch (_) {
    return null;
  }
})();
// Loud about the dangerous case: bundles asked for but not built. Without this a
// prod deploy that skipped `npm run build` boots "healthy" and silently serves
// the ~20 no-store tags this whole change exists to eliminate.
if (SERVE_BUNDLES && !WEB_MANIFEST) {
  console.warn('[warn] SERVE_BUNDLES/production is set but dist/web-manifest.json is missing — run `npm run build`. Serving individual no-store script tags as a fallback.');
}

// Build the <script> markup that replaces an app's <!--*_SCRIPTS--> placeholder.
// Bundle mode with a built manifest -> a single hashed tag; otherwise the files.
// `dir` is the public/ directory the bundle lives in — it matches `app` for the
// web bundles but not for the AC variants ('controller-ac' lives in controller/).
function scriptTagsFor(app, dir, scripts) {
  if (SERVE_BUNDLES && WEB_MANIFEST && WEB_MANIFEST[app]) {
    return '<script src="/' + dir + '/' + WEB_MANIFEST[app].js + '"></script>';
  }
  return scripts.map(function (s) { return '<script src="' + s + '"></script>'; }).join('\n  ');
}

// Build the <link> markup that replaces an app's <!--*_STYLES--> placeholder.
// Bundle mode -> one hashed, immutably-cached, compressed stylesheet; otherwise
// the individual files, each ?v=-busted against the 24h cache (APP_VERSION is
// baked in here directly so this is independent of the __APP_V__ HTML pass).
// The @font-face stylesheets are NOT here (see asset-manifest.js) — they remain
// their own <link>s in the HTML in both modes.
function styleTagsFor(app, styles) {
  if (SERVE_BUNDLES && WEB_MANIFEST && WEB_MANIFEST[app] && WEB_MANIFEST[app].css) {
    return '<link rel="stylesheet" href="/' + app + '/' + WEB_MANIFEST[app].css + '">';
  }
  return styles.map(function (s) {
    return '<link rel="stylesheet" href="' + s + '?v=' + APP_VERSION + '">';
  }).join('\n  ');
}

// Expand all shell placeholders for a page. Single entry point for both the
// boot-time cache (below) and the request-time rewrite (in the handler), so a
// page renders identically whichever path produces it. Every value here is
// constant per process EXCEPT versionLabel, which carries the non-prod "(#sha)"
// suffix and is only known at runtime (APP_ENV + GIT_SHA are container env vars;
// prod and preview run the same image) — which is exactly why the version can't
// be baked at build time and these pages are finalized at boot instead.
function renderPage(html) {
  return renderShell(html, {
    versionLabel: VERSION_LABEL,
    appVersion: APP_VERSION,
    controllerScripts: scriptTagsFor('controller', 'controller', CONTROLLER_SCRIPTS),
    displayScripts: scriptTagsFor('display', 'display', DISPLAY_SCRIPTS),
    acControllerScripts: scriptTagsFor('controller-ac', 'controller', AC_CONTROLLER_SCRIPTS),
    acDisplayScripts: scriptTagsFor('display-ac', 'display', AC_DISPLAY_SCRIPTS),
    controllerStyles: styleTagsFor('controller', CONTROLLER_STYLES),
    displayStyles: styleTagsFor('display', DISPLAY_STYLES),
  });
}

// Compress `buf` to `.br`/`.gz` at max quality. Boot-time one-shot per page, so
// spending brotli 11 / gzip 9 is free — the result is reused for every request.
function compressVariants(buf) {
  return {
    identity: buf,
    br: zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gzip: zlib.gzipSync(buf, { level: 9 }),
  };
}

// Prod-only: render every prod-served HTML page (PRERENDERED_PAGES in
// asset-manifest.js) once at boot and cache its identity + `.br`/`.gz` bytes, so
// requests serve static, negotiated, pre-compressed HTML with zero per-request
// templating or compression. This runs at boot rather than build time precisely
// because renderPage bakes VERSION_LABEL, which is per-deployment (same image,
// prod vs preview) and thus only known now. Empty in dev / when bundles aren't
// served, so the runtime rewrite in the handler covers every page there. A page
// whose source is missing (e.g. AC entries not generated) is skipped and falls
// back to that runtime path.
const HTML_CACHE = (function () {
  if (!SERVE_BUNDLES) return {};
  const cache = {};
  for (const url of PRERENDERED_PAGES) {
    let src;
    try { src = fs.readFileSync(resolveAsset(url), 'utf8'); } catch (_) { continue; }
    cache[url] = compressVariants(Buffer.from(renderPage(src)));
  }
  return cache;
})();

// Allowlist of engine modules serveable via the /engine/ route, derived from the
// canonical script lists so it can't drift from them. A hand-kept copy did: when
// RoomCore.js joined DISPLAY_SCRIPTS it was missing here, and dev mode (individual
// tags) 404'd it while the prod bundle (which inlines the file) stayed fine.
const ENGINE_FILES = new Set(
  [].concat(CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS)
    .filter((p) => p.startsWith('/engine/'))
    .map((p) => p.slice('/engine/'.length))
);

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.map': 'application/json'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Content-hashed web bundle (foo.<10-hex>.js or .css), NOT the .js.map. Only
// these carry build-time pre-compressed `.br`/`.gz` siblings, so only these are
// candidates for Accept-Encoding negotiation; every other request skips the
// sibling probe.
const HASHED_BUNDLE = /\.[0-9a-f]{10}\.(?:js|css)$/;

// Pick the best encoding we ship a pre-compressed sibling for (brotli first),
// or null if the client accepts neither. Parses q-values so an explicit refusal
// (`br;q=0`) is honored per RFC 9110, and the `*` wildcard sets the default for
// encodings not named. Keys are exact tokens, so a substring can't spoof support.
function pickEncoding(acceptEncoding) {
  const q = {};
  for (const part of String(acceptEncoding || '').toLowerCase().split(',')) {
    const segs = part.trim().split(';');
    const token = segs[0].trim();
    if (!token) continue;
    let qval = 1;
    for (let i = 1; i < segs.length; i++) {
      const m = /^\s*q=([\d.]+)/.exec(segs[i]);
      if (m) qval = parseFloat(m[1]);
    }
    q[token] = qval;
  }
  const brQ = 'br' in q ? q.br : q['*'];
  const gzipQ = 'gzip' in q ? q.gzip : q['*'];
  if (brQ > 0) return { ext: '.br', name: 'br' };
  if (gzipQ > 0) return { ext: '.gz', name: 'gzip' };
  return null;
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Serve game engine modules to browser
  if (urlPath.startsWith('/engine/')) {
    const engineFile = urlPath.slice('/engine/'.length);
    if (ENGINE_FILES.has(engineFile)) {
      const enginePath = path.join(__dirname, engineFile);
      fs.readFile(enginePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-store'
        });
        res.end(data);
      });
      return;
    }
  }

  // Cross-platform TV gallery (scripts/gallery), so the gallery nav's TV link
  // works in local dev after a local capture/assemble. Deployed hosts never
  // reach this route: Traefik path-routes /gallery-tv to the static gallery
  // pod, and the game image ships without these files anyway (404s here).
  if (urlPath === '/gallery-tv') {
    // Redirect to the slash form so the page's relative shots/ paths resolve.
    res.writeHead(301, { Location: '/gallery-tv/' });
    res.end();
    return;
  }
  if (urlPath.startsWith('/gallery-tv/')) {
    const rest = urlPath === '/gallery-tv/'
      ? 'gallery.html'
      : urlPath.slice('/gallery-tv/'.length);
    if (rest.includes('..')) { res.writeHead(400); res.end('Bad Request'); return; }
    const tvGalleryPath = path.join(__dirname, '..', 'scripts', 'gallery', rest);
    fs.readFile(tvGalleryPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found — regenerate via scripts/gallery/README.md');
        return;
      }
      const type = rest.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // Brand-asset gallery (public/gallery-artwork.html) shows icons/key art that
  // live OUTSIDE public/: the tvOS + Android icon sources and the artwork/ tree.
  // Expose just those three repo dirs, image files only, read-only — allowlisted
  // by top-level dir + extension so source code stays unreachable. Dev-only in
  // practice: the prod image ships none of these dirs, so the cards 404 and the
  // page's onerror handler marks them "not generated". urlPath is un-decoded
  // (req.url), and the appletv paths carry %20/%26, so decode before resolving.
  if (urlPath.startsWith('/gallery-assets/')) {
    let rest;
    try { rest = decodeURIComponent(urlPath.slice('/gallery-assets/'.length)); }
    catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
    const repoRoot = path.join(__dirname, '..');
    const assetPath = path.join(repoRoot, rest);
    const allowed =
      !rest.includes('..') &&
      /^(appletv|android|artwork)\//.test(rest) &&
      /\.(png|jpe?g|webp|svg)$/i.test(rest) &&
      assetPath.startsWith(repoRoot + path.sep);
    if (!allowed) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    fs.readFile(assetPath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(assetPath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    return;
  }

  // Apple Universal Links: an iOS Camera scan of https://hexstacker.com/<room>
  // opens the installed CouchPad app instead of Safari. Apple's CDN fetches
  // this over HTTPS as application/json with no redirect; the app ships the
  // matching applinks:hexstacker.com entitlement. Served inline (not from disk)
  // so it can't fall into the generic static path — the file would have no
  // extension (octet-stream) and a bare two-segment dotpath is easy to overlook.
  // The 6-'?' pattern matches exactly the 6-char room code as the sole path
  // segment; marketing/asset paths fall through to Safari, and the launcher's
  // JoinResolver rejects any 6-char non-room code at runtime.
  if (urlPath === '/.well-known/apple-app-site-association') {
    sendJson(res, 200, {
      applinks: {
        details: [
          {
            appIDs: ['5ZH48MPAM3.games.couchpad.controller'],
            components: [
              { '/': '/??????', comment: '6-char room code opens the app' },
            ],
          },
        ],
      },
    });
    return;
  }

  // Android App Links: the Digital Asset Links statement lets a system QR scan /
  // tapped hexstacker.com/<room> open the CouchPad app instead of Chrome, the
  // counterpart to the AASA above. Fingerprints: the release/upload key, the
  // debug key (for testing a locally-built install), and the Play App Signing
  // keys (Play Console → App integrity) — without those, verified App Links
  // break for Play-distributed installs.
  if (urlPath === '/.well-known/assetlinks.json') {
    sendJson(res, 200, [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'games.couchpad.controller',
          sha256_cert_fingerprints: [
            'CF:3C:FF:CD:9E:68:1C:37:F0:35:24:9A:7B:F0:10:14:3D:EC:AE:0D:DD:18:D7:57:F0:6E:8F:7A:0C:52:A0:38',
            '17:56:F5:01:B4:93:67:B9:7D:A7:C9:97:10:42:D7:88:E0:B0:0E:45:A6:55:D9:24:A5:53:BD:D2:D8:55:13:7F',
            'BD:EC:77:73:8E:92:15:A9:E7:F1:A6:B4:3F:5E:BB:46:18:3D:EA:95:DC:EA:66:AA:0F:3F:19:A9:5E:53:DE:EE',
            'F5:3B:3D:0A:3D:D1:DC:1B:EC:AC:9D:40:D0:E6:93:BF:EB:C3:B6:4B:D3:5C:9C:69:0F:4D:FD:6F:43:CA:1C:20',
            'C0:FA:AA:CB:9B:B1:C1:37:86:7B:01:16:E9:0E:8C:6A:94:02:7F:C5:84:9E:6B:E1:73:6E:9D:70:2D:DB:1C:30',
          ],
        },
      },
    ]);
    return;
  }

  // Health check endpoint
  if (urlPath === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Version endpoint
  if (urlPath === '/api/version') {
    sendJson(res, 200, {
      version: APP_VERSION,
      env: APP_ENV,
      isProduction: APP_ENV === 'production',
      commit: getShortSha(GIT_SHA)
    });
    return;
  }

  // Base URL endpoint — returns the LAN-accessible origin for join URLs/QR codes
  if (urlPath === '/api/baseurl') {
    const baseUrl = process.env.BASE_URL || `http://${getLocalIP()}:${PORT}`;
    sendJson(res, 200, { baseUrl });
    return;
  }


  // AirConsole entry points at root
  if (urlPath === '/screen.html') {
    urlPath = '/display/screen.html';
  } else if (urlPath === '/controller.html') {
    urlPath = '/controller/controller.html';
  }

  // Map directory paths to index.html
  if (urlPath === '/') {
    urlPath = '/display/index.html';
  } else if (urlPath === '/gallery' || urlPath === '/gallery-controller' || urlPath === '/gallery-rotations' || urlPath === '/gallery-artwork') {
    // Extensionless gallery URLs, carved out ahead of the room-code catch
    // below. Deployed hosts never get here:
    // Traefik routes /gallery* to the static gallery pod, whose nginx does the
    // same $uri.html resolution.
    urlPath = urlPath + '.html';
  } else if (urlPath.length > 1 && !urlPath.includes('.') && urlPath.split('/').filter(Boolean).length === 1) {
    // Single path segment with no file extension -> room code -> serve controller
    urlPath = '/controller/index.html';
  }

  let baseDir = PUBLIC_DIR;
  let lookupPath = urlPath;
  if (urlPath.startsWith('/artwork/ad-clip/')) {
    baseDir = AD_CLIP_COMPOSITE_DIR;
    lookupPath = urlPath.slice('/artwork/ad-clip'.length);
  } else if (urlPath.startsWith('/partyplug/')) {
    // Only the runtime modules are browser-facing: a single flat `.js` file.
    // This keeps the kit's dev/package artifacts (tests/, *.d.ts, package.json,
    // README.md) unreachable, mirroring the /engine/ route's restriction.
    if (!/^\/[\w.-]+\.js$/.test(urlPath.slice('/partyplug'.length))) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    baseDir = PARTYPLUG_DIR;
    lookupPath = urlPath.slice('/partyplug'.length);
  }

  const filePath = path.join(baseDir, lookupPath);

  // Prevent directory traversal. The trailing separator is load-bearing:
  // without it, `/public-evil/...` (resolved via `..` segments in lookupPath)
  // would slip past the prefix check against `/public`.
  if (!filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Prod: this page has boot-cached, finalized, pre-compressed bytes (below the
  // deliver() definition). preRendered signals the request-time HTML rewrite to
  // stand down. CSP/cache headers key off urlPath + ext (unchanged), so serving
  // from cache is invisible to them.
  const preRendered = !!HTML_CACHE[urlPath];

  // MP4: serve via streaming with Range support so the <video> element can
  // seek. fs.readFile + res.end (the path below) sends the whole buffer
  // without an Accept-Ranges header, which disables seeking in the browser
  // controls. Currently only the welcome-screen trailer needs this.
  if (path.extname(filePath).toLowerCase() === '.mp4') {
    fs.stat(filePath, (err, stat) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const fileSize = stat.size;
      const isProd = APP_ENV === 'production';
      const baseHeaders = {
        'Content-Type': MIME_TYPES['.mp4'],
        'Accept-Ranges': 'bytes',
        'Cache-Control': isProd ? 'public, max-age=86400' : 'no-store',
      };
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match) {
          res.writeHead(416, Object.assign({}, baseHeaders, { 'Content-Range': 'bytes */' + fileSize }));
          res.end();
          return;
        }
        let start, end;
        if (match[1] === '' && match[2] !== '') {
          // Suffix range: last N bytes
          start = Math.max(0, fileSize - parseInt(match[2], 10));
          end = fileSize - 1;
        } else {
          start = match[1] ? parseInt(match[1], 10) : 0;
          end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        }
        if (start >= fileSize || end >= fileSize || start > end) {
          res.writeHead(416, Object.assign({}, baseHeaders, { 'Content-Range': 'bytes */' + fileSize }));
          res.end();
          return;
        }
        res.writeHead(206, Object.assign({}, baseHeaders, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
          'Content-Length': end - start + 1,
        }));
        fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
      } else {
        res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': fileSize }));
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  // Which responses carry pre-compressed `.br`/`.gz` variants and can negotiate
  // Content-Encoding: content-hashed bundles (from disk siblings the build
  // emits) and boot-cached HTML (from in-memory variants). Everything else skips
  // the probe — the dev-only runtime-rewritten source HTML has no sibling, and
  // other static assets aren't compressed.
  const negotiable = preRendered || HASHED_BUNDLE.test(filePath);
  const encoding = negotiable ? pickEncoding(req.headers['accept-encoding']) : null;

  const deliver = (data, usedEncoding) => {
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    // Dev path (and the no-build fallback): expand the placeholders at request
    // time — version into the <meta name="app-version"> tag (the atomic "what
    // version is this page" anchor for staleness detection AND footer display,
    // with the dev " (#sha)" suffix), the ?v= font cache-bust, and the
    // script/style markers (individual files in dev, one hashed bundle in the
    // fallback). In prod the prerendered pages are served from HTML_CACHE
    // (preRendered), so this never runs for them. Gallery pages (dev-only here)
    // and any placeholder-less HTML pass through renderPage unchanged.
    if (ext === '.html' && !preRendered) {
      data = Buffer.from(renderPage(data.toString('utf8')));
    }

    // Non-production: never cache — file edits take effect on the next
    // request with no hard-reload needed. Production: HTML + JS are
    // already uncached to avoid stale-version mismatches (see commit
    // b08563d); other static files (CSS, images, fonts) keep a 24h cache
    // for bandwidth. The /engine/ route sends its own no-store header
    // above, so its dev/prod behavior matches what we set here.
    //
    // Exception: content-hashed bundles (foo.<10-hex>.js/.css from
    // scripts/build.js) and the JS sidecar .js.map are immutable — the hash
    // changes when the bytes change, so a new build gets a new URL and a stale
    // copy is never served. This is what lets the bundled JS and CSS escape
    // no-store / the 24h cache and be cached for a year.
    var isHashedBundle = /\.[0-9a-f]{10}\.(?:js|css)(\.map)?$/.test(filePath);
    var isNonProd = APP_ENV !== 'production';
    var noCache = isNonProd || ext === '.html' || (ext === '.js' && !isHashedBundle);
    headers['Cache-Control'] = isHashedBundle
      ? 'public, max-age=31536000, immutable'
      : (noCache ? 'no-store' : 'public, max-age=86400');

    if (ext === '.html') {
      const isAirConsole = urlPath === '/display/screen.html' || urlPath === '/controller/controller.html';
      if (isAirConsole) {
        headers['Content-Security-Policy'] = [
          "default-src 'self'",
          "script-src 'self' https://www.airconsole.com",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "connect-src 'self' https://www.airconsole.com",
          "img-src 'self' data: https://www.airconsole.com",
          "object-src 'none'",
          "frame-ancestors https://www.airconsole.com" + (APP_ENV !== 'production' ? " http://http.airconsole.com" : ""),
        ].join('; ');
      } else {
        // Pages that are iframed by the UI gallery (/gallery.html and
        // /gallery-controller.html) need `frame-ancestors 'self'`; the
        // gallery pages themselves — and any other HTML — stay at 'none'.
        // NOTE: this list pairs with the routing block above (/ → display,
        //       / + single segment → controller). Keep them in sync if
        //       those mappings ever change.
        const iframeable =
          urlPath === '/display/index.html' ||
          urlPath === '/controller/index.html';
        const frameAncestors = iframeable ? "'self'" : "'none'";
        // Note on stun.hexstacker.com: WebRTC's STUN traffic is UDP and not
        // subject to connect-src in any major browser (Chrome ignores
        // `stun:` schemes there with a warning). No CSP directive is needed
        // for the fastlane's iceServers config.
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' wss://ws.hexstacker.com https://ws.hexstacker.com; img-src 'self' data:; media-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors " + frameAncestors;
      }
    }

    // Any negotiable resource Varies on Accept-Encoding (including the plain
    // fallback) so a shared cache never serves an un-encoded body to a client
    // that would have taken compression, nor a br/gzip body to one that only
    // asked for plain. The immutable content-hashed URL keeps stale bytes from
    // ever being served regardless.
    if (negotiable) headers['Vary'] = 'Accept-Encoding';
    if (usedEncoding) headers['Content-Encoding'] = usedEncoding;

    res.writeHead(200, headers);
    res.end(data);
  };

  // Boot-cached pages: serve the finalized, pre-compressed buffer straight from
  // memory (encoding was picked above since preRendered pages are negotiable).
  // deliver() still stamps CSP/cache/Vary and skips the rewrite (preRendered).
  if (preRendered) {
    const variants = HTML_CACHE[urlPath];
    if (encoding && variants[encoding.name]) { deliver(variants[encoding.name], encoding.name); return; }
    deliver(variants.identity, null);
    return;
  }

  if (encoding) {
    fs.readFile(filePath + encoding.ext, (err, data) => {
      if (!err) { deliver(data, encoding.name); return; }
      // Sibling missing (partial build, etc.) — serve the plain bundle.
      fs.readFile(filePath, (plainErr, plainData) => {
        if (plainErr) { res.writeHead(404); res.end('Not Found'); return; }
        deliver(plainData, null);
      });
    });
  } else {
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      deliver(data, null);
    });
  }
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
// Guarded so unit tests can require this module (for pickEncoding /
// HASHED_BUNDLE) without binding a port. `node server/index.js` (npm start,
// Docker CMD, the e2e webServer) is still the main module and listens.
if (require.main === module) {
  server.listen(PORT, () => {
    const localIP = getLocalIP();
    console.log(`HexStacker Party server running on http://localhost:${PORT}`);
    console.log(`Local network: http://${localIP}:${PORT}`);
    console.log(`Display: http://localhost:${PORT}/`);
  });

  // Node runs as PID 1 in the container, where SIGTERM's default disposition
  // is ignored — without this handler every pod hangs for the full
  // terminationGracePeriodSeconds until SIGKILL on each deploy.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

module.exports = { pickEncoding, HASHED_BUNDLE, server };
