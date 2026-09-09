// The financial numbers. These are the ones someone might spend coins on, so
// each has a case with an answer worked out by hand rather than by running the
// code and enshrining whatever came out.
import assert from 'node:assert';
import {
  mean, stdev, median, realizedVol, rangeStats, maxDrawdown,
  makerEdge, takerCost, bookImbalance, hoursToClear, queueAhead,
  undercutRoom, sellThroughHours, salesRate, auctionTax, flipEdge, MIN_VOL_SAMPLES,
} from '../docs/metrics.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

// --- basics ----------------------------------------------------------------
ok(mean([1, 2, 3]) === 2, 'mean');
ok(median([3, 1, 2]) === 2 && median([4, 1, 2, 3]) === 2.5, 'median, odd and even');
// sample stdev of 2,4,4,4,5,5,7,9 is 2.13809… (n-1), not 2 (n)
ok(near(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-4), `sample stdev uses n-1 (${stdev([2,4,4,4,5,5,7,9]).toFixed(5)})`);
ok(stdev([5]) === 0 && mean([]) === 0, 'degenerate inputs do not blow up');

// --- volatility ------------------------------------------------------------
const H = 3600e3;
const flat = Array.from({ length: 20 }, (_, i) => [i * H, 100]);
ok(realizedVol(flat) === 0, 'a price that never moves has zero volatility');
ok(realizedVol(flat.slice(0, MIN_VOL_SAMPLES - 1)) === null,
  'too few samples returns null rather than a made-up number');
ok(realizedVol([]) === null && realizedVol(null) === null, 'empty input is null, not a crash');

// A series alternating 100/110 hourly. Twenty log returns of ±ln(1.1) =
// ±0.0953102, mean zero, so the SAMPLE sd is 0.0953102 * sqrt(20/19) =
// 0.097786 - and hourly vol is 9.7786%. Worth spelling out: the population sd
// would give 9.5310%, and the 2.6% difference between them is exactly the kind
// of thing that goes unnoticed if the expected value is copied from whatever
// the code happened to print.
const zig = Array.from({ length: 21 }, (_, i) => [i * H, i % 2 ? 110 : 100]);
const zv = realizedVol(zig, { perHours: 1 });
const expected = Math.log(1.1) * Math.sqrt(20 / 19) * 100;
ok(near(zv, expected, 1e-9) && near(zv, 9.7786, 1e-4),
  `hourly vol of a +/-10% zigzag is ${expected.toFixed(4)}% (got ${zv.toFixed(4)})`);

// Same series read as a daily figure scales by sqrt(24).
const zd = realizedVol(zig, { perHours: 24 });
ok(near(zd / zv, Math.sqrt(24), 1e-6), 'volatility scales with the square root of time');

// Sampling five minutes apart instead of hourly must give the SAME hourly vol
// for the same shape - the scaling has to come from the timestamps.
const zig5 = Array.from({ length: 21 }, (_, i) => [i * 5 * 60e3, i % 2 ? 110 : 100]);
ok(realizedVol(zig5, { perHours: 1 }) > zv, 'a faster zigzag is more volatile per hour, not equally so');

// One huge gap in the middle must not distort the scaling (median gap, not mean).
const gappy = [...Array.from({ length: 10 }, (_, i) => [i * H, 100 + i]),
  [200 * H, 110], ...Array.from({ length: 10 }, (_, i) => [(201 + i) * H, 110 + i])];
ok(realizedVol(gappy) !== null, 'a series with an outage still yields a figure');

// --- range and drawdown ----------------------------------------------------
const r = rangeStats([[0, 100], [H, 150], [2 * H, 120]]);
ok(r.min === 100 && r.max === 150 && r.last === 120, 'range picks out min/max/last');
ok(near(r.position, 0.4), 'position in range: 120 sits 40% up a 100-150 band');
ok(near(r.changePct, 20), 'change over the window is measured end to end');
ok(rangeStats([[0, 100]]) === null, 'one point is not a range');

ok(near(maxDrawdown([[0, 100], [1, 150], [2, 75], [3, 200]]), 50),
  'max drawdown is peak-to-trough (150 -> 75 is 50%), not first-to-last');
ok(near(maxDrawdown([[0, 10], [1, 20], [2, 30]]), 0), 'a series that only rises has no drawdown');

