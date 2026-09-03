// Serves the same /api/* surface the server build does, from inside the tab, so
// app.js is byte-identical between the two builds and cannot drift.
//
// ORDERING IS THE WHOLE GAME HERE.  index.html loads this module before app.js,
// but this module has a top-level await (opening IndexedDB).  A module that
// awaits at top level yields its evaluation slot, so app.js runs to completion
// FIRST - which means every shim app.js depends on has to be installed
// synchronously, above the first await, or app.js talks to the real window.
//
// app.js does two things at module-evaluation time:
//   new EventSource('/api/stream')   <- needs the shimmed EventSource
//   fetch('/api/state')              <- needs the shimmed fetch
// Installing those after the await is why the page rendered nothing: the real
// fetch 404'd on Pages, r.json() threw on the HTML error body, and the entire
// first-paint block died with an unhandled rejection.  Nothing else ran.
window.__TERMINAL_LOCAL__ = true;

import { Store } from './store.js';
import { Engine, CONFIG } from './engine.js';
import { ahHistory, bzHistory, aggregate, coflTag } from './cofl.js';

// ---------------------------------------------------------------------------
// Synchronous section.  Everything above the first await.
// ---------------------------------------------------------------------------

const listeners = new Set();
const fan = (type, detail) => { for (const l of listeners) l(type, detail); };

let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

// Requests that arrive before the store is open queue on `ready` instead of
// escaping to the network.  handle() is a hoisted function declaration, so the
// closure is valid now even though the consts it reads are still in TDZ - it
// is only ever *called* after markReady().
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (url.startsWith('/api/') || url.startsWith(location.origin + '/api/')) {
    return ready.then(() => handle(url, init));
  }
  return realFetch(input, init);
};

// app.js opens an EventSource; give it one backed by the in-tab engine.
// The constructor must not touch `engine` - it runs before the engine exists.
window.EventSource = class {
  constructor() {
    this.handlers = {};
    this.readyState = 1;
    listeners.add((type, detail) => {
      const h = this.handlers[type];
      if (h) h({ data: JSON.stringify(detail) });
    });
  }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  removeEventListener(type) { delete this.handlers[type]; }
  close() { this.readyState = 2; }
};

const RANGES = {
  '1h': { ms: 3600e3, bucket: 60e3 }, '6h': { ms: 6 * 3600e3, bucket: 5 * 60e3 },
  '24h': { ms: 24 * 3600e3, bucket: 15 * 60e3 }, '7d': { ms: 7 * 864e5, bucket: 3600e3 },
  '30d': { ms: 30 * 864e5, bucket: 6 * 3600e3 }, all: { ms: Infinity, bucket: 864e5 },
};

const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
// Async section.  From here the store and engine exist.
// ---------------------------------------------------------------------------

const store = await Store.create();
const engine = new Engine(store);

for (const t of ['flips', 'bazaar', 'stats', 'log', 'alert']) {
  engine.addEventListener(t, (e) => fan(t, e.detail));
}
// app.js repaints the slow panels on 'tick'; the stats beat is the heartbeat.
engine.addEventListener('stats', () => fan('tick', {}));

CONFIG.apiKey = localStorage.getItem('hypixelKey') || '';

async function watchRows() { return engine.loadWatchlist(); }

