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
cfg.alerts = Object.assign({ flipProfit: 2000000, unusual: true, unusualZ: 4, cooldownMs: 15 * 60000 }, cfg.alerts);
const dataDir = cfg.dataDir || path.join(os.homedir(), '.skyblock-flipper');
cfg.persistPath = path.join(dataDir, 'price-book.json');

const store = new Store(path.join(dataDir, 'market.db'));
const collector = new Collector(cfg, store);
const { server } = createServer({ store, collector, cfg });

const PORT = Number(process.env.PORT || cfg.port || 8787);
const HOST = process.env.HOST || cfg.host || '127.0.0.1';

collector.on('log', l => console.log(`[${l.level}] ${l.msg}`));

server.listen(PORT, HOST, () => {
  const size = (store.stats().bytes / 1048576).toFixed(1);
  console.log('');
  console.log('  SkyBlock Terminal');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  data: ${dataDir}  (${size} MB)`);
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
