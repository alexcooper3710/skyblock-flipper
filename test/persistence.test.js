'use strict';
// The sold feed only delivers ~90 sales a minute, so throwing the price book
// away on restart means 45 minutes of uselessness every launch.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PriceBook } = require('../src/main/engine/pricing');
const { Flipper } = require('../src/main/engine/poller');
const store = require('../src/main/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flipper-'));
const persistPath = path.join(tmp, 'nested', 'price-book.json');

// --- round trip -------------------------------------------------------------
const a = new PriceBook({ soldWindowMinutes: 45 });
a.addSales([
  { key: 'HYPERION', price: 900000000, auctionId: 'x1' },
  { key: 'HYPERION', price: 950000000, auctionId: 'x2' },
  { key: 'HYPERION', price: 925000000, auctionId: 'x3' },
]);
const before = a.soldStats('HYPERION');

const b = new PriceBook({ soldWindowMinutes: 45 });
const restored = b.hydrate(a.serialize());
assert.strictEqual(restored, 3);
assert.deepStrictEqual(b.soldStats('HYPERION'), before);
console.log('PASS price book survives a round trip:', JSON.stringify(before));

// --- stale samples are dropped, not resurrected ------------------------------
const stale = { v: 1, savedAt: 0, sold: [['OLD_ITEM', [[123, Date.now() - 99 * 60000]]]] };
const c = new PriceBook({ soldWindowMinutes: 45 });
assert.strictEqual(c.hydrate(stale), 0, 'samples older than the window must be dropped');
console.log('PASS out-of-window samples are dropped on load');

// --- garbage on disk must not crash the engine -------------------------------
const bad = new PriceBook({});
assert.strictEqual(bad.hydrate(null), 0);
assert.strictEqual(bad.hydrate({ v: 99 }), 0);
assert.strictEqual(bad.hydrate({ v: 1, sold: 'not-an-array' }), 0);
console.log('PASS malformed price book is ignored, not fatal');

// --- through the Flipper, including mkdir and atomic rename ------------------
const cfg = { ...store.defaults(), persistPath };
const f1 = new Flipper(cfg);
f1.book.addSales([{ key: 'TERMINATOR', price: 250000000, auctionId: 'y1' }]);
f1.saveBook();
assert.ok(fs.existsSync(persistPath), 'saveBook should create missing directories');
assert.ok(!fs.existsSync(persistPath + '.tmp'), 'temp file should be renamed away');

const f2 = new Flipper(cfg);
f2.loadBook();
assert.strictEqual(f2.book.soldStats('TERMINATOR').n, 1);
console.log('PASS a fresh Flipper picks up the previous run\'s book');

fs.writeFileSync(persistPath, '{ this is not json');
const f3 = new Flipper(cfg);
const logs = [];
f3.on('log', l => logs.push(l.level));
assert.strictEqual(f3.loadBook(), 0);
assert.ok(logs.includes('warn'), 'a corrupt book should warn, not throw');
console.log('PASS corrupt file on disk starts cold with a warning');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nALL PERSISTENCE TESTS PASSED');
