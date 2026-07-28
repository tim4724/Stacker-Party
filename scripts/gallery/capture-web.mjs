// Capture the web display reference screens (the states in scenarios.json with
// a `web` mapping) using the production display test harness, for side-by-side
// gap review against the native TV ports. Writes shots/web/<key>.png at 1920x1080.
//
// Usage:
//   node capture-web.mjs <baseURL>      e.g. node capture-web.mjs http://localhost:8770
//
// Requires a running server (node server/index.js) serving the repo, and
// Playwright (`npx playwright install chromium` once). Best-effort: if
// Playwright is unavailable the native-only gallery still works.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

const base = (process.argv[2] || 'http://localhost:8770').replace(/\/$/, '');
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots', 'web');
mkdirSync(outDir, { recursive: true });

const { scenarios } = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));
const states = scenarios.filter((s) => s.web);

function url(s) {
  const p = new URLSearchParams({ test: '1', bg: '1', lang: 'en', scenario: s.web.scenario,
                                  players: String(s.web.players ?? 4), level: '1' });
  for (const [k, v] of Object.entries(s.web.params ?? {})) p.set(k, String(v));
  return `${base}/?${p.toString()}`;
}

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright not installed — skipping web capture (run: npx playwright install chromium)'); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

// Fail loudly rather than shipping a gallery of welcome screens. A missing
// script leaves the harness init half-dead and every state falls back to the
// welcome screen, which still screenshots fine, so without this the run stays
// green and the gap review silently compares the wrong pixels.
const problems = [];
page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
});

for (const s of states) {
  await page.goto(url(s), { waitUntil: 'networkidle' });
  // Animated states settle a touch slower; give them all a fixed beat.
  await page.waitForTimeout(s.web.scenario === 'effects-combo' ? 1400 : 700);
  await page.screenshot({ path: join(outDir, `${s.key}.png`) });
  console.log('  captured', s.key);
}
await browser.close();

if (problems.length) {
  console.error('web capture is not trustworthy; the display page reported:');
  for (const p of [...new Set(problems)]) console.error('  ' + p);
  process.exit(1);
}
console.log('done ->', outDir);
