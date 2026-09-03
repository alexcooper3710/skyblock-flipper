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

// Where the collector publishes. .github/workflows/market.yml runs the same
// engine modules on a schedule and force-pushes the result to an orphan
// `market-data` branch; raw.githubusercontent.com serves it with
// access-control-allow-origin: *, so the tab can read it cross-origin.
// Reading the owner and repo out of the Pages URL means a fork gets its own
// data with nothing to configure.
function seedBase() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -('.github.io'.length));
    const first = location.pathname.split('/').filter(Boolean)[0];
    // user.github.io/repo/  -> project page.  user.github.io/  -> user page.
    const repo = first && !first.includes('.') ? first : `${owner}.github.io`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/market-data/`;
  }
  return 'https://raw.githubusercontent.com/alexcooper3710/skyblock-flipper/market-data/';
}
const SEED_BASE = seedBase();

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
    this.stats = { snapshots: 0, flips: 0, lastCycleMs: 0, decodes: 0, totalAuctions: 0, boardSize: 0 };
    this.recentFlips = [];
    this.flipFirstSeen = new Map();   // uuid -> when this board first showed it
    this.startedAt = Date.now();
    this.seedMeta = null;
    this.lastBazaar = { orders: [], crafts: [], at: 0 };
    this.watch = new Map();
  }

  // What the UI should tell the user right now. A blank panel with no
  // explanation is the single worst state this thing can be in.
  phase() {
    if (!this.running) return { code: 'stopped', label: 'stopped' };
    if (this.stats.snapshots === 0) {
      const s = Math.round((Date.now() - this.startedAt) / 1000);
      const m = this.seedMeta;
      if (m && !m.error) {
        return { code: 'seed', elapsed: s, ageMin: m.ageMin,
          label: `showing the ${m.ageMin < 1 ? 'latest' : m.ageMin + 'm old'} collector snapshot · live snapshot in progress ${s}s` };
      }
      return { code: 'first-snapshot', label: `pulling the first auction snapshot… ${s}s`, elapsed: s };
    }
    return { code: 'live', label: 'live', elapsed: 0 };
  }

  // Pull the last collector snapshot before doing anything else. It is a real
  // market computed a few minutes ago, which beats an empty screen for the
  // thirty to sixty seconds the first live snapshot takes to arrive.
  async loadSeed() {
    const grab = async (name) => {
      const r = await fetch(SEED_BASE + name + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${name}`);
      return r.json();
    };
    try {
      const [meta, ah, bz] = await Promise.all([grab('meta.json'), grab('ah.json'), grab('bazaar.json')]);
      const ageMin = Math.round((Date.now() - meta.ts) / 60000);
      this.seedMeta = { ...meta, ageMin };

      if (bz && bz.products) {
        const books = new Map();
        for (const [id, p] of Object.entries(bz.products)) {
          books.set(id, {
            asks: (p.asks || []).map(([price, amount, orders]) => ({ price, amount, orders })),
            bids: (p.bids || []).map(([price, amount, orders]) => ({ price, amount, orders })),
            buyOrder: p.b, sellOrder: p.s, instantBuy: p.ib, instantSell: p.is,
            buyVolWeek: p.bv, sellVolWeek: p.sv,
          });
        }
        this.books = books;
        this.lastBazaar = { orders: bz.orders || [], crafts: bz.crafts || [], at: bz.ts, seed: true };
        this.emit('bazaar', this.lastBazaar);
      }

      if (ah) {
        const wallKeys = this.book.seedWall(ah.wall);
        const soldKeys = this.book.seedSold(ah.sold, meta.ts);
        this.recentFlips = (ah.flips || []).map(f => ({ ...f, seed: true, isNew: false }));
        this.stats.boardSize = this.recentFlips.length;
        this.emit('flips', this.recentFlips);
        this.log('info', `seeded from the collector: ${this.recentFlips.length} flips, ${wallKeys} wall keys, ${soldKeys} sold keys (${ageMin}m old)`);
      }
      this.emit('stats', { ...this.stats, book: this.book.stats(), warmedUp: this.warmedUp, phase: this.phase() });
      return true;
    } catch (e) {
      // Not fatal, ever. No seed just means the cold start it always had.
      this.seedMeta = { error: String(e && e.message || e) };
      this.log('warn', `no collector snapshot available (${this.seedMeta.error}) - starting cold`);
      return false;
    }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(level, msg) { this.emit('log', { level, msg, at: Date.now() }); }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadWatchlist();
    // Paint from the collector snapshot first, then start the live loops. They
    // overwrite it as their own data lands, so this is seed -> live rather than
    // blank -> live.
    await this.loadSeed();
    this.loopAuctions(); this.loopSold(); this.loopBazaar();
    const beat = setInterval(() => {
      if (!this.running || this.stats.snapshots > 0) return clearInterval(beat);
      this.emit('stats', { ...this.stats, book: this.book.stats(), warmedUp: this.warmedUp, phase: this.phase() });
    }, 1000);
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
        this.emit('stats', { ...this.stats, book: this.book.stats(), warmedUp: this.warmedUp, phase: this.phase() });
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
    }

    // Scan the WHOLE wall, not only listings that appeared since last snapshot.
    // A listing sitting 40% under the wall is a flip whether it was posted ten
    // seconds ago or ten minutes ago, and every strategy here prices against
    // the wall or the sold feed - neither of which needs the listing to be new.
    // Scanning only `fresh` is what made the first minute of every session show
    // an empty panel: there is no `fresh` until snapshot 2 exists to diff.
    const freshSet = new Set(fresh.map(a => a.uuid));
    const board = [];
    const seenNow = new Set();
    for (const a of bins) {
      const c = this.keyCache.get(a.uuid);
      if (!c || CONFIG.blacklistIds.includes(c.item.id)) continue;
      const flip = evaluate({ auction: a, item: c.item, keys: c.keys, book: this.book, cfg: CONFIG });
      if (!flip) continue;
      // Keep the age honest across rescans: a flip re-seen on the next snapshot
      // is not "0s ago", it has been sitting there the whole time.
      let firstSeen = this.flipFirstSeen.get(a.uuid);
      if (!firstSeen) { firstSeen = Date.now(); this.flipFirstSeen.set(a.uuid, firstSeen); }
      flip.seenAt = firstSeen;
      flip.isNew = freshSet.has(a.uuid);
      seenNow.add(a.uuid);
      board.push(flip);
    }
    // A flip that vanished from the wall was bought or cancelled - drop it,
    // rather than leaving a dead row the user will waste a click on.
    for (const uuid of this.flipFirstSeen.keys()) if (!seenNow.has(uuid)) this.flipFirstSeen.delete(uuid);

    board.sort((a, b) => b.profit - a.profit);
    const newOnes = board.filter(f => f.isNew);
    this.stats.flips += newOnes.length;
    this.stats.boardSize = board.length;
    this.recentFlips = board.slice(0, 300);
    this.log('info', `snapshot: ${bins.length} BINs, +${fresh.length} new → ${board.length} under the wall (${newOnes.length} fresh)`);

    if (board.length) await this.store.writeFlips(board.slice(0, 120));
    // Only alert on listings that are actually new. Re-alerting every minute on
    // the same stale row is how an alert feed becomes something you mute.
    for (const f of newOnes) {
      if (f.profit >= CONFIG.alerts.flipProfit) {
        this.raise('flip', f.keyBase, `${f.name}  +${Math.round(f.profit / 1e6)}m`,
          `buy ${f.price} / worth ${f.value} · ${f.marginPct}% · ${f.strategy}`);
      }
    }
    this.emit('flips', this.recentFlips);
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
