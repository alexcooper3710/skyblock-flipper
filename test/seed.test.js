'use strict';
// The collector seed: a tab opens with a market someone else already computed,
// then live data takes over. These are the rules that keep the handover honest.
const assert = require('assert');
const { PriceBook } = require('../src/main/engine/pricing');

const cfg = { soldWindowMinutes: 45 };
const now = Date.now();
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// --- wall ------------------------------------------------------------------
let b = new PriceBook(cfg);
assert.strictEqual(b.seedWall({ TERM: [8e6, 14e6, 14.5e6, 15e6], JUNK: [] }), 1, 'empty arrays are skipped');
ok(b.binAt('TERM', 1) === 14e6, 'a seeded wall prices like a live one');
ok(b.binDepth('TERM') === 4, 'seeded depth is real depth');

// The live snapshot must fully replace the seed - a stale listing that already
// sold cannot be allowed to linger under a real one.
b.rebuildBinWall([{ bin: true, price: 20e6, keys: { base: 'TERM', variant: 'TERM' } }]);
ok(b.binDepth('TERM') === 1 && b.binAt('TERM', 0) === 20e6, 'the first live snapshot replaces the seeded wall outright');

// --- sold ------------------------------------------------------------------
b = new PriceBook(cfg);
ok(b.seedSold({ TERM: [20e6, 12], THIN: [1e6, 1] }, now) === 2, 'seeded sold medians load');
ok(b.soldStats('TERM').median === 20e6 && b.soldStats('TERM').n === 12, 'seeded median is readable');
ok(b.soldStats('TERM').seeded === true, 'seeded reads are labelled, not passed off as live');
ok(b.soldStats('NOPE').n === 0, 'unknown keys stay unknown');

// Two live sales must not overrule a median built from twelve.
b.addSales([{ key: 'TERM', price: 5e6, at: now, auctionId: 'x1' }, { key: 'TERM', price: 5.1e6, at: now, auctionId: 'x2' }]);
ok(b.soldStats('TERM').n === 12 && b.soldStats('TERM').median === 20e6, 'the deeper sample wins during handover');

// Once live has more sales than the seed, live takes over completely.
for (let i = 0; i < 14; i++) b.addSales([{ key: 'TERM', price: 5e6, at: now, auctionId: 'y' + i }]);
const after = b.soldStats('TERM');
ok(after.n === 16 && after.median === 5e6 && !after.seeded, 'live overtakes the seed once it has more samples');

// A seed older than the window is worse than no seed: confident and wrong.
b = new PriceBook(cfg);
b.seedSold({ TERM: [20e6, 12] }, now - 46 * 60000);
b.prune();
ok(b.soldStats('TERM').n === 0, 'a seed older than the sold window is dropped');
ok(b.stats().seededKeys === 0, 'stats report the dropped seed');

// --- shape tolerance --------------------------------------------------------
b = new PriceBook(cfg);
b.seedSold({ A: [0, 5], B: [100, 3] });
ok(b.soldStats('A').n === 0 && b.soldStats('B').median === 100, 'zero medians are rejected, real ones kept');
ok(b.seedWall(null) === 0 && b.seedSold(null) === 0, 'a missing seed is a no-op, not a crash');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL SEED TESTS PASSED');
process.exit(fails ? 1 : 0);
