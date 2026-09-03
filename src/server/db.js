'use strict';
// Storage. Uses node:sqlite, which ships inside Node 22.5+ - no native build,
// no postinstall download, nothing that can silently fail to install.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- one row per auction snapshot we successfully processed
CREATE TABLE IF NOT EXISTS snapshots (
  ts            INTEGER PRIMARY KEY,   -- hypixel's lastUpdated, ms
  total_auctions INTEGER NOT NULL,
  bin_count     INTEGER NOT NULL,
  new_bins      INTEGER NOT NULL,
  cycle_ms      INTEGER NOT NULL
);

-- the BIN wall per item, per snapshot. This is the AH price history.
CREATE TABLE IF NOT EXISTS bin_history (
  ts      INTEGER NOT NULL,
  key     TEXT    NOT NULL,
  lowest  INTEGER NOT NULL,
  second  INTEGER,
  depth   INTEGER NOT NULL,
  wall    TEXT,                      -- the actual asking prices, comma separated
  PRIMARY KEY (key, ts)
) WITHOUT ROWID;

-- every sale we saw on auctions_ended. What things actually went for.
CREATE TABLE IF NOT EXISTS sales (
  auction_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  price      INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (auction_id, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_sales_key_ts ON sales(key, ts);

-- bazaar order book snapshots
CREATE TABLE IF NOT EXISTS bz_history (
  ts            INTEGER NOT NULL,
  product       TEXT    NOT NULL,
  buy_order     REAL    NOT NULL,   -- top of buy book (what you'd offer)
  sell_order    REAL    NOT NULL,   -- top of sell book (what you'd list at)
  instant_buy   REAL,
  instant_sell  REAL,
  buy_vol_week  INTEGER,
  sell_vol_week INTEGER,
  PRIMARY KEY (product, ts)
) WITHOUT ROWID;

-- The order book itself, sampled. One row per product per sample holds both
-- ladders as "price:amount:orders|..." so depth history costs one row, not
-- forty-five.
CREATE TABLE IF NOT EXISTS bz_depth (
  ts      INTEGER NOT NULL,
  product TEXT    NOT NULL,
  bids    TEXT    NOT NULL,
  asks    TEXT    NOT NULL,
  PRIMARY KEY (product, ts)
) WITHOUT ROWID;

-- every flip the engine surfaced, so you can audit what it told you
CREATE TABLE IF NOT EXISTS flips (
  uuid      TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  name      TEXT, key_base TEXT, key_variant TEXT,
  price     INTEGER, value INTEGER, profit INTEGER, margin REAL,
  strategy  TEXT, basis TEXT, samples INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flips_ts ON flips(ts);

CREATE TABLE IF NOT EXISTS watchlist (
  key       TEXT PRIMARY KEY,
  label     TEXT,
  below     INTEGER,
  above     INTEGER,
  added_ts  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT NOT NULL,      -- flip | watch | unusual
  key    TEXT,
  title  TEXT NOT NULL,
  detail TEXT,
  seen   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
`;

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
    this.stmt = {
      snapshot: this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?)'),
      bin: this.db.prepare('INSERT OR REPLACE INTO bin_history VALUES (?,?,?,?,?,?)'),
      sale: this.db.prepare('INSERT OR IGNORE INTO sales VALUES (?,?,?,?)'),
      bz: this.db.prepare('INSERT OR REPLACE INTO bz_history VALUES (?,?,?,?,?,?,?,?)'),
      depth: this.db.prepare('INSERT OR REPLACE INTO bz_depth VALUES (?,?,?,?)'),
      flip: this.db.prepare(`INSERT OR REPLACE INTO flips
        (uuid,ts,name,key_base,key_variant,price,value,profit,margin,strategy,basis,samples)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      alert: this.db.prepare('INSERT INTO alerts (ts,kind,key,title,detail) VALUES (?,?,?,?,?)'),
    };
  }

  // buy_order/sell_order were written inverted until the bid/ask fix, so every
  // stored bazaar row has the two columns the wrong way round. Swap them once.
  migrate() {
    const v = this.one('PRAGMA user_version');
    const cur = v ? Object.values(v)[0] : 0;
    if (cur >= 1) return;
    const n = this.one('SELECT COUNT(*) AS n FROM bz_history');
    if (n && n.n) {
      this.db.exec(`
        UPDATE bz_history
        SET buy_order = sell_order, sell_order = buy_order
        WHERE sell_order < buy_order`);
    }
    this.db.exec('PRAGMA user_version = 1');
    this.addColumnIfMissing('bin_history', 'wall', 'TEXT');
  }

  addColumnIfMissing(table, column, type) {
    const cols = this.all(`PRAGMA table_info(${table})`);
    if (cols.some(c => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // --- writes ---------------------------------------------------------------
  writeSnapshot(meta, wall) {
    this.tx(() => {
      this.stmt.snapshot.run(meta.ts, meta.totalAuctions, meta.binCount, meta.newBins, meta.cycleMs);
      for (const [key, arr] of wall) {
        this.stmt.bin.run(meta.ts, key, Math.round(arr[0]), arr[1] ? Math.round(arr[1]) : null,
          arr.length, arr.map(p => Math.round(p)).join(','));
      }
    });
  }

  writeSales(rows) {
    if (!rows.length) return;
    this.tx(() => { for (const r of rows) this.stmt.sale.run(r.auctionId, r.key, Math.round(r.price), r.at); });
  }

  writeBazaar(ts, books) {
    this.tx(() => {
      for (const [product, t] of books) {
        this.stmt.bz.run(ts, product, t.buyOrder, t.sellOrder, t.instantBuy, t.instantSell, t.buyVolWeek, t.sellVolWeek);
      }
    });
  }

  // The full ladder every minute for 2000 products would be gigabytes a day, so
  // top-of-book stays per-minute and the ladder is sampled less often.
  writeDepth(ts, books) {
    const enc = (rows) => (rows || []).map(l => `${l.price}:${l.amount}:${l.orders}`).join('|');
    this.tx(() => {
      for (const [product, t] of books) {
        if (!t.bids || !t.asks) continue;
        this.stmt.depth.run(ts, product, enc(t.bids), enc(t.asks));
      }
    });
  }

  depthAt(product, ts) {
    const row = ts
      ? this.one('SELECT * FROM bz_depth WHERE product = ? AND ts <= ? ORDER BY ts DESC LIMIT 1', product, ts)
      : this.one('SELECT * FROM bz_depth WHERE product = ? ORDER BY ts DESC LIMIT 1', product);
    if (!row) return null;
    const dec = (s) => (s ? s.split('|').filter(Boolean).map(x => {
      const [price, amount, orders] = x.split(':').map(Number);
      return { price, amount, orders };
    }) : []);
    return { ts: row.ts, bids: dec(row.bids), asks: dec(row.asks) };
  }

  // How the wall thickened or thinned over time - depth history in coins, not counts.
  depthHistory(product, sinceMs, limit = 240) {
    const rows = this.all('SELECT ts, bids, asks FROM bz_depth WHERE product = ? AND ts >= ? ORDER BY ts DESC LIMIT ?',
      product, sinceMs, limit);
    const sum = (s) => (s || '').split('|').filter(Boolean)
      .reduce((a, x) => { const p = x.split(':'); return a + Number(p[0]) * Number(p[1]); }, 0);
    return rows.reverse().map(r => ({ t: r.ts, bidCoins: sum(r.bids), askCoins: sum(r.asks) }));
  }

  binWall(key) {
    const row = this.one('SELECT ts, wall, depth FROM bin_history WHERE key = ? ORDER BY ts DESC LIMIT 1', key);
    if (!row || !row.wall) return null;
    return { ts: row.ts, depth: row.depth, prices: row.wall.split(',').map(Number) };
  }

  writeFlips(flips) {
    if (!flips.length) return;
    this.tx(() => {
      for (const f of flips) {
        this.stmt.flip.run(f.uuid, f.seenAt, f.name, f.keyBase, f.keyVariant,
          f.price, f.value, f.profit, f.marginPct, f.strategy, f.basis, f.samples);
      }
    });
  }

  addAlert(kind, key, title, detail) {
    this.stmt.alert.run(Date.now(), kind, key || null, title, detail || null);
  }

  // --- reads ----------------------------------------------------------------
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  // Bucketed so a year of minutes doesn't try to render as a million points.
  priceHistory(key, sinceMs, bucketMs) {
    return this.all(`
      SELECT (ts / ?) * ? AS t,
             MIN(lowest) AS low, MAX(lowest) AS high,
             AVG(lowest)  AS avg, AVG(depth) AS depth
      FROM bin_history WHERE key = ? AND ts >= ?
      GROUP BY t ORDER BY t`, bucketMs, bucketMs, key, sinceMs);
  }

  salesHistory(key, sinceMs, bucketMs) {
    return this.all(`
      SELECT (ts / ?) * ? AS t, COUNT(*) AS n,
             AVG(price) AS avg, MIN(price) AS low, MAX(price) AS high
      FROM sales WHERE key = ? AND ts >= ?
      GROUP BY t ORDER BY t`, bucketMs, bucketMs, key, sinceMs);
  }

  bzHistory(product, sinceMs, bucketMs) {
    return this.all(`
      SELECT (ts / ?) * ? AS t, AVG(buy_order) AS buy, AVG(sell_order) AS sell,
             AVG(sell_vol_week) AS vol
      FROM bz_history WHERE product = ? AND ts >= ?
      GROUP BY t ORDER BY t`, bucketMs, bucketMs, product, sinceMs);
  }

  sizeBytes() {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { total += fs.statSync(this.file + suffix).size; } catch { /* not present */ }
    }
    return total;
  }

  // --- bazaar reads ---------------------------------------------------------
  // bz_history was being written every minute and almost never read. These are
  // what make the bazaar a first-class side of the terminal rather than a feed.

  bazaarLatest(product) {
    return this.one('SELECT * FROM bz_history WHERE product = ? ORDER BY ts DESC LIMIT 1', product);
  }

  // Most recent row per product, for browsing the whole book.
  bazaarBook(q, limit = 300) {
    const like = q ? `%${q.toUpperCase()}%` : '%';
    return this.all(`
      SELECT b.* FROM bz_history b
      JOIN (SELECT product, MAX(ts) AS ts FROM bz_history GROUP BY product) m
        ON m.product = b.product AND m.ts = b.ts
      WHERE b.product LIKE ?
      ORDER BY b.sell_vol_week DESC LIMIT ?`, like, limit);
  }

  bazaarMovers(sinceMs, limit = 40) {
    return this.all(`
      WITH latest AS (
        SELECT product, sell_order, buy_order,
               ROW_NUMBER() OVER (PARTITION BY product ORDER BY ts DESC) AS rn
        FROM bz_history WHERE ts >= ?
      ),
      first AS (
        SELECT product, sell_order,
               ROW_NUMBER() OVER (PARTITION BY product ORDER BY ts ASC) AS rn
        FROM bz_history WHERE ts >= ?
      )
      SELECT l.product, f.sell_order AS then_price, l.sell_order AS now_price,
             l.buy_order,
             (l.sell_order - f.sell_order) * 100.0 / f.sell_order AS pct
      FROM latest l JOIN first f ON f.product = l.product AND f.rn = 1
      WHERE l.rn = 1 AND f.sell_order > 0
      ORDER BY ABS(pct) DESC LIMIT ?`, sinceMs, sinceMs, limit);
  }

  searchAll(q, limit = 40) {
    const like = `%${q.toUpperCase()}%`;
    const ah = this.all(`
      SELECT key AS id, 'ah' AS kind, COUNT(*) AS n FROM bin_history
      WHERE key LIKE ? GROUP BY key ORDER BY n DESC LIMIT ?`, like, limit);
    const bz = this.all(`
      SELECT product AS id, 'bz' AS kind, COUNT(*) AS n FROM bz_history
      WHERE product LIKE ? GROUP BY product ORDER BY n DESC LIMIT ?`, like, limit);
    // an item can legitimately be both; show it once, tagged with both markets
    const seen = new Map();
    for (const r of [...bz, ...ah]) {
      const prev = seen.get(r.id);
      if (prev) prev.kind = 'both';
      else seen.set(r.id, { ...r });
    }
    return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  }

  stats() {
    const q = (s) => (this.one(s) || {}).n || 0;
    return {
      bytes: this.sizeBytes(),
      snapshots: q('SELECT COUNT(*) n FROM snapshots'),
      binRows: q('SELECT COUNT(*) n FROM bin_history'),
      sales: q('SELECT COUNT(*) n FROM sales'),
      bzRows: q('SELECT COUNT(*) n FROM bz_history'),
      depthRows: q('SELECT COUNT(*) n FROM bz_depth'),
      flips: q('SELECT COUNT(*) n FROM flips'),
      oldest: (this.one('SELECT MIN(ts) n FROM snapshots') || {}).n || null,
    };
  }

  purgeBefore(ts) {
    this.tx(() => {
      this.run('DELETE FROM bin_history WHERE ts < ?', ts);
      this.run('DELETE FROM bz_history WHERE ts < ?', ts);
      this.run('DELETE FROM bz_depth WHERE ts < ?', ts);
      this.run('DELETE FROM sales WHERE ts < ?', ts);
      this.run('DELETE FROM snapshots WHERE ts < ?', ts);
    });
    this.db.exec('VACUUM');
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { Store };