// --- maker edge ------------------------------------------------------------
// COAL as it actually stood: best bid 6.5, best ask 8.9. Buy at 6.6, sell at
// 8.8, 1.25% tax on the sale -> 8.69 net -> 2.09 a unit.
const coal = { bids: [{ price: 6.5, amount: 65780, orders: 1 }], asks: [{ price: 8.9, amount: 19457, orders: 1 }],
  bidUnits: 11575680, askUnits: 42124272 };
const edge = makerEdge(coal);
ok(near(edge.buyAt, 6.6) && near(edge.sellAt, 8.8), 'orders go one tick inside the touch');
ok(near(edge.perUnit, 8.8 * 0.9875 - 6.6, 1e-9), `edge is net of tax (${edge.perUnit.toFixed(4)}/unit)`);
ok(edge.perUnit < 8.8 - 6.6, 'and is therefore smaller than the raw spread');
ok(near(edge.pct, (edge.perUnit / 6.6) * 100, 1e-9), 'edge percent is against what you tie up, not the sale');

// A spread too thin to survive the tax must come out negative, not be floored.
const thin = makerEdge({ bids: [{ price: 100 }], asks: [{ price: 100.5 }] });
ok(thin.perUnit < 0, 'a spread the tax eats is reported as a loss, not clipped to zero');
ok(makerEdge({ bids: [], asks: [] }) === null && makerEdge(null) === null, 'no book, no edge');

// --- taker cost ------------------------------------------------------------
const tc = takerCost(coal);
ok(near(tc.spread, 2.4) && near(tc.mid, 7.7), 'taker cost is the raw spread around the mid');
ok(near(tc.pct, (2.4 / 7.7) * 100, 1e-9), 'quoted against the mid, the usual convention');

// --- book imbalance --------------------------------------------------------
const im = bookImbalance(coal);
ok(near(im.imbalance, (11575680 - 42124272) / (11575680 + 42124272), 1e-9),
  `imbalance is signed toward the heavier side (${im.imbalance.toFixed(3)}, ask-heavy)`);
ok(im.imbalance < 0, 'and COAL is ask-heavy, as its book says');
// The truncated ladder must not be used when the true totals are present.
const laddersOnly = bookImbalance({ bids: [{ price: 1, amount: 10 }], asks: [{ price: 2, amount: 30 }] });
ok(near(laddersOnly.imbalance, -0.5), 'falls back to the ladder only when totals are missing');

// --- clearing and queue ----------------------------------------------------
ok(near(hoursToClear(1000, 1680), 100), '1000 units against 1680/week clears in 100 hours');
ok(hoursToClear(1000, 0) === null && hoursToClear(0, 100) === null, 'no volume, no estimate');
ok(queueAhead(coal.bids, 6.5) === 65780, 'queue ahead is the size at your price');
ok(queueAhead(coal.bids, 6.4) === null, 'at a different price you are not in that queue');

// --- auction house ---------------------------------------------------------
const room = undercutRoom([8000000, 14000000, 14500000]);
ok(room.gap === 6000000 && near(room.pct, 75) && room.depth === 3, 'undercut room is the gap to the next listing');
ok(undercutRoom([100]) === null, 'a one-listing wall has no room to measure');

ok(near(sellThroughHours(20, 4), 5), '20 listings at 4 sales an hour is five hours');
ok(sellThroughHours(20, 0) === null, 'nothing selling means no estimate');

ok(near(salesRate([{ t: 0, n: 3 }, { t: H, n: 5 }, { t: 2 * H, n: 4 }]), 6),
  '12 sales across a two-hour span is 6/hour');
ok(salesRate([{ t: 0, n: 3 }]) === null, 'a single bucket has no span');

// Tax bands, on the boundaries where an off-by-one would matter.
ok(near(auctionTax(9999999), 99999.99, 1e-6), 'under 10m is 1%');
ok(near(auctionTax(10000000), 200000), 'at 10m it is 2%');
ok(near(auctionTax(100000000), 2500000), 'at 100m it is 2.5%');

const fe = flipEdge(8000000, 14000000);
ok(near(fe.tax, 280000) && near(fe.profit, 5720000), 'flip edge nets the band-correct tax');
ok(near(fe.pct, (5720000 / 8000000) * 100, 1e-9), 'and is a return on what you paid');
ok(flipEdge(0, 100) === null, 'a free buy is not a percentage');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL METRICS TESTS PASSED');
process.exit(fails ? 1 : 0);
