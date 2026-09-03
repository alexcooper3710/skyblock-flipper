// Historical market data.
//
// Hypixel's API has no history whatsoever - it only ever answers "right now".
// That is why every site with charts runs a collector, and why a tab that just
// opened has nothing to draw. Coflnet publishes their archive openly and with
// CORS enabled, verified live from this origin:
//
//   /api/item/price/{TAG}                  {min, median, mean, mode, volume, max}
//   /api/item/price/{TAG}/history/{range}  hourly {min, max, avg, volume, time}
//   /api/item/price/{TAG}/current          {sell, buy, available, isAh}
//   /api/bazaar/{TAG}/history[/{range}]    hourly {buy, sell, minBuy, maxBuy,
//                                          minSell, maxSell, buyVolume,
//                                          sellVolume, timestamp}
//
// (Moulberry's lowestbin.json / auction_averages are dead - both fail to fetch.)
//
// IMPORTANT: everything here is keyed by ITEM ID, with no idea about
// enchantments, stars, gems or attributes. So it is used for charts, context
// and as a sanity check on our own numbers - never as the thing that fires a
// flip. Letting an id-level median price a kitted item is exactly the bug that
// made the auction numbers wrong in the first place.

const API = 'https://sky.coflnet.com/api';

// Their history endpoints are hourly for day/week and daily beyond that.
const AH_RANGE = { '1h': 'day', '6h': 'day', '24h': 'day', '7d': 'week', '30d': 'month', all: 'full' };
const TTL = { hist: 10 * 60000, agg: 60 * 60000, cur: 60000 };

const mem = new Map();          // url -> {at, value}
let inFlight = 0;
const queue = [];
let brokenUntil = 0;            // back off as a whole if they are down

// Be a good guest: three at a time, and stop entirely for a minute after a
// hard failure rather than hammering someone else's free service.
function slot() {
  if (inFlight < 3) { inFlight++; return Promise.resolve(); }
  return new Promise(r => queue.push(r));
}
function release() {
  inFlight--;
  const next = queue.shift();
  if (next) { inFlight++; next(); }
}

async function get(path, ttl) {
  const hit = mem.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (Date.now() < brokenUntil) return null;
  await slot();
  try {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 12000);
    const r = await fetch(API + path, { signal: c.signal });
    clearTimeout(timer);
    if (r.status === 400 || r.status === 404) { mem.set(path, { at: Date.now(), value: null }); return null; }
    if (!r.ok) { if (r.status >= 500 || r.status === 429) brokenUntil = Date.now() + 60000; return null; }
    const value = await r.json();
    mem.set(path, { at: Date.now(), value });
    return value;
  } catch {
    brokenUntil = Date.now() + 60000;
    return null;
  } finally { release(); }
}

// Their timestamps are UTC without a zone marker; Date.parse would read them as
// local and slide every chart by the timezone offset.
const utc = (s) => {
  if (!s) return 0;
  const t = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
  return Number.isFinite(t) ? t : 0;
};

// Our pricing keys -> their item tags.
//   TERMINATOR|e:snipe4          -> TERMINATOR
//   PET:GOLDEN_DRAGON:LEGENDARY  -> PET_GOLDEN_DRAGON
//   BOOK:ULTIMATE_WISE:5         -> ENCHANTMENT_ULTIMATE_WISE_5
// All verified to return real data.
export function coflTag(key) {
  if (!key) return null;
  let k = String(key).replace(/:lv(?:100|80\+|50\+|low)$/, '').split('|')[0];
  if (k.startsWith('PET:')) { const p = k.split(':'); return p[1] ? 'PET_' + p[1] : null; }
  if (k.startsWith('BOOK:')) { const p = k.split(':'); return p[1] && p[2] ? `ENCHANTMENT_${p[1]}_${p[2]}` : null; }
  if (k.startsWith('RUNE:')) { const p = k.split(':'); return p[1] && p[2] ? `RUNE_${p[1]}_${p[2]}` : null; }
  if (k.startsWith('SHARD:')) return null;      // id-level shard prices are useless
  if (k.includes(':')) return null;
  return /^[A-Z0-9_]+$/.test(k) ? k : null;
}

// -> [{t, n, avg, low, high}]  the same shape Store.bucket produces, so the
// existing charts render it without knowing where it came from.
export async function ahHistory(key, range = '24h') {
  const tag = coflTag(key);
  if (!tag) return [];
  const rows = await get(`/item/price/${tag}/history/${AH_RANGE[range] || 'week'}`, TTL.hist);
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({ t: utc(r.time), n: r.volume || 0, avg: r.avg || 0, low: r.min || 0, high: r.max || 0 }))
    .filter(r => r.t && r.avg > 0)
    .sort((a, b) => a.t - b.t);
}

// Bazaar history -> [{t, buy, sell, low, high, n}]
//
// THE TWO SOURCES NAME THE SIDES OPPOSITELY. Verified on live COAL:
//
//                       bid side (low)   ask side (high)
//   Hypixel ladder      sell_summary 6.5  buy_summary 8.9
//   our top-of-book     buyOrder 6.6      sellOrder 8.8
//   Coflnet history     sell 6.6          buy 9.0
//
// Coflnet's `buy` is what it costs you to BUY (the ask); ours is called
// sellOrder because it is where you would place a sell offer. Same price level,
// opposite word. Splicing them without swapping makes the two lines cross and
// trade places at the seam, which looks exactly like the price inverting
// halfway through the chart.
//
// Output uses OUR convention throughout:
//   buy  = the bid side  - where you place a buy order, what you get selling
//   sell = the ask side  - where you place a sell offer, what it costs to buy
export async function bzHistory(product, range = '24h') {
  if (!product || !/^[A-Z0-9_:;-]+$/.test(product)) return [];
  const want = AH_RANGE[range] || 'week';
  const rows = await get(`/bazaar/${product}/history/${want === 'full' ? 'week' : want}`, TTL.hist)
    || await get(`/bazaar/${product}/history/week`, TTL.hist);
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({
      t: utc(r.timestamp),
      buy: r.sell || 0,            // their sell price is the bid side
      sell: r.buy || 0,            // their buy price is the ask side
      low: r.minSell ?? r.sell ?? 0,
      high: r.maxBuy ?? r.buy ?? 0,
      n: (r.buyVolume || 0) + (r.sellVolume || 0),
      avg: r.buy || 0,
    }))
    .filter(r => r.t && (r.buy || r.sell))
    .sort((a, b) => a.t - b.t);
}

// The aggregate "what does this normally go for". Context and sanity check.
export async function aggregate(key) {
  const tag = coflTag(key);
  if (!tag) return null;
  const a = await get(`/item/price/${tag}`, TTL.agg);
  if (!a || !(a.median > 0 || a.mean > 0)) return null;
  return { tag, min: a.min, median: a.median, mean: a.mean, mode: a.mode, max: a.max, volume: a.volume };
}

export async function currentBin(key) {
  const tag = coflTag(key);
  if (!tag) return null;
  const c = await get(`/item/price/${tag}/current`, TTL.cur);
  return c && (c.sell > 0 || c.buy > 0) ? c : null;
}

// Warm the cache for a batch of keys without blocking anything on it.
export async function warm(keys) {
  const tags = [...new Set(keys.map(coflTag).filter(Boolean))];
  await Promise.all(tags.map(t => aggregate(t)));
  return tags.length;
}

export const _state = () => ({ cached: mem.size, inFlight, queued: queue.length, brokenUntil });
