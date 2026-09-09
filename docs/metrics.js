// The numbers a trader actually wants, defined once and computed honestly.
//
// Two rules run through all of it:
//
//   1. Every function returns null rather than a number it cannot justify.
//      A volatility figure off four samples is not a small amount of
//      information, it is misinformation with a decimal point on it.
//   2. Nothing here guesses at a fee, a fill, or a direction. Where a number
//      depends on an assumption (the bazaar tax, that your order sits at the
//      back of the queue) the assumption is a named argument, not a constant
//      buried in a formula.

// --- basics ----------------------------------------------------------------

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  // Sample standard deviation: n-1, because these are samples of a market, not
  // the whole population of prices it could have had.
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- from a price series ---------------------------------------------------
// `series` is [[t, price], …] ascending, gaps allowed (null prices skipped).

const clean = (series) => (series || [])
  .filter(p => Array.isArray(p) && Number.isFinite(p[1]) && p[1] > 0)
  .sort((a, b) => a[0] - b[0]);

export const MIN_VOL_SAMPLES = 8;

// Realised volatility: the standard deviation of log returns, rescaled to the
// horizon you asked for. Log returns because a move from 100 to 110 and one
// from 110 to 100 should be the same size in opposite directions, which is not
// true of percentage change.
//
// Returns percent (2.4 means 2.4%), or null when there is not enough to say.
export function realizedVol(series, { perHours = 1 } = {}) {
  const s = clean(series);
  if (s.length < MIN_VOL_SAMPLES) return null;
  const rets = [];
  for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i][1] / s[i - 1][1]));
  if (rets.length < MIN_VOL_SAMPLES - 1) return null;
  const sd = stdev(rets);
  // Median gap, not mean: one long outage between samples should not stretch
  // the whole scaling factor.
  const gaps = [];
  for (let i = 1; i < s.length; i++) gaps.push(s[i][0] - s[i - 1][0]);
  const stepMs = median(gaps);
  if (!(stepMs > 0)) return null;
  const perStep = (perHours * 3600e3) / stepMs;
  return sd * Math.sqrt(perStep) * 100;
}

// Where the latest price sits inside its own range: 0 = the cheapest it has
// been over the window, 1 = the dearest. Answers "is this actually low, or does
// it just feel low", which a bare price cannot.
export function rangeStats(series) {
  const s = clean(series);
  if (s.length < 2) return null;
  const prices = s.map(p => p[1]);
  const min = Math.min(...prices), max = Math.max(...prices);
  const last = prices[prices.length - 1];
  return {
    min, max, last,
    position: max > min ? (last - min) / (max - min) : 0.5,
    changePct: ((last - prices[0]) / prices[0]) * 100,
    samples: s.length,
  };
}

// Worst peak-to-trough fall inside the window. For a holder, the size of the
// hole you would have sat through.
export function maxDrawdown(series) {
  const s = clean(series);
  if (s.length < 2) return null;
  let peak = s[0][1], worst = 0;
  for (const [, p] of s) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > worst) worst = dd;
  }
  return worst * 100;
}

// --- the bazaar book -------------------------------------------------------

// What you make per unit by placing BOTH sides and being filled on both: buy at
// one tick above the best bid, sell at one tick under the best ask, minus tax
// on the sale. This is the number the bazaar flip actually turns on, and it is
// not the spread - the spread is what you would make if trading were free.
export function makerEdge(top, { taxPct = 1.25, tick = 0.1 } = {}) {
  if (!top) return null;
  const bid = top.bids && top.bids[0] ? top.bids[0].price : null;
  const ask = top.asks && top.asks[0] ? top.asks[0].price : null;
  if (!(bid > 0) || !(ask > 0)) return null;
  const buyAt = bid + tick;
  const sellAt = ask - tick;
  const net = sellAt * (1 - taxPct / 100);
  const perUnit = net - buyAt;
  return {
    buyAt, sellAt, perUnit,
    pct: buyAt > 0 ? (perUnit / buyAt) * 100 : null,
    tax: sellAt - net,
  };
}

// What crossing the spread costs right now - buy at the ask, sell at the bid.
// Always negative; it is the toll for wanting it immediately.
export function takerCost(top) {
  if (!top) return null;
  const bid = top.bids && top.bids[0] ? top.bids[0].price : null;
  const ask = top.asks && top.asks[0] ? top.asks[0].price : null;
  if (!(bid > 0) || !(ask > 0)) return null;
  const mid = (bid + ask) / 2;
  return { spread: ask - bid, mid, pct: mid > 0 ? ((ask - bid) / mid) * 100 : null };
}

// Which side of the book is heavier. +1 means all the size is bid, -1 all ask.
// Uses the true totals from quick_status when they are there, because the
// visible ladder is truncated and would understate whichever side is deeper.
export function bookImbalance(top) {
  if (!top) return null;
  const bidUnits = top.bidUnits || (top.bids || []).reduce((a, l) => a + l.amount, 0);
  const askUnits = top.askUnits || (top.asks || []).reduce((a, l) => a + l.amount, 0);
  const total = bidUnits + askUnits;
  if (!total) return null;
  return { bidUnits, askUnits, imbalance: (bidUnits - askUnits) / total };
}

// How long the resting size would take to clear at the recent rate of trade.
// A tight spread on a book that takes two days to clear is not a tight market.
export function hoursToClear(units, weeklyVolume) {
  if (!(units > 0) || !(weeklyVolume > 0)) return null;
  return units / (weeklyVolume / 168);
}

// The size sitting in front of you at the best price - what has to trade before
// your order does.
export function queueAhead(levels, price) {
  if (!levels || !levels.length || !(price > 0)) return null;
  const best = levels[0].price;
  if (Math.abs(best - price) > 1e-9) return null;
  return levels[0].amount;
}

// --- the auction house -----------------------------------------------------

// Room to undercut: the gap between the cheapest listing and the next one up.
// Thin room means you are competing on price immediately; wide means the
// cheapest listing is genuinely mispriced rather than just first.
export function undercutRoom(wall) {
  if (!wall || wall.length < 2 || !(wall[0] > 0)) return null;
  return { gap: wall[1] - wall[0], pct: ((wall[1] - wall[0]) / wall[0]) * 100, depth: wall.length };
}

// How long the listings on the wall would take to sell at the observed rate.
export function sellThroughHours(depth, salesPerHour) {
  if (!(depth > 0) || !(salesPerHour > 0)) return null;
  return depth / salesPerHour;
}

// Sales per hour from a bucketed series of counts, over the span it covers.
export function salesRate(buckets) {
  const rows = (buckets || []).filter(b => b && Number.isFinite(b.t));
  if (rows.length < 2) return null;
  const spanH = (rows[rows.length - 1].t - rows[0].t) / 3600e3;
  if (!(spanH > 0)) return null;
  const total = rows.reduce((a, b) => a + (b.n || 0), 0);
  return total / spanH;
}

// What a flip nets after the auction tax, which is banded by sale price.
export function auctionTax(price) {
  if (price >= 100000000) return price * 0.025;
  if (price >= 10000000) return price * 0.02;
  return price * 0.01;
}

export function flipEdge(price, value) {
  if (!(price > 0) || !(value > 0)) return null;
  const tax = auctionTax(value);
  const profit = value - tax - price;
  return { profit, tax, pct: (profit / price) * 100 };
}
