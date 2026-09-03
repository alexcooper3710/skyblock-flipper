// The Coflnet client, and above all which side is which.
//
// This project has now had the bid/ask sides inverted twice - once in Hypixel's
// own summaries, once between our naming and Coflnet's - and both times every
// number downstream was quietly wrong rather than obviously broken. So the
// mapping gets a test with real numbers in it.
import assert from 'node:assert';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// Real COAL rows as sky.coflnet.com returned them. Their `buy` is what it costs
// you to buy (the ask, ~9); their `sell` is what you get selling (the bid, ~6.6).
const COAL_ROWS = [
  { maxBuy: 9.0, maxSell: 6.7, minBuy: 8.8, minSell: 6.5, buy: 9.0, sell: 6.6,
    sellVolume: 11129477, buyVolume: 42098781, timestamp: '2026-09-03T10:00:00' },
  { maxBuy: 9.5, maxSell: 7.2, minBuy: 8.8, minSell: 6.6, buy: 8.8, sell: 7.0,
    sellVolume: 10924067, buyVolume: 39159257, timestamp: '2026-09-03T11:00:00' },
];
const AH_ROWS = [
  { min: 690000000, max: 2.25e9, avg: 1330201711, volume: 4, time: '2026-08-27T16:00:00' },
];

const seen = [];
globalThis.fetch = async (url) => {
  seen.push(String(url));
  const u = String(url);
  const body = u.includes('/bazaar/') ? COAL_ROWS
    : u.includes('/history/') ? AH_ROWS
    : { min: 430000000, median: 519999999, mean: 569147813, mode: 5e8, volume: 67, max: 1575000000 };
  return { ok: true, status: 200, json: async () => body };
};

const { bzHistory, ahHistory, aggregate, coflTag } = await import('../docs/cofl.js');

// --- the inversion ---------------------------------------------------------
const bz = await bzHistory('COAL', '24h');
ok(bz.length === 2, 'bazaar history parses');
ok(bz[0].sell === 9.0, `sell is the ASK side - what it costs to buy (got ${bz[0].sell})`);
ok(bz[0].buy === 6.6, `buy is the BID side - what you get selling (got ${bz[0].buy})`);
ok(bz[0].sell > bz[0].buy, 'the ask must sit above the bid, or the chart lines cross');
ok(bz.every(r => r.sell > r.buy), 'every row, not just the first');
console.log(`         our {buy:${bz[0].buy}, sell:${bz[0].sell}} from their {buy:9.0, sell:6.6}`);

// --- timestamps ------------------------------------------------------------
// Their times carry no zone marker. Read as local, every chart slides by the
// timezone offset - which looks like the data being hours stale.
ok(bz[0].t === Date.parse('2026-09-03T10:00:00Z'), 'timestamps are read as UTC, not local');
ok(bz[1].t > bz[0].t, 'series is ordered oldest first');

// --- AH side ---------------------------------------------------------------
const ah = await ahHistory('HYPERION', '7d');
ok(ah.length === 1 && ah[0].avg === 1330201711, 'auction history maps avg through');
ok(ah[0].low === 690000000 && ah[0].high === 2.25e9, 'min/max become low/high for the chart');
ok(ah[0].n === 4, 'volume becomes the bucket count');

// --- tag mapping (verified against the live API) ----------------------------
ok(coflTag('TERMINATOR|e:snipe4,ultimate_soul_eater5') === 'TERMINATOR', 'variant bits are stripped');
ok(coflTag('PET:GOLDEN_DRAGON:LEGENDARY:lv100') === 'PET_GOLDEN_DRAGON', 'pets map to PET_<type>');
ok(coflTag('BOOK:ULTIMATE_WISE:5') === 'ENCHANTMENT_ULTIMATE_WISE_5', 'books map to ENCHANTMENT_<name>_<lvl>');
ok(coflTag('SHARD:MANA_POOL:3') === null, 'attribute shards have no useful id-level price');
ok(coflTag('') === null && coflTag(null) === null, 'empty keys do not become requests');

// --- caching ---------------------------------------------------------------
const before = seen.length;
await bzHistory('COAL', '24h');
ok(seen.length === before, 'a repeat call inside the TTL does not hit the network again');

const agg = await aggregate('TERMINATOR');
ok(agg && agg.median === 519999999 && agg.tag === 'TERMINATOR', 'aggregate returns the typical price');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL COFL TESTS PASSED');
process.exit(fails ? 1 : 0);
