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
  let board = [];
  f.on('flips', (b) => { board = b; });   // every snapshot emits the WHOLE board

  const wall = [
    auction('a1', 10000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('a2', 12000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('a3', 13000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('a4', 14000000, fx.star.item_bytes, 'Ghostly Boots'),
    auction('b1', 500000, fx.plain.item_bytes, 'Night Saver'),
  ];

  // Snapshot 1 is a real board, not a silent baseline. Waiting for a second
  // snapshot bought nothing: every strategy prices against the wall or the sold
  // feed, and neither needs a listing to be new. a1 at 10m under a 12m wall is
  // a flip on sight; a4 at the top of the wall is not; b1 has a one-deep wall.
  await f.processSnapshot(wall, 1);
  assert.strictEqual(board.length, 1, `first snapshot should show the one underpriced listing, got ${board.length}`);
  assert.strictEqual(board[0].uuid, 'a1');
  assert.strictEqual(board[0].value, 12000000, 'priced against the next listing up');
  assert.strictEqual(board[0].profit, 1760000, '12m minus 2% tax minus the 10m buy');
  assert.strictEqual(board[0].isNew, false, 'nothing is "new" on the first snapshot - there is no diff yet');
  console.log('PASS first snapshot shows real flips instead of an empty panel');

  // Snapshot 2 introduces an obviously underpriced listing.
  const snipe = auction('a5', 3000000, fx.star.item_bytes, 'Ghostly Boots');
  await f.processSnapshot([...wall, snipe], 2);
  const flip = board[0];
  console.log('PASS snipe detected:', JSON.stringify({
    name: flip.name, price: flip.price, value: flip.value, profit: flip.profit,
    margin: flip.marginPct, strategy: flip.strategy, basis: flip.basis, isNew: flip.isNew, cmd: flip.command,
  }));
  assert.strictEqual(flip.uuid, 'a5', 'the biggest profit sorts to the top');
  assert.strictEqual(flip.isNew, true, 'a listing absent from the previous snapshot is flagged new');
  assert.strictEqual(flip.strategy, 'lowest-bin');
  // The wall is rebuilt WITH the snipe in it, so index 1 is the next listing up -
  // which is exactly what you would have to undercut to actually sell it.
  assert.strictEqual(flip.value, 10000000, 'must price against the next listing up, not itself');
  assert.strictEqual(flip.profit, 6800000, '10m minus 2% tax minus the 3m buy');
  assert.strictEqual(flip.command, '/viewauction a5');
  assert.ok(board.every(x => x.uuid !== 'a4'), 'a listing at the top of the wall is never a flip');

  // The board is a snapshot of what is buyable now, not an append-only log:
  // a row whose listing left the wall has to disappear or it wastes a click.
  await f.processSnapshot(wall, 3);
  assert.ok(board.every(x => x.uuid !== 'a5'), 'a sold/cancelled listing drops off the board');
  console.log('PASS board drops listings that left the wall');

  // Sold history should take over and outrank the wall once it has samples.
  const key = f.keyCache.get('a1').keys;
  f.book.addSales([
    { key: key.variant, price: 20000000, auctionId: 's1' },
    { key: key.variant, price: 21000000, auctionId: 's2' },
    { key: key.variant, price: 20500000, auctionId: 's3' },
  ]);
  const snipe2 = auction('a6', 3000000, fx.star.item_bytes, 'Ghostly Boots');
  await f.processSnapshot([...wall, snipe2], 4);
  console.log('PASS sold-median outranks the wall:', JSON.stringify({
    strategy: board[0].strategy, basis: board[0].basis, value: board[0].value, also: board[0].alsoMatched,
  }));
  assert.strictEqual(board[0].strategy, 'sold-median');
  assert.strictEqual(board[0].value, 20500000);

  // Budget / floor filters must actually bite.
  const tight = new Flipper({ ...cfg, maxBudget: 1000000 });
  let tightBoard = [];
  tight.on('flips', b => { tightBoard = b; });
  await tight.processSnapshot([...wall, auction('a7', 3000000, fx.star.item_bytes, 'Ghostly Boots')], 1);
  assert.strictEqual(tightBoard.length, 0, 'over-budget flips must be filtered out');
  console.log('PASS budget filter rejects over-budget flips');

  // --- the fake-flip regression --------------------------------------------
  // A recombobulated item and a stock one share a BASE key. Pricing the stock
  // one against that mixed wall invents a discount that does not exist. It must
  // refuse rather than guess.
  const { decodeItemBytes, readItem, pricingKeys } = require('../src/main/engine/nbt');
  const kitted = pricingKeys(readItem(await decodeItemBytes(fx.star.item_bytes)));
  const plain = pricingKeys(readItem(await decodeItemBytes(fx.plain.item_bytes)));
  assert.strictEqual(kitted.plain, false, 'recombobulated item is not plain');
  assert.strictEqual(plain.plain, true, 'stock item is plain');
  assert.notStrictEqual(kitted.variant, kitted.base, 'a modified item gets its own variant key');

  const { evaluate } = require('../src/main/engine/strategies');
  const { PriceBook } = require('../src/main/engine/pricing');
  const mixed = new PriceBook(cfg);
  // Three stock copies at 14m+, and one lone kitted listing at 8m. All four land
  // in the BASE bucket - that is what base is for - so the base wall reads 14m
  // even though no stock copy is comparable to the kitted one.
  const stockKeys = { base: kitted.base, variant: `${kitted.base}|stock`, stock: `${kitted.base}|stock`, plain: true };
  mixed.rebuildBinWall([
    { bin: true, price: 14000000, keys: stockKeys },
    { bin: true, price: 14500000, keys: stockKeys },
    { bin: true, price: 15000000, keys: stockKeys },
    { bin: true, price: 8000000, keys: kitted },
  ]);
  assert.strictEqual(mixed.binDepth(kitted.base), 4, 'the base bucket pools every copy, as designed');
  assert.strictEqual(mixed.binDepth(stockKeys.variant), 3, 'the stock bucket holds only stock copies');
  assert.strictEqual(mixed.binAt(stockKeys.variant, 0), 14000000, 'the kitted 8m listing does not drag the stock wall down');
  const bogus = evaluate({
    auction: auction('x1', 8000000, fx.star.item_bytes, 'Ghostly Boots'),
    item: readItem(await decodeItemBytes(fx.star.item_bytes)), keys: kitted, book: mixed, cfg,
  });
  assert.strictEqual(bogus, null, 'a modified item with no wall of its own must NOT be priced off the base wall');
  console.log('PASS modified item is not priced against the mixed base wall');

  // A stock copy gets its own key rather than sharing the base key, so the
  // stock bucket is never polluted by kitted copies.
  assert.strictEqual(plain.variant, `${plain.base}|stock`, 'a stock copy has its own variant key');
  assert.strictEqual(plain.variant, plain.stock, 'for a stock copy, variant IS the stock bucket');
  assert.notStrictEqual(plain.variant, plain.base, 'stock and base are different buckets');
  const dedup = new Flipper(cfg);
  const rows = [...new Set([plain.variant, plain.base].filter(Boolean))]
    .map(k => ({ key: k, price: 1000, auctionId: `sale1:${k}` }));
  dedup.book.addSales(rows);
  assert.strictEqual(dedup.book.soldStats(plain.base).n, 1, 'one sale is one sample in the base bucket');
  assert.strictEqual(dedup.book.soldStats(plain.variant).n, 1, 'and one in the stock bucket');
  console.log('PASS stock copies get their own bucket, separate from base');

  // A stock item must NOT be priced off the base wall either - that wall
  // includes the kitted copies, so it reads high and manufactures a flip.
  const stockOnly = new PriceBook(cfg);
  stockOnly.rebuildBinWall([
    { bin: true, price: 30000000, keys: kitted },
    { bin: true, price: 31000000, keys: kitted },
    { bin: true, price: 32000000, keys: kitted },
    { bin: true, price: 5000000, keys: { base: kitted.base, variant: `${kitted.base}|stock`, stock: `${kitted.base}|stock`, plain: true } },
  ]);
  const stockItem = readItem(await decodeItemBytes(fx.plain.item_bytes));
  const bogus2 = evaluate({
    auction: auction('x2', 5000000, fx.plain.item_bytes, 'stock copy'),
    item: stockItem,
    keys: { base: kitted.base, variant: `${kitted.base}|stock`, stock: `${kitted.base}|stock`, plain: true },
    book: stockOnly, cfg,
  });
  assert.strictEqual(bogus2, null, 'a stock copy is not priced against a base wall full of kitted copies');
  console.log('PASS stock copy is not priced against the kitted base wall');

  console.log('\nALL PIPELINE TESTS PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
