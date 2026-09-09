'use strict';
// Bazaar maths, driven by a hand-built order book so the numbers are checkable.
//
// The fixture below mirrors the REAL Hypixel shape, verified against live data:
//   buy_summary  = the ASK side (sell offers you can buy from)  - the HIGH side
//   sell_summary = the BID side (buy orders you can sell into)  - the LOW side
// An earlier version of this file had them the other way round, which is why it
// happily passed while topOfBook was inverted and no order flip could ever fire.
const assert = require('assert');
const { orderFlips, craftFlips, craftBoard, topOfBook, validateRatios, RATIOS } = require('../src/main/engine/bazaar');
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

// The ladders must come out on the correct sides too, or the order book view
// draws bids above asks and looks like a broken market.
assert.ok(t.bids.length && t.asks.length, 'both ladders should be captured');
assert.ok(t.bids[0].price < t.asks[0].price,
  `best bid ${t.bids[0].price} must sit below best ask ${t.asks[0].price}`);
assert.strictEqual(t.bids[0].price, 794.3, 'bids come from sell_summary');
assert.strictEqual(t.asks[0].price, 1103.5, 'asks come from buy_summary');
console.log('PASS ladders land on the correct sides', JSON.stringify({ bid: t.bids[0].price, ask: t.asks[0].price }));

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

// --- order counts ----------------------------------------------------------
// The ladder cannot tell you how many orders exist: Hypixel truncates it at 30
// ask levels and 15 bid. This fixture is COAL as the API actually returned it -
// the ask rungs add up to 333 orders while quick_status says 648, and the bid
// rungs to 138 against 180. Reading the counts off the ladder undercounts by
// half, which is exactly the "there are more than 9 sell orders" complaint.
const coal = {
  buy_summary: Array.from({ length: 30 }, (_, i) => ({ pricePerUnit: 8.9 + i * 0.1, amount: 25000, orders: 11 })),
  sell_summary: Array.from({ length: 12 }, (_, i) => ({ pricePerUnit: 6.5 - i * 0.1, amount: 100000, orders: 11 })),
  quick_status: { buyPrice: 9.52, sellPrice: 6.45, buyMovingWeek: 55390521, sellMovingWeek: 627823926,
    buyOrders: 648, sellOrders: 180, buyVolume: 42124272, sellVolume: 11575680 },
};
const coalTop = topOfBook(coal);
assert.strictEqual(coalTop.sellOffers, 648, 'sell offers come from quick_status.buyOrders (the ask side)');
assert.strictEqual(coalTop.buyOrders, 180, 'buy orders come from quick_status.sellOrders (the bid side)');
assert.ok(coalTop.sellOffers > coal.buy_summary.reduce((a, l) => a + l.orders, 0),
  'the real count exceeds what the truncated ladder can show');
assert.strictEqual(coalTop.askUnits, 42124272);
assert.strictEqual(coalTop.bidUnits, 11575680);
assert.strictEqual(coalTop.askTruncated, true, '30 ask levels means there are more below');
assert.strictEqual(coalTop.bidTruncated, false, '12 bid levels is the whole bid side');
assert.strictEqual(coalTop.buyOrder, 6.6, 'outbid the best bid');
assert.strictEqual(coalTop.sellOrder, 8.8, 'undercut the cheapest ask');
console.log(`PASS order counts come from quick_status, not the truncated ladder {"sellOffers":${coalTop.sellOffers},"ladderSays":${coal.buy_summary.reduce((a, l) => a + l.orders, 0)}}`);

// A product with no quick_status must not crash or invent counts.
const bare = topOfBook({ buy_summary: [{ pricePerUnit: 10, amount: 1, orders: 1 }], sell_summary: [{ pricePerUnit: 5, amount: 1, orders: 1 }] });
assert.strictEqual(bare.sellOffers, 0);
assert.strictEqual(bare.buyOrders, 0);
console.log('PASS missing quick_status degrades to zero counts');

// --- the craft board -------------------------------------------------------
// craftFlips answers "what should I do now" and drops the rest. The board keeps
// everything, because a conversion slightly underwater is information and an
// empty panel is not.
const boardCfg = { ...cfg, maxBudget: 1e9 };
const first = Object.keys(RATIOS).find(k => !k.startsWith('_'));
const recipe = RATIOS[first];

// One conversion where the output is worth far more than the input.
const goodBooks = { [first]: book(4000, 3600, 5e6), [recipe.input]: book(20, 18, 5e7) };
const board = craftBoard(goodBooks, boardCfg);
assert.strictEqual(board.length, 1, 'a conversion with both products listed appears once');
const row = board[0];
assert.strictEqual(row.input, recipe.input);
assert.strictEqual(row.qty, recipe.qty);
// The input is BOUGHT as a maker: a tick above the best bid, so 18 -> 18.1.
assert.strictEqual(row.costPerCraft, Math.round(18.1 * recipe.qty),
  'input is bought a tick above the bid, not at the instant-buy price');
// The output is SOLD a tick under the best ask, minus 1.25% tax.
assert.strictEqual(row.revenuePerCraft, Math.round(3999.9 * 0.9875),
  'output is sold a tick under the ask, net of tax');
assert.strictEqual(row.perCraft, row.revenuePerCraft - row.costPerCraft,
  'per-craft is exactly revenue minus cost');
assert.strictEqual(row.profitable, row.perCraft > 0);
assert.ok(['input supply', 'output demand', 'budget'].includes(row.limitedBy),
  'the bottleneck is named');
console.log('PASS craft board prices both legs as a maker:', JSON.stringify({
  cost: row.costPerCraft, revenue: row.revenuePerCraft, per: row.perCraft, cappedBy: row.limitedBy }));

// A conversion that loses money must still be RETURNED, just flagged - that is
// the whole difference between this and craftFlips.
const badBooks = { [first]: book(100, 90, 5e6), [recipe.input]: book(20, 18, 5e7) };
const bad = craftBoard(badBooks, boardCfg);
assert.strictEqual(bad.length, 1, 'a losing conversion is still reported');
assert.ok(bad[0].perCraft < 0 && bad[0].profitable === false, 'and is flagged as a loss');
assert.strictEqual(craftFlips(badBooks, boardCfg).length, 0, 'while the flip view still drops it');
console.log('PASS the board keeps losing conversions; the flip view does not');

// A tiny budget throttles throughput without touching the per-craft economics.
const poor = craftBoard(goodBooks, { ...boardCfg, maxBudget: 1 });
assert.strictEqual(poor[0].perCraft, row.perCraft, 'budget does not change what each craft earns');
assert.strictEqual(poor[0].crafts, 0, 'only how many you can do');
assert.strictEqual(poor[0].limitedBy, 'budget', 'and the bottleneck says so');
console.log('PASS budget caps throughput, not margin');

// Missing either leg means no row, rather than one priced off half a market.
assert.strictEqual(craftBoard({ [first]: book(4000, 3600, 5e6) }, boardCfg).length, 0,
  'a recipe whose input is not on the bazaar is skipped, not priced at zero');
console.log('PASS a half-listed recipe is skipped rather than half-priced');

console.log('\nALL BAZAAR TESTS PASSED');
