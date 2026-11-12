import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Context } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

export function staticHandler(root: string) {
  const base = resolve(root);
  return (c: Context) => {
    if (!existsSync(join(base, 'index.html'))) return c.notFound();
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    } catch {
      return c.notFound();
    }
    let file = resolve(base, rel);
    if (file !== base && !file.startsWith(base + sep)) return c.notFound();
    const isAsset = existsSync(file) && statSync(file).isFile();
    if (!isAsset) {
      if (extname(rel)) return c.notFound();
      file = join(base, 'index.html');
    }
    const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(readFileSync(file), 200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache });
  };
}
