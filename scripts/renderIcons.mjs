/**
 * Regenerates Imager's PNG icons from `public/favicon.svg`.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-OFF SHELL COMMAND: the PNGs are DERIVED
 * artifacts. If the SVG is ever changed and the PNGs are not, an install prompt
 * or an old browser would keep showing the previous mark — a drift nobody would
 * notice, because the modern path (SVG) would look right. Keeping the
 * conversion here makes the derivation explicit and repeatable.
 *
 * Method: no image library exists on this host, so headless Chrome renders the
 * SVG at the exact size and the screenshot IS the PNG.
 *
 *   node scripts/renderIcons.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(REPO, 'public');
const PORT = 8117;
const DEBUG_PORT = 9377;

/** The sizes worth shipping: browser tab, Windows taskbar, iOS home screen. */
const SIZES = [
  { size: 32, file: 'favicon-32.png' },
  { size: 48, file: 'favicon-48.png' },
  { size: 180, file: 'apple-touch-icon.png' },
];

const MIME = { '.svg': 'image/svg+xml' };

const server = http.createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
  const file = join(PUBLIC, path);
  if (!existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
  });
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const profile = mkdtempSync(join(tmpdir(), 'imager-icons-'));
const chrome = spawn(
  '/usr/bin/google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${String(DEBUG_PORT)}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let wsUrl;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/version`);
    const version = await response.json();
    if (typeof version.webSocketDebuggerUrl === 'string') {
      wsUrl = version.webSocketDebuggerUrl;
      break;
    }
  } catch {
    // Chrome is not up yet.
  }
  await sleep(250);
}
if (wsUrl === undefined) {
  chrome.kill('SIGKILL');
  server.close();
  throw new Error('Chrome never exposed a debugging endpoint');
}

const socket = new WebSocket(wsUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const call = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    socket.send(
      JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
  });

for (const { size, file } of SIZES) {
  const target = await call('Target.createTarget', { url: 'about:blank' });
  const attached = await call('Target.attachToTarget', {
    targetId: target.result.targetId,
    flatten: true,
  });
  const session = attached.result.sessionId;
  const send = (method, params = {}) => call(method, params, session);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // An <img> at exactly the viewport, on a transparent page: no padding, no
  // background, so the screenshot is the icon and its own alpha.
  const markup = `<!doctype html><html><body style="margin:0;background:transparent">
    <img src="http://127.0.0.1:${String(PORT)}/favicon.svg" width="${String(size)}" height="${String(size)}" style="display:block">
    </body></html>`;
  await send('Runtime.evaluate', {
    expression: `document.open();document.write(${JSON.stringify(markup)});document.close();`,
  });
  await sleep(400);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  writeFileSync(join(PUBLIC, file), Buffer.from(shot.result.data, 'base64'));
  await call('Target.closeTarget', { targetId: target.result.targetId });
  console.log(`wrote public/${file} (${String(size)}×${String(size)})`);
}

chrome.kill('SIGKILL');
server.close();
