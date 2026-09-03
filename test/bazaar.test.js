'use strict';
// Bazaar maths, driven by a hand-built order book so the numbers are checkable.
//
// The fixture below mirrors the REAL Hypixel shape, verified against live data:
//   buy_summary  = the ASK side (sell offers you can buy from)  - the HIGH side
//   sell_summary = the BID side (buy orders you can sell into)  - the LOW side
// An earlier version of this file had them the other way round, which is why it
// happily passed while topOfBook was inverted and no order flip could ever fire.
const assert = require('assert');
const { orderFlips, craftFlips, topOfBook, validateRatios, RATIOS } = require('../src/main/engine/bazaar');
const store = require('../src/main/store');

const cfg = {
  ...store.defaults(),
  maxBudget: 100000000,
  bazaar: { minWeeklyVolume: 1000, minSpreadPct: 5, minProfitPerFlip: 1, taxPct: 1.25 },
};

function book(ask, bid, volWeek) {
  assert.ok(ask > bid, 'fixture is nonsense: the ask must sit above the bid');
  return {
    buy_summary: [{ pricePerUnit: ask }],
    sell_summary: [{ pricePerUnit: bid }],
    quick_status: { buyPrice: ask, sellPrice: bid, buyMovingWeek: volWeek, sellMovingWeek: volWeek },
  };
}

// --- the regression that matters --------------------------------------------
// Real numbers observed live for ENCHANTED_LAPIS_LAZULI.
const lapis = book(1103.5, 794.3, 900000);
const t = topOfBook(lapis);
assert.ok(t.sellOrder > t.buyOrder,
  `sell side must be above buy side, got buy ${t.buyOrder} / sell ${t.sellOrder}`);
assert.strictEqual(+t.buyOrder.toFixed(1), 794.4, 'buy order outbids the best bid');
assert.strictEqual(+t.sellOrder.toFixed(1), 1103.4, 'sell offer undercuts the cheapest ask');
console.log('PASS bid/ask orientation matches the live API', JSON.stringify({ buy: t.buyOrder, sell: t.sellOrder }));

const products = {
  WIDGET: book(200, 100, 700000),
  THIN_WIDGET: book(200, 100, 10),
  DIAMOND: book(11, 10, 10000000),
  ENCHANTED_DIAMOND: book(2200, 2000, 500000),
};

const orders = orderFlips(products, cfg);
const ids = orders.map(o => o.id);
assert.ok(orders.length > 0, 'a healthy book must produce at least one order flip');
assert.ok(ids.includes('WIDGET'), 'liquid spread should be flagged');
assert.ok(!ids.includes('THIN_WIDGET'), 'illiquid spread must be filtered by volume');
for (const o of orders) assert.ok(o.perUnit > 0 && o.spreadPct > 0, `${o.id} must have a positive spread`);
const w = orders.find(o => o.id === 'WIDGET');
const expectedPerUnit = 199.9 * (1 - 0.0125) - 100.1;
assert.ok(Math.abs(w.perUnit - expectedPerUnit) < 0.01, `perUnit ${w.perUnit} vs ${expectedPerUnit}`);
console.log('PASS bazaar order flip:', JSON.stringify(w));

const crafts = craftFlips(products, cfg);
const cd = crafts.find(c => c.id === 'ENCHANTED_DIAMOND');
assert.ok(cd, 'enchanted diamond craft should be found');
assert.strictEqual(cd.costPerCraft, Math.round(10.1 * 160));
assert.strictEqual(cd.qty, 160);
assert.strictEqual(cd.input, 'DIAMOND');
console.log('PASS bazaar craft flip:', JSON.stringify(cd));

// An unprofitable craft must not appear at all.
const flat = craftFlips({ DIAMOND: book(21, 20, 1e7), ENCHANTED_DIAMOND: book(2100, 2000, 5e5) }, cfg);
assert.strictEqual(flat.length, 0, 'craft priced above output must be rejected');
console.log('PASS unprofitable craft rejected');

// The bundled table must not reference ids that do not exist.
const fake = {};
for (const [out, r] of Object.entries(RATIOS)) {
  if (out.startsWith('_')) continue;
  fake[out] = book(2, 1, 1); fake[r.input] = book(2, 1, 1);
}
assert.strictEqual(validateRatios(fake).length, 0);
console.log(`PASS craft table self-consistent (${Object.keys(RATIOS).length - 1} conversions)`);

console.log('\nALL BAZAAR TESTS PASSED');
