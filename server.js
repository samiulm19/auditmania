// Local dev server: serves /public and runs the /api functions (same code Vercel runs).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// Load .env if present (no dependency needed)
try {
  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^a-z-]/g, '');
    try {
      const mod = await import(path.join(root, 'api', `${name}.js`));
      return mod.default(req, res);
    } catch {
      res.statusCode = 404; return res.end('Not found');
    }
  }
  const file = path.join(root, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(path.join(root, 'public'))) { res.statusCode = 403; return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404; res.end('Not found');
  }
}).listen(PORT, () => console.log(`Site Audit running on http://localhost:${PORT}`));
