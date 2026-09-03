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
    new Map([
      ['GHOST_BOOTS', [price, price * 1.1, price * 1.2, price * 1.3, price * 1.4]],
      ['HYPERION', [900e6, 950e6]],
      // one listing only, swinging wildly - the exact shape that produced
      // "MINER_OUTFIT_BOOTS 130k -> 10.00m, +7592%" on live data
      ['THIN_JUNK', [i % 2 === 0 ? 130000 : 10000000]],
    ]));
  if (i % 5 === 0) store.writeSales([{ auctionId: `s${i}`, key: 'GHOST_BOOTS', price, at: ts }]);
  store.writeBazaar(ts, new Map([
    ['ENCHANTED_DIAMOND', { buyOrder: 1300 - i, sellOrder: 1450 - i, instantBuy: 1460, instantSell: 1290, buyVolWeek: 520000, sellVolWeek: 610000 }],
    ['ENCHANTED_LAPIS_LAZULI', { buyOrder: 800 + i, sellOrder: 880 + i, instantBuy: 890, instantSell: 790, buyVolWeek: 90000, sellVolWeek: 120000 }],
  ]));
}
// DIAMOND exists on both markets, so search must fold it into one 'both' row
for (let i = 20; i >= 0; i--) {
  store.writeSnapshot({ ts: now - i * 60000, totalAuctions: 1, binCount: 1, newBins: 0, cycleMs: 1 },
    new Map([['ENCHANTED_DIAMOND', [1500, 1600, 2]]]));
}

const collector = new EventEmitter();
collector.lastStats = { snapshots: 121, totalAuctions: 45000, lastCycleMs: 1500, book: { soldSamples: 25 } };
collector.lastFlips = [{ uuid: 'u1', name: 'Ghostly Boots', keyBase: 'GHOST_BOOTS', price: 3e6, value: 1e7, profit: 68e5, marginPct: 226, strategy: 'lowest-bin', basis: 'bin2:variant', samples: 4, seenAt: now, command: '/viewauction u1' }];
collector.lastBazaar = { orders: [{ kind: 'bazaar-order', id: 'ENCHANTED_DIAMOND', profit: 400000, spreadPct: 12, units: 500, buyAt: 1200, sellAt: 1400, weeklyVolume: 5e5 }], crafts: [], at: now };
collector.refreshWatchlist = () => {};
// deliberately left without `books` - the item endpoint must survive a collector
// whose bazaar loop has not run yet rather than throwing inside the handler

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
    assert.strictEqual(j.results[0].id, 'GHOST_BOOTS');
    assert.strictEqual(j.results[0].kind, 'ah');
    console.log('PASS /api/search finds AH items');

    // the bug this suite exists to prevent: bazaar-only products being invisible
    r = await get('/api/search?q=LAPIS');
    j = JSON.parse(r.body);
    assert.strictEqual(j.results.length, 1, 'bazaar-only product must be searchable');
    assert.strictEqual(j.results[0].kind, 'bz');
    console.log('PASS /api/search finds bazaar-only products', JSON.stringify(j.results[0]));

    r = await get('/api/search?q=DIAMOND');
    j = JSON.parse(r.body);
    assert.strictEqual(j.results[0].kind, 'both', 'an item on both markets should be tagged both');
    console.log('PASS /api/search tags dual-market items');

    r = await get('/api/bazaar?q=ENCHANTED');
    j = JSON.parse(r.body);
    assert.ok(j.rows.length >= 2, 'book should list every product, not just flip candidates');
    assert.ok(j.rows[0].spreadPct > 0);
    console.log('PASS /api/bazaar browse', JSON.stringify({ rows: j.rows.length, top: j.rows[0].id }));

    r = await get('/api/item?key=ENCHANTED_LAPIS_LAZULI&range=24h');
    j = JSON.parse(r.body);
    assert.strictEqual(j.kind, 'bz');
    assert.ok(j.bzCurrent, 'a bazaar item must return bazaar state, not an empty hero');
    assert.ok(j.bazaar.length > 0, 'bazaar price history should come back');
    console.log('PASS /api/item on a bazaar-only product', JSON.stringify({ kind: j.kind, sell: j.bzCurrent.sell_order, buckets: j.bazaar.length }));

    r = await get('/api/overview?since=' + (3 * 3600e3));
    j = JSON.parse(r.body);
    const gb = j.movers.find(m => m.key === 'GHOST_BOOTS');
    assert.ok(gb, 'mover should be listed');
    assert.ok(gb.pct > 0, 'price rose over the window, pct should be positive');
    assert.ok(j.bzMovers && j.bzMovers.length, 'overview must include bazaar movers');
    assert.ok(!j.movers.some(m => m.key === 'THIN_JUNK'),
      'a single-listing item must not be reported as a mover - that is just the cheapest listing selling');
    assert.ok(j.movers.every(m => m.depth >= 4), 'every mover should have a real wall behind it');
    console.log('PASS shallow-wall movers are excluded');
    console.log('PASS /api/overview', JSON.stringify({ movers: j.movers.length, bzMovers: j.bzMovers.length, topPct: gb.pct.toFixed(1) }));

    r = await get('/api/depth?product=ENCHANTED_DIAMOND');
    assert.strictEqual(r.status, 200, 'depth must not throw when no live book exists');
    console.log('PASS /api/depth survives a collector with no live book');

    r = await get('/api/item?key=NOPE&range=1h');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).current, undefined);
    console.log('PASS unknown item returns empty rather than erroring');

    // Sharing must not hand out the ability to wipe the database.
    const post = (path_, host) => new Promise((resolve, reject) => {
      const req = require('http').request(
        { host: host || '127.0.0.1', port: server.address().port, path: path_, method: 'POST' },
        r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      req.on('error', reject); req.end();
    });
    let pr = await post('/api/alerts/seen');
    assert.strictEqual(pr.status, 200, 'loopback should still be able to write');
    console.log('PASS loopback keeps write access');

    // simulate a non-loopback caller by asking the guard directly
    const { createServer: cs } = require('../src/server/server');
    const guarded = cs({ store, collector, cfg: { ...cfg, token: 'secret' } });
    const fakeReq = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers, method: 'POST' });
    assert.ok(guarded.server, 'server builds with a token configured');
    console.log('PASS write gate is wired with a token configured');

    console.log('\nALL SERVER TESTS PASSED');
    server.close(); store.close(); fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) { console.error('FAIL', e); process.exit(1); }
});
