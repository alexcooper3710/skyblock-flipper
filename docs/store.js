// IndexedDB store. Same shape as the SQLite one on the server, minus SQL.
// Everything lives in this browser: nothing is uploaded, and GitHub Pages only
// ever serves the static files.
const DB = 'skyblock-terminal';
const VERSION = 1;

export function open() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB, VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      db.createObjectStore('bin', { keyPath: ['key', 'ts'] });
      db.createObjectStore('sales', { keyPath: 'auctionId' }).createIndex('byKeyTs', ['key', 'ts']);
      db.createObjectStore('bz', { keyPath: ['product', 'ts'] });
      db.createObjectStore('depth', { keyPath: ['product', 'ts'] });
      db.createObjectStore('flips', { keyPath: 'uuid' }).createIndex('byTs', 'ts');
      db.createObjectStore('watchlist', { keyPath: 'key' });
      db.createObjectStore('alerts', { keyPath: 'id', autoIncrement: true }).createIndex('byTs', 'ts');
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

const tx = (db, names, mode) => db.transaction(names, mode);
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class Store {
  constructor(db) { this.db = db; }
  static async create() { return new Store(await open()); }

  async putMany(name, rows) {
    if (!rows.length) return;
    const t = tx(this.db, [name], 'readwrite');
    const os = t.objectStore(name);
    for (const r of rows) os.put(r);
    await done(t);
  }

  async writeSnapshot(meta, wall) {
    const rows = [];
    for (const [key, arr] of wall) {
      rows.push({ key, ts: meta.ts, lowest: Math.round(arr[0]), second: arr[1] ? Math.round(arr[1]) : null,
        depth: arr.length, wall: arr.map(p => Math.round(p)) });
    }
    await this.putMany('bin', rows);
    await this.putMany('meta', [{ k: 'lastSnapshot', v: meta }]);
  }

  writeSales(rows) {
    return this.putMany('sales', rows.map(r => ({ auctionId: r.auctionId, key: r.key, price: Math.round(r.price), ts: r.at })));
  }

  writeBazaar(ts, books) {
    const rows = [];
    for (const [product, t] of books) {
      rows.push({ product, ts, buy_order: t.buyOrder, sell_order: t.sellOrder,
        instant_buy: t.instantBuy, instant_sell: t.instantSell,
        buy_vol_week: t.buyVolWeek, sell_vol_week: t.sellVolWeek });
    }
    return this.putMany('bz', rows);
  }

  writeDepth(ts, books) {
    const rows = [];
    for (const [product, t] of books) {
      if (t.bids && t.asks) rows.push({ product, ts, bids: t.bids, asks: t.asks });
    }
    return this.putMany('depth', rows);
  }

  writeFlips(flips) { return this.putMany('flips', flips.map(f => ({ ...f, ts: f.seenAt }))); }
  addAlert(a) { return this.putMany('alerts', [{ ...a, ts: a.ts || Date.now(), seen: 0 }]); }

  // range scan over a compound [key, ts] store
  async range(name, key, sinceMs, indexName) {
    const t = tx(this.db, [name], 'readonly');
    const src = indexName ? t.objectStore(name).index(indexName) : t.objectStore(name);
    const kr = IDBKeyRange.bound([key, sinceMs], [key, Infinity]);
    const out = [];
    await new Promise((res, rej) => {
      const c = src.openCursor(kr);
      c.onsuccess = () => { const cur = c.result; if (!cur) return res(); out.push(cur.value); cur.continue(); };
      c.onerror = () => rej(c.error);
    });
    return out;
  }

  async all(name, limit = Infinity, indexName, direction = 'next') {
    const t = tx(this.db, [name], 'readonly');
    const src = indexName ? t.objectStore(name).index(indexName) : t.objectStore(name);
    const out = [];
    await new Promise((res, rej) => {
      const c = src.openCursor(null, direction);
      c.onsuccess = () => { const cur = c.result; if (!cur || out.length >= limit) return res(); out.push(cur.value); cur.continue(); };
      c.onerror = () => rej(c.error);
    });
    return out;
  }

  get(name, key) { return req(tx(this.db, [name], 'readonly').objectStore(name).get(key)); }
  del(name, key) { const t = tx(this.db, [name], 'readwrite'); t.objectStore(name).delete(key); return done(t); }
  count(name) { return req(tx(this.db, [name], 'readonly').objectStore(name).count()); }

  // group a series into time buckets, the same way the SQL build does it
  static bucket(rows, bucketMs, valueOf) {
    const map = new Map();
    for (const r of rows) {
      const t = Math.floor(r.ts / bucketMs) * bucketMs;
      let b = map.get(t);
      if (!b) map.set(t, (b = { t, n: 0, sum: 0, low: Infinity, high: -Infinity }));
      const v = valueOf(r);
      b.n++; b.sum += v; b.low = Math.min(b.low, v); b.high = Math.max(b.high, v);
    }
    return [...map.values()].sort((a, b) => a.t - b.t)
      .map(b => ({ t: b.t, n: b.n, avg: b.sum / b.n, low: b.low, high: b.high }));
  }

  async stats() {
    const [bin, sales, bz, depth, flips] = await Promise.all(
      ['bin', 'sales', 'bz', 'depth', 'flips'].map(n => this.count(n)));
    let bytes = 0;
    try { const e = await navigator.storage.estimate(); bytes = e.usage || 0; } catch { /* not supported */ }
    return { bytes, binRows: bin, sales, bzRows: bz, depthRows: depth, flips, snapshots: 0, oldest: null };
  }

  async exportAll() {
    const out = {};
    for (const n of ['bin', 'sales', 'bz', 'depth', 'flips', 'watchlist', 'alerts']) out[n] = await this.all(n);
    return out;
  }

  async importAll(data) {
    for (const n of Object.keys(data)) {
      if (!Array.isArray(data[n])) continue;
      await this.putMany(n, data[n]);
    }
  }
}
