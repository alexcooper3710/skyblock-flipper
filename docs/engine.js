// The whole terminal, running in the tab. Same snapshot-boundary logic as the
// server build; the shared modules under ./shared are generated from the same
// sources, so pricing and strategy behaviour cannot drift between the two.
import { decodeItemBytes } from './nbt.js';
import { readItem, pricingKeys } from './shared/itemkeys.js';
import { PriceBook } from './shared/pricing.js';
import { evaluate } from './shared/strategies.js';
import { orderFlips, craftFlips, topOfBook } from './shared/bazaar.js';
import { Store } from './store.js';

const BASE = 'https://api.hypixel.net/v2';
const SNAPSHOT_MS = 60000, LEAD_MS = 800, PROBE_MS = 250, MAX_PROBE_MS = 20000;

export const CONFIG = {
  maxBudget: 200000000, minProfit: 1000000, minMarginPct: 8, minSampleSize: 3,
  soldWindowMinutes: 45, pageConcurrency: 8,
  strategies: { lowestBinSnipe: true, soldMedian: true, attributeAware: true, bazaarAndCraft: true },
  bazaar: { minWeeklyVolume: 200000, minSpreadPct: 6, minProfitPerFlip: 100000, taxPct: 1.25 },
  alerts: { flipProfit: 2000000, unusual: true, unusualZ: 4, cooldownMs: 900000 },
  blacklistIds: ['SKYBLOCK_MENU'], apiKey: '',
};

