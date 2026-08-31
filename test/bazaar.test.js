'use strict';
// Bazaar maths, driven by a hand-built order book so the numbers are checkable.
const assert = require('assert');
const { orderFlips, craftFlips, validateRatios, RATIOS } = require('../src/main/engine/bazaar');
const store = require('../src/main/store');

const cfg = {
  ...store.defaults(),
  maxBudget: 100000000,
  bazaar: { minWeeklyVolume: 1000, minSpreadPct: 5, minProfitPerFlip: 1, taxPct: 1.25 },
};

function product(buy, sell, volWeek) {
  return {
    buy_summary: [{ pricePerUnit: buy }],
    sell_summary: [{ pricePerUnit: sell }],
    quick_status: { buyPrice: sell, sellPrice: buy, buyMovingWeek: volWeek, sellMovingWeek: volWeek },
  };
}

const products = {
  WIDGET: product(100, 200, 700000),            // fat spread, plenty of volume
  THIN_WIDGET: product(100, 200, 10),           // same spread, nobody trades it
  DIAMOND: product(10, 11, 10000000),
  ENCHANTED_DIAMOND: product(2000, 2200, 500000),
};

const orders = orderFlips(products, cfg);
const ids = orders.map(o => o.id);
assert.ok(ids.includes('WIDGET'), 'liquid spread should be flagged');
assert.ok(!ids.includes('THIN_WIDGET'), 'illiquid spread must be filtered by volume');
const w = orders.find(o => o.id === 'WIDGET');
// buy order at 100.1, sell order at 199.9, minus 1.25% tax
const expectedPerUnit = 199.9 * (1 - 0.0125) - 100.1;
assert.ok(Math.abs(w.perUnit - expectedPerUnit) < 0.01, `perUnit ${w.perUnit} vs ${expectedPerUnit}`);
console.log('PASS bazaar order flip:', JSON.stringify(w));

const crafts = craftFlips(products, cfg);
const cd = crafts.find(c => c.id === 'ENCHANTED_DIAMOND');
assert.ok(cd, 'enchanted diamond craft should be found');
// 160 diamonds at 10.1 = 1616 in, sell order 2199.9 minus tax out
assert.strictEqual(cd.costPerCraft, Math.round(10.1 * 160));
assert.strictEqual(cd.qty, 160);
assert.strictEqual(cd.input, 'DIAMOND');
console.log('PASS bazaar craft flip:', JSON.stringify(cd));

// An unprofitable craft must not appear at all.
const flat = craftFlips({ DIAMOND: product(20, 21, 1e7), ENCHANTED_DIAMOND: product(2000, 2100, 5e5) }, cfg);
assert.strictEqual(flat.length, 0, 'craft priced above output must be rejected');
console.log('PASS unprofitable craft rejected');

// The bundled table must not reference ids that do not exist.
const fakeBazaar = {};
for (const [out, r] of Object.entries(RATIOS)) {
  if (out.startsWith('_')) continue;
  fakeBazaar[out] = product(1, 2, 1); fakeBazaar[r.input] = product(1, 2, 1);
}
assert.strictEqual(validateRatios(fakeBazaar).length, 0);
console.log(`PASS craft table self-consistent (${Object.keys(RATIOS).length - 1} conversions)`);

console.log('\nALL BAZAAR TESTS PASSED');
