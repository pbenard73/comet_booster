import type { HttpResponse, HttpRequest } from 'uWebSockets.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '../dist/client');

const MIME: Record<string, string> = {
  '.html':  'text/html',
  '.js':    'application/javascript',
  '.css':   'text/css',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.json':  'application/json',
  '.woff2': 'font/woff2',
};

/**
 * Serve a static file from dist/client (production only — dev uses Vite).
 * uWS handlers must call `res.onAborted()` and guard every `res.end()` behind
 * the aborted flag, since the request can be cancelled at any time.
 */
export function serveStatic(res: HttpResponse, req: HttpRequest): void {
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  const url  = req.getUrl();
  const rel  = url === '/' ? '/index.html' : url;
  const full = path.join(STATIC_DIR, path.normalize(rel));

  if (!full.startsWith(STATIC_DIR)) {
    if (!aborted) res.writeStatus('403').end('Forbidden');
    return;
  }

  try {
    const data     = fs.readFileSync(full);
    const mimeType = MIME[path.extname(full)] ?? 'application/octet-stream';
    if (!aborted) res.writeHeader('Content-Type', mimeType).end(data);
  } catch {
    if (!aborted) res.writeStatus('404').end('Not found');
  }
}
