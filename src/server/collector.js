'use strict';
// Wires the live engine into storage, and decides what is worth interrupting
// you for. The engine stays ignorant of both.

const { EventEmitter } = require('events');
const { Flipper } = require('../main/engine/poller');

// Rolling baseline per key, so "unusual" means unusual FOR THAT ITEM rather
// than a fixed threshold that only ever fires on expensive things.
class Baseline {
  constructor(window = 60) { this.window = window; this.series = new Map(); }

  push(key, value) {
    let arr = this.series.get(key);
    if (!arr) this.series.set(key, (arr = []));
    arr.push(value);
    if (arr.length > this.window) arr.shift();
  }

  // z-score against the item's own recent history; null until there's enough.
  // A near-static item has an sd close to zero, which turns any blip into a
  // 12-sigma "spike" - live data was full of these (FROGGLES_SILVER read
  // "949.0k vs 949.0k baseline (7.7s)"). Require the spread to be a real
  // fraction of the price, and the move itself to be materially large.
  z(key, value, minSamples = 20, minRelSd = 0.005, minRelMove = 0.15) {
    const arr = this.series.get(key);
    if (!arr || arr.length < minSamples) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    if (mean <= 0) return null;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    const sd = Math.sqrt(variance);
    if (sd <= 0 || sd / mean < minRelSd) return null;
    if (Math.abs(value - mean) / mean < minRelMove) return null;
    return { z: (value - mean) / sd, mean, sd };
  }
}

class Collector extends EventEmitter {
  constructor(cfg, store) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.engine = new Flipper(cfg);
    this.baselineBin = new Baseline(60);
    this.baselineSpread = new Baseline(60);
    this.lastBazaar = { orders: [], crafts: [], at: 0 };
    this.books = new Map();       // live ladders, always current, never stale
    this.depthTick = 0;
    this.lastFlips = [];
    this.lastStats = null;
    this.watch = this.loadWatchlist();
    this.wire();
  }

  loadWatchlist() {
    const rows = this.store.all('SELECT * FROM watchlist');
    return new Map(rows.map(r => [r.key, r]));
  }

  refreshWatchlist() { this.watch = this.loadWatchlist(); return this.watch; }

  wire() {
    const e = this.engine;

    e.on('snapshot', (meta) => { this.pendingMeta = meta; });

    e.on('wall', ({ ts, wall }) => {
      const meta = this.pendingMeta || { ts, totalAuctions: 0, binCount: wall.size, newBins: 0, cycleMs: 0 };
      try { this.store.writeSnapshot({ ...meta, ts }, wall); }
      catch (err) { this.emit('log', { level: 'warn', msg: `snapshot write: ${err.message}` }); }
      this.checkWall(wall);
      this.emit('tick', { ts, keys: wall.size });
    });

    e.on('sales', (rows) => {
      try { this.store.writeSales(rows); }
      catch (err) { this.emit('log', { level: 'warn', msg: `sales write: ${err.message}` }); }
    });

    e.on('bazaar', (b) => {
      this.lastBazaar = { orders: b.orders, crafts: b.crafts, at: b.at };
      this.books = b.books;
      try {
        this.store.writeBazaar(b.at, b.books);
        // Top-of-book every minute; the full ladder every fifth, or depth
        // history alone would be gigabytes a day.
        if (this.depthTick++ % (this.cfg.depthEveryNPolls || 5) === 0) {
          this.store.writeDepth(b.at, b.books);
        }
      } catch (err) { this.emit('log', { level: 'warn', msg: `bazaar write: ${err.message}` }); }
      this.checkBazaar(b);
      this.emit('bazaar', this.lastBazaar);
    });

    e.on('flips', (flips) => {
      try { this.store.writeFlips(flips); } catch { /* logging only */ }
      this.lastFlips = [...flips, ...this.lastFlips].slice(0, 300);
      for (const f of flips) {
        if (f.profit >= this.cfg.alerts.flipProfit) {
          this.raise('flip', f.keyBase, `${f.name}  +${fmt(f.profit)}`,
            `buy ${fmt(f.price)} / worth ${fmt(f.value)} · ${f.marginPct}% · ${f.strategy}`);
        }
      }
      this.emit('flips', flips);
    });

    e.on('stats', (s) => { this.lastStats = s; this.emit('stats', s); });
    e.on('log', (l) => this.emit('log', l));
  }

  // --- alert rules ----------------------------------------------------------
  checkWall(wall) {
    for (const [key, arr] of wall) {
      const price = arr[0];
      const w = this.watch.get(key);
      if (w) {
        if (w.below && price <= w.below) {
          this.raise('watch', key, `${w.label || key} at or below ${fmt(w.below)}`, `now ${fmt(price)}`);
        }
        if (w.above && price >= w.above) {
          this.raise('watch', key, `${w.label || key} at or above ${fmt(w.above)}`, `now ${fmt(price)}`);
        }
      }
      if (this.cfg.alerts.unusual) {
        const stat = this.baselineBin.z(key, price);
        // Only shout about a big move on something with a real market behind it.
        // arr is the BIN wall; depth < 4 means the "move" is usually just the
        // cheapest listing selling, not the item repricing.
        if (stat && Math.abs(stat.z) >= this.cfg.alerts.unusualZ && arr.length >= 4) {
          const dir = stat.z < 0 ? 'dumped' : 'spiked';
          this.raise('unusual', key, `${key} ${dir}`,
            `${fmt(price)} vs ${fmt(stat.mean)} baseline (${stat.z.toFixed(1)}σ)`);
        }
      }
      this.baselineBin.push(key, price);
    }
  }

  checkBazaar(b) {
    // watchlist first - a bazaar item never touches the BIN wall, so without
    // this a watch on ENCHANTED_DIAMOND could never fire.
    for (const [product, t] of b.books) {
      const w = this.watch.get(product);
      if (!w) continue;
      const price = t.sellOrder || t.instantSell;
      if (!price) continue;
      if (w.below && price <= w.below) {
        this.raise('watch', product, `${w.label || product} at or below ${fmt(w.below)}`, `bazaar ${fmt(price)}`);
      }
      if (w.above && price >= w.above) {
        this.raise('watch', product, `${w.label || product} at or above ${fmt(w.above)}`, `bazaar ${fmt(price)}`);
      }
    }
    if (!this.cfg.alerts.unusual) return;
    for (const o of b.orders) {
      const stat = this.baselineSpread.z(o.id, o.spreadPct);
      if (stat && stat.z >= this.cfg.alerts.unusualZ) {
        this.raise('unusual', o.id, `${o.id} spread widened`,
          `${o.spreadPct}% vs ${stat.mean.toFixed(1)}% baseline (${stat.z.toFixed(1)}σ)`);
      }
      this.baselineSpread.push(o.id, o.spreadPct);
    }
  }

  // One alert per key per cooldown, or a crashing item screams every minute.
  raise(kind, key, title, detail) {
    const now = Date.now();
    this.cooldown = this.cooldown || new Map();
    const id = `${kind}:${key}`;
    if (now - (this.cooldown.get(id) || 0) < this.cfg.alerts.cooldownMs) return;
    this.cooldown.set(id, now);
    try { this.store.addAlert(kind, key, title, detail); } catch { /* non-fatal */ }
    this.emit('alert', { kind, key, title, detail, ts: now });
  }

  start() { return this.engine.start(); }
  stop() { this.engine.stop(); }
}

function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

module.exports = { Collector, Baseline, fmt };
