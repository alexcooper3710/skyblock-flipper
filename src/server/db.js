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
    this.stmt = {
      snapshot: this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?)'),
      bin: this.db.prepare('INSERT OR REPLACE INTO bin_history VALUES (?,?,?,?,?)'),
      sale: this.db.prepare('INSERT OR IGNORE INTO sales VALUES (?,?,?,?)'),
      bz: this.db.prepare('INSERT OR REPLACE INTO bz_history VALUES (?,?,?,?,?,?,?,?)'),
      flip: this.db.prepare(`INSERT OR REPLACE INTO flips
        (uuid,ts,name,key_base,key_variant,price,value,profit,margin,strategy,basis,samples)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      alert: this.db.prepare('INSERT INTO alerts (ts,kind,key,title,detail) VALUES (?,?,?,?,?)'),
    };
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
        this.stmt.bin.run(meta.ts, key, Math.round(arr[0]), arr[1] ? Math.round(arr[1]) : null, arr.length);
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

  stats() {
    const q = (s) => (this.one(s) || {}).n || 0;
    return {
      bytes: this.sizeBytes(),
      snapshots: q('SELECT COUNT(*) n FROM snapshots'),
      binRows: q('SELECT COUNT(*) n FROM bin_history'),
      sales: q('SELECT COUNT(*) n FROM sales'),
      bzRows: q('SELECT COUNT(*) n FROM bz_history'),
      flips: q('SELECT COUNT(*) n FROM flips'),
      oldest: (this.one('SELECT MIN(ts) n FROM snapshots') || {}).n || null,
    };
  }

  purgeBefore(ts) {
    this.tx(() => {
      this.run('DELETE FROM bin_history WHERE ts < ?', ts);
      this.run('DELETE FROM bz_history WHERE ts < ?', ts);
      this.run('DELETE FROM sales WHERE ts < ?', ts);
      this.run('DELETE FROM snapshots WHERE ts < ?', ts);
    });
    this.db.exec('VACUUM');
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { Store };
