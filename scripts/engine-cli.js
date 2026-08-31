'use strict';
// Headless runner. Same engine as the app, printed to a terminal.
// Useful for checking the thing works before you trust the GUI with real coins.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const path = require('path');
const fs = require('fs');
const { Flipper } = require('../src/main/engine/poller');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
const localPath = path.join(__dirname, '..', 'config.json');
const cfg = fs.existsSync(localPath)
  ? { ...base, ...JSON.parse(fs.readFileSync(localPath, 'utf8')) }
  : base;

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

const f = new Flipper(cfg);
f.on('log', l => console.log(`[${new Date(l.at).toLocaleTimeString()}] ${l.level} ${l.msg}`, l.extra || ''));
f.on('stats', s => console.log(`   snapshots=${s.snapshots} auctions=${s.totalAuctions} cycle=${(s.lastCycleMs / 1000).toFixed(1)}s soldSamples=${s.book.soldSamples}`));
f.on('flips', batch => {
  for (const x of batch) {
    console.log(`FLIP  +${fmt(x.profit)} (${x.marginPct}%)  ${x.name}  buy ${fmt(x.price)} worth ${fmt(x.value)}  [${x.strategy}/${x.basis} n=${x.samples}]`);
    console.log(`      ${x.command}`);
  }
});
f.on('bazaar', b => {
  const top = [...b.orders, ...b.crafts].sort((x, y) => y.profit - x.profit).slice(0, 5);
  for (const r of top) console.log(`BZ    +${fmt(r.profit)}  ${r.id}  ${r.kind === 'bazaar-craft' ? `craft x${r.crafts}` : `order x${r.units}`}`);
});

f.start();
process.on('SIGINT', () => { f.stop(); process.exit(0); });