async function getJson(path) {
  const headers = CONFIG.apiKey ? { 'API-Key': CONFIG.apiKey } : {};
  const r = await fetch(BASE + path, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
  return r.json();
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

export class Engine extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.book = new PriceBook(CONFIG);
    this.keyCache = new Map();
    this.knownUuids = new Set();
    this.lastUpdated = 0;
    this.warmedUp = false;
    this.running = false;
    this.books = new Map();
    this.depthTick = 0;
    this.cooldown = new Map();
    this.stats = { snapshots: 0, flips: 0, lastCycleMs: 0, decodes: 0, totalAuctions: 0 };
    this.recentFlips = [];
    this.lastBazaar = { orders: [], crafts: [], at: 0 };
    this.watch = new Map();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(level, msg) { this.emit('log', { level, msg, at: Date.now() }); }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadWatchlist();
    this.loopAuctions(); this.loopSold(); this.loopBazaar();
  }
  stop() { this.running = false; }

  async loadWatchlist() {
    const rows = await this.store.all('watchlist');
    this.watch = new Map(rows.map(r => [r.key, r]));
    return rows;
  }

  async waitForFresh() {
    let head = await getJson('/skyblock/auctions?page=0');
    if (head.lastUpdated !== this.lastUpdated) return head;
    const wait = head.lastUpdated + SNAPSHOT_MS - LEAD_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    const deadline = Date.now() + MAX_PROBE_MS;
    while (this.running && Date.now() < deadline) {
      head = await getJson('/skyblock/auctions?page=0');
      if (head.lastUpdated !== this.lastUpdated) return head;
      await this.sleep(PROBE_MS);
    }
    return null;
  }

  async loopAuctions() {
    while (this.running) {
      try {
        const head = await this.waitForFresh();
        if (!head) { await this.sleep(2000); continue; }
        const t0 = Date.now();
        const pages = await mapPool(
          Array.from({ length: head.totalPages }, (_, i) => i), CONFIG.pageConcurrency,
          async (page) => { try { return (await getJson(`/skyblock/auctions?page=${page}`)).auctions || []; } catch { return []; } });
        await this.processSnapshot(pages.flat(), head.lastUpdated);
        this.stats.lastCycleMs = Date.now() - t0;
        this.emit('stats', { ...this.stats, book: this.book.stats(), warmedUp: this.warmedUp });
      } catch (e) {
        this.log('error', `auction loop: ${e.message}`);
        await this.sleep(3000);
      }
    }
  }

  async processSnapshot(auctions, lastUpdated) {
    this.lastUpdated = lastUpdated;
    this.stats.snapshots++;
    this.stats.totalAuctions = auctions.length;
    const bins = auctions.filter(a => a.bin);
    const need = bins.filter(a => !this.keyCache.has(a.uuid));

    await mapPool(need, 12, async (a) => {
      try {
        const item = readItem(await decodeItemBytes(a.item_bytes));
        const keys = pricingKeys(item);
        if (keys) this.keyCache.set(a.uuid, { keys, item });
        this.stats.decodes++;
      } catch { /* one bad item must not sink the snapshot */ }
    });

    const entries = [];
    for (const a of bins) {
      const c = this.keyCache.get(a.uuid);
      if (c) entries.push({ bin: true, price: a.starting_bid, keys: c.keys });
    }
    this.book.rebuildBinWall(entries);
    await this.store.writeSnapshot({ ts: lastUpdated, totalAuctions: auctions.length, binCount: bins.length },
      this.book.lowestBin);
    this.checkWall(this.book.lowestBin);

    const fresh = [];
    if (this.knownUuids.size) for (const a of bins) if (!this.knownUuids.has(a.uuid)) fresh.push(a);
    this.knownUuids = new Set(bins.map(a => a.uuid));
    if (this.keyCache.size > 120000) for (const k of this.keyCache.keys()) if (!this.knownUuids.has(k)) this.keyCache.delete(k);

    if (!this.warmedUp) {
      this.warmedUp = true;
      this.log('info', `baseline built: ${bins.length} BINs across ${auctions.length} auctions`);
      return;
    }

    const flips = [];
    for (const a of fresh) {
      const c = this.keyCache.get(a.uuid);
      if (!c || CONFIG.blacklistIds.includes(c.item.id)) continue;
      const flip = evaluate({ auction: a, item: c.item, keys: c.keys, book: this.book, cfg: CONFIG });
      if (flip) flips.push(flip);
    }
    flips.sort((a, b) => b.profit - a.profit);
    this.stats.flips += flips.length;
    this.log('info', `snapshot +${fresh.length} new BINs -> ${flips.length} flips`);
    if (flips.length) {
      this.recentFlips = [...flips, ...this.recentFlips].slice(0, 300);
      await this.store.writeFlips(flips);
      for (const f of flips) {
        if (f.profit >= CONFIG.alerts.flipProfit) {
          this.raise('flip', f.keyBase, `${f.name}  +${Math.round(f.profit / 1e6)}m`,
            `buy ${f.price} / worth ${f.value} · ${f.marginPct}% · ${f.strategy}`);
        }
      }
      this.emit('flips', flips);
    }
  }

  async loopSold() {
    while (this.running) {
      try {
        const body = await getJson('/skyblock/auctions_ended');
        const rows = (await mapPool(body.auctions || [], 12, async (s) => {
          try {
            const keys = pricingKeys(readItem(await decodeItemBytes(s.item_bytes)));
            if (!keys) return null;
            return [...new Set([keys.variant, keys.base].filter(Boolean))]
              .map(k => ({ key: k, price: s.price, at: s.timestamp, auctionId: `${s.auction_id}:${k}` }));
          } catch { return null; }
        })).filter(Boolean).flat();
        this.book.addSales(rows);
        if (rows.length) await this.store.writeSales(rows);
      } catch (e) { this.log('warn', `sold feed: ${e.message}`); }
      await this.sleep(20000);
    }
  }

  async loopBazaar() {
    while (this.running) {
      try {
        const body = await getJson('/skyblock/bazaar');
        const books = new Map();
        for (const [id, product] of Object.entries(body.products)) books.set(id, topOfBook(product));
        this.books = books;
        this.lastBazaar = {
          orders: orderFlips(body.products, CONFIG).slice(0, 60),
          crafts: craftFlips(body.products, CONFIG).slice(0, 60),
          at: Date.now(),
        };
        await this.store.writeBazaar(this.lastBazaar.at, books);
        if (this.depthTick++ % 5 === 0) await this.store.writeDepth(this.lastBazaar.at, books);
        this.checkBazaarWatch(books);
        this.emit('bazaar', this.lastBazaar);
      } catch (e) { this.log('warn', `bazaar: ${e.message}`); }
      await this.sleep(60000);
    }
  }

  checkWall(wall) {
    for (const [key, arr] of wall) {
      const w = this.watch.get(key);
      if (!w) continue;
      const price = arr[0];
      if (w.below && price <= w.below) this.raise('watch', key, `${w.label || key} at or below ${w.below}`, `now ${price}`);
      if (w.above && price >= w.above) this.raise('watch', key, `${w.label || key} at or above ${w.above}`, `now ${price}`);
    }
  }

  checkBazaarWatch(books) {
    for (const [product, t] of books) {
      const w = this.watch.get(product);
      if (!w) continue;
      const price = t.sellOrder || t.instantSell;
      if (!price) continue;
      if (w.below && price <= w.below) this.raise('watch', product, `${w.label || product} at or below ${w.below}`, `bazaar ${price}`);
      if (w.above && price >= w.above) this.raise('watch', product, `${w.label || product} at or above ${w.above}`, `bazaar ${price}`);
    }
  }

  raise(kind, key, title, detail) {
    const now = Date.now();
    const id = `${kind}:${key}`;
    if (now - (this.cooldown.get(id) || 0) < CONFIG.alerts.cooldownMs) return;
    this.cooldown.set(id, now);
    const a = { kind, key, title, detail, ts: now };
    this.store.addAlert(a);
    this.emit('alert', a);
  }
}
