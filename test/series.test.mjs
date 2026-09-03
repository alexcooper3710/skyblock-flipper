// The rolling bazaar price series: what makes the book able to say what moved.
import assert from 'node:assert';
import { appendSeries, changeOver, emptySeries, STEP_MS, KEEP } from '../scripts/bz-series.mjs';

const T0 = 1_700_000_000_000;
const at = (n) => T0 + n * STEP_MS;
const products = (sell, buy = sell * 0.8, vol = 1_000_000) => ({ COAL: { s: sell, b: buy, sv: vol, bv: vol } });

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// --- growth ----------------------------------------------------------------
let s = appendSeries(emptySeries(), products(10), at(0));
ok(s.products.COAL[0].length === 1, 'first run seeds one sample');
ok(changeOver(s, 'COAL', 60) === null, 'one sample is not an hourly change');

for (let i = 1; i <= 12; i++) s = appendSeries(s, products(10 + i), at(i));
ok(s.products.COAL[0].length === 13, 'thirteen consecutive runs, thirteen samples');
const h1 = changeOver(s, 'COAL', 60);
ok(h1 !== null && Math.abs(h1 - 120) < 1, `an hour of samples gives an hourly change (${h1 && h1.toFixed(1)}%)`);
ok(changeOver(s, 'COAL', 24 * 60) === null, 'an hour of samples does NOT give a daily change');

// --- gaps ------------------------------------------------------------------
// GitHub cron is best effort. A run that arrives an hour late must not make the
// previous sample look like it was five minutes ago.
let g = appendSeries(emptySeries(), products(10), at(0));
g = appendSeries(g, products(20), at(12));           // twelve slots later
ok(g.products.COAL[0].length === 13, 'a late run pads the gap with nulls, it does not compress it');
ok(g.products.COAL[0][1] === null && g.products.COAL[0][11] === null, 'the gap really is nulls');
const gap1h = changeOver(g, 'COAL', 60);
ok(gap1h !== null && Math.abs(gap1h - 100) < 0.01, 'change across a padded gap is measured over the true hour');

// --- window honesty --------------------------------------------------------
let short = emptySeries();
for (let i = 0; i < 5; i++) short = appendSeries(short, products(10 + i), at(i));
ok(changeOver(short, 'COAL', 60) === null, '25 minutes of samples is not reported as an hour');

// --- retention -------------------------------------------------------------
let long_ = emptySeries();
for (let i = 0; i < KEEP + 40; i++) long_ = appendSeries(long_, products(10), at(i));
ok(long_.products.COAL[0].length === KEEP, `the series is capped at ${KEEP} samples`);
// t0 is the start of the oldest kept sample's slot, snapped to the step grid.
const expectedT0 = Math.floor(at(KEEP + 39) / STEP_MS) * STEP_MS - (KEEP - 1) * STEP_MS;
ok(long_.t0 === expectedT0, `t0 tracks the trimmed window (${long_.t0} vs ${expectedT0})`);
ok(long_.t0 + (KEEP - 1) * STEP_MS <= at(KEEP + 39) && at(KEEP + 39) - long_.t0 < KEEP * STEP_MS,
  'the window t0 describes covers exactly the samples kept');

// --- filtering and robustness ----------------------------------------------
const thin = appendSeries(emptySeries(), { JUNK: { s: 1, b: 0.5, sv: 10, bv: 10 } }, at(0));
ok(Object.keys(thin.products).length === 0, 'untraded products are left out entirely');
ok(changeOver(thin, 'NOPE', 60) === null, 'unknown product is null, not a crash');

// A product that goes missing for a run and comes back must not be treated as
// having no history at all.
let miss = appendSeries(emptySeries(), products(10), at(0));
for (let i = 1; i <= 12; i++) miss = appendSeries(miss, products(20), at(i));
ok(miss.products.COAL[0].length === 13, 'series survives across runs');

// A null price (product delisted for a sample) must not read as a 100% crash.
let holed = emptySeries();
for (let i = 0; i <= 12; i++) holed = appendSeries(holed, { COAL: { s: i === 6 ? 0 : 10, b: 8, sv: 1e6, bv: 1e6 } }, at(i));
const hc = changeOver(holed, 'COAL', 60);
ok(hc !== null && Math.abs(hc) < 0.01, 'a missing sample in the middle does not fake a move');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL SERIES TESTS PASSED');
process.exit(fails ? 1 : 0);
