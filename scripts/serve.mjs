// Serve docs/ over http so you can test the site before it goes anywhere near
// GitHub. No dependencies - node's own http and fs, nothing to install.
//
// Opening docs/index.html directly does NOT work: the page is ES modules and
// they are blocked on file:// origins, so you get a blank page and no clue why.
// It needs a real origin, which is all this provides.
//
//   node scripts/serve.mjs          -> http://localhost:8080
//   node scripts/serve.mjs 3000     -> another port
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',   // wrong type here = modules refuse to load
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    // Never serve anything outside docs/.
    const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }

    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Always hand back the file on disk, so a reload shows your latest edit
      // rather than whatever the browser cached a minute ago.
      'cache-control': 'no-store',
    }).end(body);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404).end('not found'); return; }
    res.writeHead(500).end(String(e.message));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use - something else is serving there.`);
    console.error(`try: node scripts/serve.mjs ${PORT + 1}`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`\n  SkyBlock Terminal  ->  http://localhost:${PORT}\n`);
  console.log(`  serving ${ROOT}`);
  console.log('  live Hypixel + Coflnet data, same as the real site. ctrl-c to stop.\n');
});
