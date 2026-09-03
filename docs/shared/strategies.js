// GENERATED from src/main/engine/strategies.js by scripts/build-web.js - do not edit.
import { auctionTax } from './pricing.js';
// Given a newly-listed BIN auction, decide whether it is a flip and why.
// Each strategy is an independent opinion; the caller keeps the best one.


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
    lore: (auction.item_lore || '').replace(/§./g, '').split('\n').slice(0, 6),
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
  const key = book.binDepth(keys.variant) >= 3 ? keys.variant : keys.base;
  if (book.binDepth(key) < 3) return null;
  const wall = book.binAt(key, 1);
  if (!wall) return null;
  return makeFlip({
    auction, item, keys, value: wall, basis: `bin2:${key === keys.variant ? 'variant' : 'base'}`,
    strategy: 'lowest-bin', confidence: key === keys.variant ? 0.8 : 0.45,
    samples: book.binDepth(key), cfg,
  });
}

// 2. Sold-median. Slower to warm up, but it prices against money that actually
// changed hands rather than against whatever someone hopes to get.
function soldMedian({ auction, item, keys, book, cfg }) {
  for (const [key, label, conf] of [[keys.variant, 'sold:variant', 0.95], [keys.base, 'sold:base', 0.6]]) {
    if (!key) continue;
    const st = book.soldStats(key);
    if (st.n >= cfg.minSampleSize && st.median > 0) {
      return makeFlip({ auction, item, keys, value: st.median, basis: label, strategy: 'sold-median', confidence: conf, samples: st.n, cfg });
    }
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
  const base = book.binAt(keys.base, 1) || 0;
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

export { evaluate, lowestBinSnipe, soldMedian, attributeAware, passes, makeFlip };