'use strict';
// End-to-end over the real decode -> key -> price -> strategy path, using real
// Hypixel item_bytes but a fabricated order book (the API is not reachable from CI).
const assert = require('assert');
const { Flipper } = require('../src/main/engine/poller');
const store = require('../src/main/store');
const fx = require('./fixtures/real-items.json');

const cfg = { ...store.defaults(), minProfit: 100000, minMarginPct: 5, minSampleSize: 3 };

function auction(uuid, price, bytes, name) {
  return { uuid, bin: true, starting_bid: price, item_bytes: bytes, item_name: name, item_lore: '', tier: 'RARE', start: Date.now() };
}

(async () => {
  const f = new Flipper(cfg);
  const fired = [];
  f.on('flips', (batch) => fired.push(...batch));

  const wall = [
    auction('a1', 10000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('a2', 12000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('a3', 13000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('a4', 14000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('b1', 500000, fx.plain.item_bytes, 'Night Saver'),
  ];

  // Snapshot 1 = baseline only. Nothing should fire even though a4 is "expensive".
  await f.processSnapshot(wall, 1);
  assert.strictEqual(fired.length, 0, 'baseline snapshot must not emit flips');
  console.log('PASS baseline snapshot is silent');

  // Snapshot 2 introduces an obvious underpriced listing.
  const snipe = auction('a5', 3000000, fx.star.item_bytes, 'Ghostly Boots');
  await f.processSnapshot([...wall, snipe], 2);
  assert.strictEqual(fired.length, 1, `expected exactly 1 flip, got ${fired.length}`);
  const flip = fired[0];
  console.log('PASS snipe detected:', JSON.stringify({
    name: flip.name, price: flip.price, value: flip.value, profit: flip.profit,
    margin: flip.marginPct, strategy: flip.strategy, basis: flip.basis, cmd: flip.command,
  }));
  assert.strictEqual(flip.strategy, 'lowest-bin');
  // The wall is rebuilt WITH the snipe in it, so index 1 is the next listing up -
  // which is exactly what you would have to undercut to actually sell it.
  assert.strictEqual(flip.value, 10000000, 'must price against the next listing up, not itself');
  assert.strictEqual(flip.profit, 6800000, '10m minus 2% tax minus the 3m buy');
  assert.strictEqual(flip.command, '/viewauction a5');

  // Sold history should take over and outrank the wall once it has samples.
  const key = f.keyCache.get('a5').keys;
  f.book.addSales([
    { key: key.variant, price: 20000000, auctionId: 's1' },
    { key: key.variant, price: 21000000, auctionId: 's2' },
    { key: key.variant, price: 20500000, auctionId: 's3' },
  ]);
  fired.length = 0;
  const snipe2 = auction('a6', 3000000, fx.star.item_bytes, 'Ghostly Boots');
  await f.processSnapshot([...wall, snipe, snipe2], 3);
  assert.strictEqual(fired.length, 1);
  console.log('PASS sold-median outranks the wall:', JSON.stringify({
    strategy: fired[0].strategy, basis: fired[0].basis, value: fired[0].value, also: fired[0].alsoMatched,
  }));
  assert.strictEqual(fired[0].strategy, 'sold-median');
  assert.strictEqual(fired[0].value, 20500000);

  // Budget / floor filters must actually bite.
  const tight = new Flipper({ ...cfg, maxBudget: 1000000 });
  const fired2 = [];
  tight.on('flips', b => fired2.push(...b));
  await tight.processSnapshot(wall, 1);
  await tight.processSnapshot([...wall, auction('a7', 3000000, fx.star.item_bytes, 'Ghostly Boots')], 2);
  assert.strictEqual(fired2.length, 0, 'over-budget flip must be filtered out');
  console.log('PASS budget filter rejects over-budget flips');

  // One sale must count as one sample even when variant === base, or the
  // minSampleSize gate stops meaning anything for plain items.
  const { decodeItemBytes, readItem, pricingKeys } = require('../src/main/engine/nbt');
  const plainItem = readItem(await decodeItemBytes(fx.plain.item_bytes));
  const plainKeys = pricingKeys(plainItem);
  assert.strictEqual(plainKeys.variant, plainKeys.base, 'fixture should be a plain item');
  const dedup = new Flipper(cfg);
  const rows = [...new Set([plainKeys.variant, plainKeys.base].filter(Boolean))]
    .map(k => ({ key: k, price: 1000, auctionId: `sale1:${k}` }));
  dedup.book.addSales(rows);
  assert.strictEqual(dedup.book.soldStats(plainKeys.base).n, 1, 'one sale must be one sample');
  console.log('PASS one sale counts once for plain items');

  console.log('\nALL PIPELINE TESTS PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
