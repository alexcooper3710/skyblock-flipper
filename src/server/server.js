'use strict';
// Plain node:http. No framework, no dependencies - one less thing to install.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const RANGES = {
  '1h':  { ms: 3600e3,      bucket: 60e3 },
  '6h':  { ms: 6 * 3600e3,  bucket: 5 * 60e3 },
  '24h': { ms: 24 * 3600e3, bucket: 15 * 60e3 },
  '7d':  { ms: 7 * 864e5,   bucket: 3600e3 },
  '30d': { ms: 30 * 864e5,  bucket: 6 * 3600e3 },
  'all': { ms: Infinity,    bucket: 864e5 },
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function createServer({ store, collector, cfg }) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
  };

  collector.on('flips', (f) => broadcast('flips', f));
  collector.on('alert', (a) => broadcast('alert', a));
  collector.on('stats', (s) => broadcast('stats', s));
  collector.on('bazaar', (b) => broadcast('bazaar', { orders: b.orders.slice(0, 40), crafts: b.crafts.slice(0, 40), at: b.at }));
  collector.on('log', (l) => broadcast('log', l));
  collector.on('tick', (t) => broadcast('tick', t));

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { error: 'bad url' }); }
    const p = u.pathname;

    // --- live stream --------------------------------------------------------
    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    // --- state on first paint ----------------------------------------------
    if (p === '/api/state') {
      return json(res, 200, {
        stats: collector.lastStats,
        flips: collector.lastFlips.slice(0, 80),
        bazaar: { orders: collector.lastBazaar.orders.slice(0, 40), crafts: collector.lastBazaar.crafts.slice(0, 40), at: collector.lastBazaar.at },
        alerts: store.all('SELECT * FROM alerts ORDER BY ts DESC LIMIT 60'),
        watchlist: store.all('SELECT * FROM watchlist ORDER BY added_ts DESC'),
        db: store.stats(),
        cfg: { alerts: cfg.alerts, minProfit: cfg.minProfit, maxBudget: cfg.maxBudget },
      });
    }

    if (p === '/api/db') return json(res, 200, store.stats());

    // --- item detail --------------------------------------------------------
    if (p === '/api/item') {
      const key = u.searchParams.get('key');
      if (!key) return json(res, 400, { error: 'key required' });
      const r = RANGES[u.searchParams.get('range') || '24h'] || RANGES['24h'];
      const since = r.ms === Infinity ? 0 : Date.now() - r.ms;
      const current = store.one('SELECT * FROM bin_history WHERE key = ? ORDER BY ts DESC LIMIT 1', key);
      const bzCurrent = store.bazaarLatest(key);
      return json(res, 200, {
        key,
        kind: current && bzCurrent ? 'both' : bzCurrent ? 'bz' : 'ah',
        current,
        bzCurrent,
        bin: store.priceHistory(key, since, r.bucket),
        sales: store.salesHistory(key, since, r.bucket),
        bazaar: store.bzHistory(key, since, r.bucket),
        recentSales: store.all('SELECT price, ts FROM sales WHERE key = ? ORDER BY ts DESC LIMIT 40', key),
        flips: store.all('SELECT * FROM flips WHERE key_base = ? ORDER BY ts DESC LIMIT 25', key),
      });
    }

    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim().toUpperCase();
      if (q.length < 2) return json(res, 200, { results: [] });
      return json(res, 200, { results: store.searchAll(q) });
    }

    // --- browse the bazaar book ---------------------------------------------
    if (p === '/api/bazaar') {
      const q = (u.searchParams.get('q') || '').trim();
      const rows = store.bazaarBook(q, 300).map(r => {
        const spread = r.sell_order - r.buy_order;
        return {
          id: r.product, buy: r.buy_order, sell: r.sell_order,
          instantBuy: r.instant_buy, instantSell: r.instant_sell,
          spread, spreadPct: r.buy_order > 0 ? (spread / r.buy_order) * 100 : 0,
          buyVol: r.buy_vol_week, sellVol: r.sell_vol_week, ts: r.ts,
        };
      });
      return json(res, 200, { rows });
    }

    // --- market overview ----------------------------------------------------
    if (p === '/api/overview') {
      const now = Date.now();
      const back = Number(u.searchParams.get('since') || 6 * 3600e3);
      // Depth matters here. On live data an unfiltered version was topped by
      // MINER_OUTFIT_BOOTS "130k -> 10.00m, +7592%" - which is not a move, it is
      // a single cheap listing selling and leaving only expensive ones behind.
      // Requiring several listings at BOTH ends makes the number mean something.
      const movers = store.all(`
        WITH latest AS (
          SELECT key, lowest, depth, ts,
                 ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts DESC) AS rn
          FROM bin_history WHERE ts >= ?
        ),
        first AS (
          SELECT key, lowest, depth,
                 ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts ASC) AS rn
          FROM bin_history WHERE ts >= ?
        )
        SELECT l.key, f.lowest AS then_price, l.lowest AS now_price, l.depth AS depth,
               (l.lowest - f.lowest) * 100.0 / f.lowest AS pct
        FROM latest l JOIN first f ON f.key = l.key AND f.rn = 1
        WHERE l.rn = 1 AND f.lowest > 100000
          AND l.depth >= 4 AND f.depth >= 4
          AND ABS((l.lowest - f.lowest) * 100.0 / f.lowest) < 300
        ORDER BY ABS(pct) DESC LIMIT 40`, now - back, now - back);
      const volume = store.all(`
        SELECT key, COUNT(*) AS sales, AVG(price) AS avg, SUM(price) AS coins
        FROM sales WHERE ts >= ? GROUP BY key ORDER BY coins DESC LIMIT 40`, now - back);
      return json(res, 200, {
        movers, volume,
        spreads: collector.lastBazaar.orders.slice(0, 40),
        bzMovers: store.bazaarMovers(now - back, 40),
      });
    }

    // --- watchlist ----------------------------------------------------------
    if (p === '/api/watchlist' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let w; try { w = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
        if (!w.key) return json(res, 400, { error: 'key required' });
        store.run(`INSERT OR REPLACE INTO watchlist (key,label,below,above,added_ts) VALUES (?,?,?,?,?)`,
          w.key, w.label || w.key, w.below || null, w.above || null, Date.now());
        collector.refreshWatchlist();
        json(res, 200, { ok: true, watchlist: store.all('SELECT * FROM watchlist ORDER BY added_ts DESC') });
      });
      return;
    }

    if (p === '/api/watchlist' && req.method === 'DELETE') {
      const key = u.searchParams.get('key');
      store.run('DELETE FROM watchlist WHERE key = ?', key);
      collector.refreshWatchlist();
      return json(res, 200, { ok: true, watchlist: store.all('SELECT * FROM watchlist ORDER BY added_ts DESC') });
    }

    if (p === '/api/alerts/seen' && req.method === 'POST') {
      store.run('UPDATE alerts SET seen = 1 WHERE seen = 0');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/purge' && req.method === 'POST') {
      const before = Number(u.searchParams.get('before') || 0);
      if (!before) return json(res, 400, { error: 'before (epoch ms) required' });
      store.purgeBefore(before);
      return json(res, 200, { ok: true, db: store.stats() });
    }

    // --- static -------------------------------------------------------------
    const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const full = path.join(WEB, file);
    if (!full.startsWith(WEB)) return json(res, 403, { error: 'nope' });
    fs.readFile(full, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  return { server, broadcast, clients };
}

module.exports = { createServer, RANGES };
