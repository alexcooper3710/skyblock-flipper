'use strict';
// Given a newly-listed BIN auction, decide whether it is a flip and why.
// Each strategy is an independent opinion; the caller keeps the best one.

const { auctionTax } = require('./pricing');

function makeFlip({ auction, item, keys, value, basis, strategy, confidence, samples, cfg }) {
  const price = auction.starting_bid;
  const profit = Math.round(value - auctionTax(value) - price);
  const marginPct = price > 0 ? (profit / price) * 100 : 0;
  return {
    uuid: auction.uuid,
    command: `/viewauction ${auction.uuid}`,
    name: auction.item_name,
    tier: auction.tier,
    itemId: item.id,
    keyBase: keys.base,
    keyVariant: keys.variant,
    price,
    value: Math.round(value),
    profit,
    marginPct: Number(marginPct.toFixed(1)),
    strategy,
    basis,
    confidence,
    samples,
    seenAt: Date.now(),
    listedAt: auction.start,
    // The board is rebuilt against every BIN on the wall now, so makeFlip runs
    // tens of thousands of times a snapshot. Only pay for the lore regex on the
    // handful that are actually in profit.
    lore: profit > 0 ? (auction.item_lore || '').replace(/§./g, '').split('\n').slice(0, 6) : [],
  };
}

function passes(flip, cfg) {
  if (!flip) return false;
  if (flip.price > cfg.maxBudget) return false;
  if (flip.profit < cfg.minProfit) return false;
  if (flip.marginPct < cfg.minMarginPct) return false;
  return true;
}

// 1. Lowest-BIN snipe. No history required - just "this is under the wall".
// Priced against the SECOND lowest so the exit is realistic, and refuses to
// fire on a one-listing wall where the "lowest BIN" is meaningless.
function lowestBinSnipe({ auction, item, keys, book, cfg }) {
  // Variant only. The base bucket holds every copy of the item - clean,
  // recombobulated, enchanted, gemmed - so its wall is a blend of things that
  // are not this item. Pricing against it invents discounts, which is exactly
  // what made the auction numbers wrong. With no wall of its own this strategy
  // has no opinion; refusing beats guessing.
  const key = keys.variant;
  if (book.binDepth(key) < 3) return null;
  const wall = book.binAt(key, 1);
  if (!wall) return null;
  return makeFlip({
    auction, item, keys, value: wall, basis: 'bin2:variant',
    strategy: 'lowest-bin', confidence: 0.8, samples: book.binDepth(key), cfg,
  });
}

// 2. Sold-median. Slower to warm up, but it prices against money that actually
// changed hands rather than against whatever someone hopes to get.
function soldMedian({ auction, item, keys, book, cfg }) {
  // Same rule as the BIN wall, for the same reason: base-level sale history is
  // a blend of every configuration of the item, so only the variant's own
  // history says what THIS item sells for.
  const st = book.soldStats(keys.variant);
  if (st.n >= cfg.minSampleSize && st.median > 0) {
    return makeFlip({ auction, item, keys, value: st.median, basis: st.seeded ? 'sold:variant(seed)' : 'sold:variant',
      strategy: 'sold-median', confidence: 0.95, samples: st.n, cfg });
  }
  return null;
}

// 3. Attribute / roll-aware. Kuudra armour and equipment are priced by their
// attribute pair, not by the base item, so a "cheap" Molten Belt can still be
// a god roll. Falls back to the shard market when the combo itself is thin.
function attributeAware({ auction, item, keys, book, cfg }) {
  const attrs = Object.entries(item.attributes || {});
  if (!attrs.length) return null;
  attrs.sort((a, b) => b[1] - a[1]);

  const comboSold = book.soldStats(keys.variant);
  if (comboSold.n >= 2 && comboSold.median > 0) {
    return makeFlip({ auction, item, keys, value: comboSold.median, basis: 'sold:attr-combo', strategy: 'attribute', confidence: 0.9, samples: comboSold.n, cfg });
  }
  const comboWall = book.binAt(keys.variant, 1) || book.binAt(keys.variant, 0);
  if (comboWall) {
    return makeFlip({ auction, item, keys, value: comboWall, basis: 'bin:attr-combo', strategy: 'attribute', confidence: 0.7, samples: book.binDepth(keys.variant), cfg });
  }
  // Last resort: value the roll through the attribute shard market.
  // Shard value doubles per attribute level, so a level-N attribute is
  // worth roughly 2^(N-1) level-1 shards.
  let shardValue = 0;
  for (const [name, lvl] of attrs) {
    const s = book.soldStats(`SHARD:${name}:1`);
    const unit = s.n >= 2 ? s.median : book.binAt(`SHARD:${name}:1`, 0);
    if (unit) shardValue += unit * Math.pow(2, Math.max(0, lvl - 1));
  }
  if (shardValue <= 0) return null;
  // The stock wall, not the base wall: base includes every rolled copy, which
  // would double-count the very attributes the shard model is pricing.
  const base = book.binAt(keys.stock, 1) || 0;
  if (!base) return null;
  return makeFlip({ auction, item, keys, value: base + shardValue * 0.7, basis: 'shard-model', strategy: 'attribute', confidence: 0.5, samples: attrs.length, cfg });
}

const REGISTRY = [
  ['attributeAware', attributeAware],
  ['soldMedian', soldMedian],
  ['lowestBinSnipe', lowestBinSnipe],
];

// Run every enabled strategy and keep the best surviving opinion:
// most confident first, then most profitable.
function evaluate(ctx) {
  const { cfg } = ctx;
  // Cheap rejection before any strategy runs - this is on the hot path for
  // every BIN on the wall, every snapshot.
  if (ctx.auction.starting_bid > cfg.maxBudget) return null;
  const results = [];
  for (const [name, fn] of REGISTRY) {
    if (!cfg.strategies[name]) continue;
    let flip = null;
    try { flip = fn(ctx); } catch { flip = null; }
    if (passes(flip, cfg)) results.push(flip);
  }
  if (!results.length) return null;
  results.sort((a, b) => b.confidence - a.confidence || b.profit - a.profit);
  const best = results[0];
  best.alsoMatched = results.slice(1).map(r => r.strategy);
  return best;
}

module.exports = { evaluate, lowestBinSnipe, soldMedian, attributeAware, passes, makeFlip };
