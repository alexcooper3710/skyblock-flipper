'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/server/db');
const { createServer } = require('../src/server/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-'));
const store = new Store(path.join(tmp, 'market.db'));

// seed two hours of a falling market plus some sales
const now = Date.now();
for (let i = 120; i >= 0; i--) {
  const ts = now - i * 60000;
  const price = 10000000 - i * 20000;
  store.writeSnapshot({ ts, totalAuctions: 45000, binCount: 30000, newBins: 5, cycleMs: 1500 },
    new Map([['GHOST_BOOTS', [price, price * 1.1, price * 1.2]], ['HYPERION', [900e6, 950e6]]]));
  if (i % 5 === 0) store.writeSales([{ auctionId: `s${i}`, key: 'GHOST_BOOTS', price, at: ts }]);
}

const collector = new EventEmitter();
collector.lastStats = { snapshots: 121, totalAuctions: 45000, lastCycleMs: 1500, book: { soldSamples: 25 } };
collector.lastFlips = [{ uuid: 'u1', name: 'Ghostly Boots', keyBase: 'GHOST_BOOTS', price: 3e6, value: 1e7, profit: 68e5, marginPct: 226, strategy: 'lowest-bin', basis: 'bin2:variant', samples: 4, seenAt: now, command: '/viewauction u1' }];
collector.lastBazaar = { orders: [{ kind: 'bazaar-order', id: 'ENCHANTED_DIAMOND', profit: 400000, spreadPct: 12, units: 500, buyAt: 1200, sellAt: 1400, weeklyVolume: 5e5 }], crafts: [], at: now };
collector.refreshWatchlist = () => {};

const cfg = { alerts: { flipProfit: 2e6, unusual: true, unusualZ: 4, cooldownMs: 900000 }, minProfit: 1e6, maxBudget: 2e8 };
const { server } = createServer({ store, collector, cfg });

const get = (p) => new Promise((resolve, reject) => {
  require('http').get({ host: '127.0.0.1', port: server.address().port, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});

server.listen(0, '127.0.0.1', async () => {
  try {
    let r = await get('/api/state');
    let j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.flips.length, 1);
    assert.ok(j.db.binRows > 200, 'db should report seeded rows');
    console.log('PASS /api/state', JSON.stringify({ flips: j.flips.length, binRows: j.db.binRows, kb: Math.round(j.db.bytes / 1024) }));

    r = await get('/api/item?key=GHOST_BOOTS&range=24h');
    j = JSON.parse(r.body);
    assert.ok(j.bin.length > 3, 'should return bucketed price history');
    assert.ok(j.sales.length > 0, 'should return sales history');
    assert.strictEqual(j.current.key, 'GHOST_BOOTS');
    console.log('PASS /api/item', JSON.stringify({ buckets: j.bin.length, salesBuckets: j.sales.length, current: j.current.lowest }));

    r = await get('/api/search?q=GHOST');
    j = JSON.parse(r.body);
    assert.strictEqual(j.results[0].key, 'GHOST_BOOTS');
    console.log('PASS /api/search');

    r = await get('/api/overview?since=' + (3 * 3600e3));
    j = JSON.parse(r.body);
    const gb = j.movers.find(m => m.key === 'GHOST_BOOTS');
    assert.ok(gb, 'mover should be listed');
    assert.ok(gb.pct > 0, 'price rose over the window, pct should be positive');
    console.log('PASS /api/overview', JSON.stringify({ movers: j.movers.length, topPct: gb.pct.toFixed(1), volume: j.volume.length }));

    r = await get('/api/item?key=NOPE&range=1h');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).current, undefined);
    console.log('PASS unknown item returns empty rather than erroring');

    console.log('\nALL SERVER TESTS PASSED');
    server.close(); store.close(); fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) { console.error('FAIL', e); process.exit(1); }
});
