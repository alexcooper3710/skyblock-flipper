'use strict';
// Entry point for the terminal. `npm run terminal`, then open the URL it prints.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const path = require('path');
const os = require('os');
const { Store } = require('./db');
const { Collector } = require('./collector');
const { createServer } = require('./server');
const store_ = require('../main/store');

const cfg = store_.load(path.join(os.homedir(), '.skyblock-flipper'));
// The auction and bazaar endpoints are public; a key only buys rate headroom.
// Env wins over config so you can run it without a key sitting in a file.
cfg.apiKey = process.env.HYPIXEL_API_KEY || cfg.apiKey || '';
cfg.alerts = Object.assign({ flipProfit: 2000000, unusual: true, unusualZ: 4, cooldownMs: 15 * 60000 }, cfg.alerts);
// Keep the database alongside the project rather than in the home directory:
// it stays with the checkout, it is easy to find, and it is inspectable.
const dataDir = cfg.dataDir || path.join(__dirname, '..', '..', 'data');
cfg.persistPath = path.join(dataDir, 'price-book.json');

const store = new Store(path.join(dataDir, 'market.db'));
const collector = new Collector(cfg, store);
const { server } = createServer({ store, collector, cfg });

const PORT = Number(process.env.PORT || cfg.port || 8787);
const HOST = process.env.HOST || cfg.host || '127.0.0.1';
cfg.token = process.env.TERMINAL_TOKEN || cfg.token || '';

// Sharing it on the network without a token would leave /api/purge - which
// deletes the whole history - open to everyone who can reach the port.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !cfg.token) {
  cfg.token = require('crypto').randomBytes(9).toString('base64url');
  try {
    store_.save(path.join(os.homedir(), '.skyblock-flipper'), { ...cfg, _path: undefined });
  } catch { /* printing it is enough */ }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

collector.on('log', l => console.log(`[${l.level}] ${l.msg}`));

server.listen(PORT, HOST, () => {
  const size = (store.stats().bytes / 1048576).toFixed(1);
  console.log('');
  console.log('  SkyBlock Terminal');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  data: ${dataDir}  (${size} MB)`);
  console.log(`  api:  ${cfg.apiKey ? 'key loaded' : 'no key (public endpoints - fine, just lower rate limits)'}`);
  if (HOST === '0.0.0.0') {
    console.log('');
    console.log('  Share these with anyone on your network - no API key needed their end:');
    for (const ip of lanAddresses()) console.log(`    http://${ip}:${PORT}`);
    console.log('');
    console.log(`  They get a read-only view. Your edit token: ${cfg.token}`);
    console.log('  (append ?t=<token> to edit from another machine)');
  }
  console.log('');
  collector.start();
});

function shutdown() {
  console.log('\nstopping...');
  collector.stop();
  try { store.close(); } catch { /* already closed */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
