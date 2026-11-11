/**
 * Serves the built frontend (frontend/dist), so production runs as a single
 * service: one address for the website, the API and the WebSocket. That's
 * also all Discord's URL Mapping needs.
 *
 * In development Vite serves the frontend instead and this finds no build.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIST = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Answer a GET for a frontend file. Returns false when there's nothing to
 * serve, so the caller can 404.
 *
 * Unknown paths without a file extension get index.html, so the app loads
 * whatever the address; unknown paths *with* one ("/assets/old.js") are real
 * misses and 404.
 */
export async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<boolean> {
  let relative: string;
  try {
    relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  } catch {
    return false; // Malformed %-encoding.
  }

  // Resolved inside root only: "../" can never reach the rest of the disk.
  let file = join(root, relative);
  if (!file.startsWith(root)) return false;

  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    if (extname(relative)) return false;
    file = join(root, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    // Vite puts a content hash in every asset's name, so those never change
    // and can be cached forever. index.html must always be fresh.
    'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Discord forwards Activity traffic under /.proxy, sometimes keeping the
 * prefix and sometimes not. Treat both forms the same.
 */
export function stripProxyPrefix(pathname: string): string {
  return pathname.replace(/^\/\.proxy(?=\/|$)/, '') || '/';
}