const routes = {
  '/api/version': async () => json({ api: 3, startedAt: Date.now(), pid: 0, mode: 'browser' }),

  '/api/state': async () => json({
    stats: { ...engine.stats, book: engine.book.stats(), warmedUp: engine.warmedUp, phase: engine.phase(), seed: engine.seedMeta },
    flips: engine.recentFlips.slice(0, 120),
    bazaar: { orders: engine.lastBazaar.orders.slice(0, 40), crafts: engine.lastBazaar.crafts.slice(0, 40), at: engine.lastBazaar.at },
    alerts: (await store.all('alerts', 60, 'byTs', 'prev')),
    watchlist: await watchRows(),
    db: await store.stats(),
    canWrite: true,
    cfg: { alerts: CONFIG.alerts, minProfit: CONFIG.minProfit, maxBudget: CONFIG.maxBudget },
  }),

  '/api/db': async () => json(await store.stats()),

  '/api/item': async (u) => {
    const key = u.searchParams.get('key');
    const range = u.searchParams.get('range') || '24h';
    const r = RANGES[range] || RANGES['24h'];
    const since = r.ms === Infinity ? 0 : Date.now() - r.ms;

    // Our own history only goes back to whenever this tab first opened, which
    // for a fresh tab is nothing at all. Coflnet's archive fills in the past.
    const [bin, sales, bzRows, cAh, cBz, ref] = await Promise.all([
      store.range('bin', key, since),
      store.range('sales', key, since, 'byKeyTs'),
      store.range('bz', key, since),
      ahHistory(key, range),
      engine.books.has(key) ? bzHistory(key, range) : Promise.resolve([]),
      aggregate(key),
    ]);

    const live = engine.books.get(key);
    const latestBz = bzRows.length ? bzRows[bzRows.length - 1] : null;
    const current = bin.length ? bin[bin.length - 1] : null;
    // The live wall beats stored history for "what is it right now" - a tab
    // opened ten seconds ago has a full wall in memory and nothing on disk.
    const liveWall = engine.book.lowestBin.get(key);

    // Ours wins where we have it; theirs covers everything before that.
    const splice = (theirs, ours) => {
      if (!theirs.length) return ours;
      if (!ours.length) return theirs.filter(x => x.t >= since);
      const from = ours[0].t;
      return theirs.filter(x => x.t < from && x.t >= since).concat(ours);
    };

    const binLocal = Store.bucket(bin, r.bucket, x => x.lowest);
    const salesLocal = Store.bucket(sales, r.bucket, x => x.price);

    // Bucket the two sides of the bazaar separately. Taking low/avg of one
    // series and labelling them "buy" and "sell" was drawing a spread that
    // never existed.
    const bzLocal = (() => {
      const m = new Map();
      for (const row of bzRows) {
        const t = Math.floor(row.ts / r.bucket) * r.bucket;
        let b = m.get(t);
        if (!b) m.set(t, (b = { t, nb: 0, ns: 0, buy: 0, sell: 0 }));
        if (row.buy_order) { b.buy += row.buy_order; b.nb++; }
        if (row.sell_order) { b.sell += row.sell_order; b.ns++; }
      }
      return [...m.values()].sort((a, b) => a.t - b.t)
        .map(b => ({ t: b.t, buy: b.nb ? b.buy / b.nb : 0, sell: b.ns ? b.sell / b.ns : 0 }));
    })();

    const binSeries = splice(cAh.map(x => ({ t: x.t, n: x.n, avg: x.avg, low: x.low, high: x.high })), binLocal);
    const salesSeries = splice(cAh.map(x => ({ t: x.t, n: x.n, avg: x.avg, low: x.low, high: x.high })), salesLocal);
    const bzSeries = splice(cBz, bzLocal);

    return json({
      key,
      kind: (current || liveWall || binSeries.length) && (latestBz || live) ? 'both'
        : (latestBz || live) && !liveWall ? 'bz' : 'ah',
      current,
      bzCurrent: latestBz || (live ? { ts: engine.lastBazaar.at, buy_order: live.buyOrder, sell_order: live.sellOrder,
        instant_buy: live.instantBuy, instant_sell: live.instantSell, buy_vol_week: live.buyVolWeek, sell_vol_week: live.sellVolWeek,
        buy_orders: live.buyOrders, sell_offers: live.sellOffers } : null),
      bin: binSeries,
      sales: salesSeries,
      bazaar: bzSeries,
      recentSales: sales.slice(-40).reverse(),
      // What the item normally goes for, across every configuration of it.
      // Context only - it knows nothing about enchants, stars or attributes.
      ref: ref ? { ...ref, source: 'coflnet' } : null,
      history: {
        ah: cAh.length ? (binLocal.length ? 'coflnet+local' : 'coflnet') : (binLocal.length ? 'local' : 'none'),
        bz: cBz.length ? (bzLocal.length ? 'coflnet+local' : 'coflnet') : (bzLocal.length ? 'local' : 'none'),
        tag: coflTag(key),
      },
      wall: liveWall
        ? { ts: engine.lastUpdated, depth: liveWall.length, prices: liveWall }
        : current ? { ts: current.ts, depth: current.depth, prices: current.wall || [] } : null,
      depth: live ? { ts: engine.lastBazaar.at, bids: live.bids, asks: live.asks,
        buyOrders: live.buyOrders, sellOffers: live.sellOffers,
        askUnits: live.askUnits, bidUnits: live.bidUnits,
        askTruncated: live.askTruncated, bidTruncated: live.bidTruncated } : null,
      depthHistory: [],
      flips: engine.recentFlips.filter(f => f.keyBase === key || f.keyVariant === key).slice(0, 25),
    });
  },

  '/api/search': async (u) => {
    const q = (u.searchParams.get('q') || '').trim().toUpperCase();
    if (q.length < 2) return json({ results: [] });
    const seen = new Map();
    for (const k of engine.book.lowestBin.keys()) if (k.toUpperCase().includes(q)) seen.set(k, { id: k, kind: 'ah', n: 1 });
    for (const k of engine.books.keys()) {
      if (!k.toUpperCase().includes(q)) continue;
      seen.set(k, seen.has(k) ? { id: k, kind: 'both', n: 2 } : { id: k, kind: 'bz', n: 1 });
    }
    return json({ results: [...seen.values()].slice(0, 40) });
  },

  '/api/bazaar': async (u) => {
    const q = (u.searchParams.get('q') || '').trim().toUpperCase();
    const sort = u.searchParams.get('sort') || 'volume';
    const rows = [];
    for (const [id, t] of engine.books) {
      if (q && !id.toUpperCase().includes(q)) continue;
      const spread = t.sellOrder - t.buyOrder;
      rows.push({ id, buy: t.buyOrder, sell: t.sellOrder, instantBuy: t.instantBuy, instantSell: t.instantSell,
        spread, spreadPct: t.buyOrder > 0 ? (spread / t.buyOrder) * 100 : 0,
        buyVol: t.buyVolWeek, sellVol: t.sellVolWeek,
        buyOrders: t.buyOrders, sellOffers: t.sellOffers,
        askUnits: t.askUnits, bidUnits: t.bidUnits,
        chg1h: t.chg1h ?? null, chg24h: t.chg24h ?? null, ts: engine.lastBazaar.at });
    }
    const by = {
      volume: (a, b) => b.sellVol - a.sellVol,
      // Movers first, but a product with no change figure yet must not sort as 0%
      // and displace something that genuinely has not moved.
      movers: (a, b) => (b.chg1h == null ? -1 : Math.abs(b.chg1h)) - (a.chg1h == null ? -1 : Math.abs(a.chg1h)),
      spread: (a, b) => b.spreadPct - a.spreadPct,
      price: (a, b) => b.sell - a.sell,
    };
    rows.sort(by[sort] || by.volume);
    return json({ rows: rows.slice(0, 300), sort });
  },

  '/api/overview': async (u) => {
    const back = Number(u.searchParams.get('since') || 6 * 3600e3);
    const since = Date.now() - back;
    const movers = [], volume = new Map();
    for (const key of engine.book.lowestBin.keys()) {
      const rows = await store.range('bin', key, since);
      if (rows.length < 2) continue;
      const f = rows[0], l = rows[rows.length - 1];
      if (f.lowest <= 100000 || l.depth < 4 || f.depth < 4) continue;
      const pct = ((l.lowest - f.lowest) / f.lowest) * 100;
      if (Math.abs(pct) >= 300) continue;
      movers.push({ key, then_price: f.lowest, now_price: l.lowest, depth: l.depth, pct });
    }
    movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    for (const s of await store.all('sales')) {
      if (s.ts < since) continue;
      const v = volume.get(s.key) || { key: s.key, sales: 0, coins: 0 };
      v.sales++; v.coins += s.price; volume.set(s.key, v);
    }
    const bzMovers = [];
    for (const product of engine.books.keys()) {
      const rows = await store.range('bz', product, since);
      if (rows.length < 2) continue;
      const f = rows[0], l = rows[rows.length - 1];
      if (!f.sell_order) continue;
      bzMovers.push({ product, then_price: f.sell_order, now_price: l.sell_order,
        buy_order: l.buy_order, pct: ((l.sell_order - f.sell_order) / f.sell_order) * 100 });
    }
    bzMovers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    // Nothing has two data points in a brand-new tab, so fall back to the live
    // spread board rather than showing four empty tables for six hours.
    return json({
      movers: movers.slice(0, 40),
      volume: [...volume.values()].map(v => ({ ...v, avg: v.coins / v.sales })).sort((a, b) => b.coins - a.coins).slice(0, 40),
      spreads: engine.lastBazaar.orders.slice(0, 40),
      bzMovers: bzMovers.slice(0, 40),
      warming: movers.length === 0 && bzMovers.length === 0,
    });
  },

  '/api/tickers': async () => {
    const since = Date.now() - 6 * 3600e3;
    const watched = await watchRows();
    const rows = await Promise.all(watched.map(async (w) => {
      const isBz = engine.books.has(w.key);
      const [ah, bz] = await Promise.all([
        store.range('bin', w.key, since),
        isBz ? store.range('bz', w.key, since) : Promise.resolve([]),
      ]);
      let series = ah.length ? ah.map(r => [r.ts, r.lowest]) : bz.map(r => [r.ts, r.sell_order]);
      let source = ah.length ? 'ah' : bz.length ? 'bz' : null;

      // A sparkline needs a line. Six hours of nothing is what a tab that
      // opened two minutes ago has, so fall back to the archive rather than
      // drawing a watchlist of flat dashes.
      if (series.length < 2) {
        const hist = isBz ? await bzHistory(w.key, '24h') : await ahHistory(w.key, '24h');
        if (hist.length > 1) {
          series = hist.map(r => [r.t, isBz ? (r.sell || r.avg) : r.avg]).filter(p => p[1] > 0);
          source = 'coflnet';
        }
      }

      const step = Math.max(1, Math.ceil(series.length / 48));
      const spark = series.filter((_, i) => i % step === 0);
      const first = series.length ? series[0][1] : null;
      let last = series.length ? series[series.length - 1][1] : null;
      // Whatever the history says, the price now is the price now.
      const liveAh = engine.book.binAt(w.key, 0);
      const liveBz = engine.books.get(w.key);
      const live = liveAh || (liveBz ? liveBz.sellOrder : 0);
      if (live) last = live;
      return { ...w, kind: isBz ? 'bz' : 'ah', source, price: last ?? null, first,
        changePct: first && last ? ((last - first) / first) * 100 : null, spark,
        hit: last != null && ((w.below && last <= w.below) || (w.above && last >= w.above)) };
    }));
    return json({ tickers: rows });
  },

  '/api/depth': async (u) => {
    const product = u.searchParams.get('product');
    const live = engine.books.get(product);
    return json({ product, live: live ? { ts: engine.lastBazaar.at, bids: live.bids, asks: live.asks,
      buyOrders: live.buyOrders, sellOffers: live.sellOffers, askUnits: live.askUnits, bidUnits: live.bidUnits } : null, stored: null });
  },
};

async function handle(url, init = {}) {
  const u = new URL(url, location.origin);
  const method = (init.method || 'GET').toUpperCase();

  if (u.pathname === '/api/watchlist' && method === 'POST') {
    const w = JSON.parse(init.body);
    await store.putMany('watchlist', [{ key: w.key, label: w.label || w.key, below: w.below || null, above: w.above || null, added_ts: Date.now() }]);
    return json({ ok: true, watchlist: await watchRows() });
  }
  if (u.pathname === '/api/watchlist' && method === 'DELETE') {
    await store.del('watchlist', u.searchParams.get('key'));
    return json({ ok: true, watchlist: await watchRows() });
  }
  if (u.pathname === '/api/alerts/seen' && method === 'POST') return json({ ok: true });

  const r = routes[u.pathname];
  if (r) {
    try { return await r(u); }
    catch (e) { return json({ error: String(e && e.message || e) }); }
  }
  return new Response('not found', { status: 404 });
}

window.__engine = engine;
window.__store = store;

markReady();
engine.start();
