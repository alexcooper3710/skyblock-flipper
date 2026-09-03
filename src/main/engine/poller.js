'use strict';
// The clock. Hypixel cuts a new auction snapshot roughly every 60s; the whole
// point of self-hosting is to be reading it the moment it lands instead of
// whenever someone else's queue gets around to you.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const api = require('./api');
const { decodeItemBytes, readItem, pricingKeys } = require('./nbt');
const { PriceBook } = require('./pricing');
const { evaluate } = require('./strategies');
const bazaarEngine = require('./bazaar');

const LEAD_MS = 800;        // start probing this early
const PROBE_MS = 250;       // how often to probe once we're in the window
const MAX_PROBE_MS = 20000; // give up probing and just take what we get

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

class Flipper extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.book = new PriceBook(cfg);
    this.keyCache = new Map();   // auction uuid -> {base, variant, item}
    this.knownUuids = new Set();
    this.lastUpdated = 0;
    this.running = false;
    this.warmedUp = false;
    this.timers = [];
    this.persistPath = cfg.persistPath || null;
    this.stats = { snapshots: 0, flips: 0, lastCycleMs: 0, decodes: 0, totalAuctions: 0 };
  }

  loadBook() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return 0;
    try {
      const n = this.book.hydrate(JSON.parse(fs.readFileSync(this.persistPath, 'utf8')));
      if (n) this.log('info', `restored ${n} sold samples from the last run`);
      return n;
    } catch (e) {
      this.log('warn', `price book unreadable, starting cold: ${e.message}`);
      return 0;
    }
  }

  saveBook() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      // write-then-rename so a crash mid-write can't leave a truncated file
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.book.serialize()));
      fs.renameSync(tmp, this.persistPath);
    } catch (e) {
      this.log('warn', `could not save price book: ${e.message}`);
    }
  }

  log(level, msg, extra) { this.emit('log', { level, msg, extra, at: Date.now() }); }

  async start() {
    if (this.running) return;
    this.running = true;
    api.setApiKey(this.cfg.apiKey);
    this.loadBook();
    this.loopPersist();
    this.loopAuctions();
    this.loopSold();
    if (this.cfg.strategies.bazaarAndCraft) this.loopBazaar();
  }

  stop() {
    this.running = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.saveBook();
  }

  async loopPersist() {
    while (this.running) {
      await this.sleep(60000);
      if (this.running) this.saveBook();
    }
  }

  sleep(ms) {
    return new Promise(r => { const t = setTimeout(r, ms); this.timers.push(t); });
  }

  // --- auction snapshot loop -------------------------------------------------
  async loopAuctions() {
    while (this.running) {
      try {
        const head = await this.waitForFreshSnapshot();
        if (!head) { await this.sleep(2000); continue; }

        // Start the clock AFTER the wait - cycle time should mean "how long did
        // it take to read and score this snapshot", not "how long is a minute".
        const cycleStart = Date.now();
        const all = await api.getAllAuctionPages(head.body.totalPages, this.cfg.pageConcurrency);
        await this.processSnapshot(all, head.body.lastUpdated);

        this.stats.lastCycleMs = Date.now() - cycleStart;
        this.emit('stats', { ...this.stats, book: this.book.stats(), warmedUp: this.warmedUp });
      } catch (e) {
        this.log('error', `auction loop: ${e.message}`);
        await this.sleep(3000);
      }
    }
  }

  // Sit on the boundary and probe until `lastUpdated` actually moves. This is
  // the difference between seeing a snapshot at t+0.5s and seeing it at t+40s.
  async waitForFreshSnapshot() {
    let head = await api.getAuctionPage(0);
    if (head.body.lastUpdated !== this.lastUpdated) return head;

    const dueAt = api.nextSnapshotAt(head.body.lastUpdated) - LEAD_MS;
    const wait = dueAt - Date.now();
    if (wait > 0) await this.sleep(wait);

    const deadline = Date.now() + MAX_PROBE_MS;
    while (this.running && Date.now() < deadline) {
      head = await api.getAuctionPage(0);
      if (head.body.lastUpdated !== this.lastUpdated) return head;
      await this.sleep(PROBE_MS);
    }
    return null;
  }

  async processSnapshot(auctions, lastUpdated) {
    this.lastUpdated = lastUpdated;
    this.stats.snapshots++;
    this.stats.totalAuctions = auctions.length;

    const bins = auctions.filter(a => a.bin);
    const needDecode = bins.filter(a => !this.keyCache.has(a.uuid));

    // Only brand-new listings need decoding; everything else is already keyed.
    await mapPool(needDecode, 8, async (a) => {
      try {
        const item = readItem(await decodeItemBytes(a.item_bytes));
        const keys = pricingKeys(item);
        if (keys) this.keyCache.set(a.uuid, { keys, item });
        this.stats.decodes++;
      } catch (e) { this.log('warn', `decode failed: ${e.message}`); }
    });

    const entries = [];
    for (const a of bins) {
      const c = this.keyCache.get(a.uuid);
      if (c) entries.push({ bin: true, price: a.starting_bid, keys: c.keys });
    }
    this.book.rebuildBinWall(entries);
    this.emit('wall', { ts: lastUpdated, wall: this.book.lowestBin });

    // First snapshot only establishes the baseline - firing flips off it would
    // just be reacting to the entire existing market as if it were new.
    const fresh = [];
    if (this.knownUuids.size) {
      for (const a of bins) if (!this.knownUuids.has(a.uuid)) fresh.push(a);
    }
    this.knownUuids = new Set(bins.map(a => a.uuid));
    this.pruneKeyCache();

    if (!this.warmedUp) {
      this.warmedUp = true;
      this.log('info', `baseline built: ${bins.length} BINs across ${auctions.length} auctions`);
      return;
    }

    const flips = [];
    for (const a of fresh) {
      const c = this.keyCache.get(a.uuid);
      if (!c) continue;
      if (this.cfg.blacklistIds.includes(c.item.id)) continue;
      const flip = evaluate({ auction: a, item: c.item, keys: c.keys, book: this.book, cfg: this.cfg });
      if (flip) flips.push(flip);
    }
    flips.sort((a, b) => b.profit - a.profit);
    this.stats.flips += flips.length;
    this.emit('snapshot', {
      ts: lastUpdated, totalAuctions: auctions.length, binCount: bins.length,
      newBins: fresh.length, cycleMs: this.stats.lastCycleMs,
    });
    this.log('info', `snapshot +${fresh.length} new BINs -> ${flips.length} flips`);
    if (flips.length) this.emit('flips', flips);
  }

  pruneKeyCache() {
    if (this.keyCache.size < 120000) return;
    for (const k of this.keyCache.keys()) {
      if (!this.knownUuids.has(k)) this.keyCache.delete(k);
    }
  }

  // --- sold feed loop --------------------------------------------------------
  // auctions_ended only covers the last minute, so this has to run on its own
  // cadence or the sold history has holes in it.
  async loopSold() {
    while (this.running) {
      try {
        const { body } = await api.getEndedAuctions();
        const sales = await mapPool(body.auctions || [], 8, async (s) => {
          try {
            const item = readItem(await decodeItemBytes(s.item_bytes));
            const keys = pricingKeys(item);
            if (!keys) return null;
            // For a plain item variant === base. Recording both would count one
            // sale twice and let a single sale satisfy minSampleSize.
            return [...new Set([keys.variant, keys.base].filter(Boolean))].map(k => (
              { key: k, price: s.price, at: s.timestamp, auctionId: `${s.auction_id}:${k}` }
            ));
          } catch { return null; }
        });
        const rows = sales.filter(Boolean).flat();
        this.book.addSales(rows);
        if (rows.length) this.emit('sales', rows);
      } catch (e) {
        this.log('warn', `sold feed: ${e.message}`);
      }
      await this.sleep(20000);
    }
  }

  // --- bazaar loop -----------------------------------------------------------
  async loopBazaar() {
    while (this.running) {
      try {
        const { body } = await api.getBazaar();
        const missing = bazaarEngine.validateRatios(body.products);
        if (missing.length) this.log('warn', `craft table: ${missing.length} unknown ids`, missing.slice(0, 5));
        const books = new Map();
        for (const [id, product] of Object.entries(body.products)) {
          books.set(id, bazaarEngine.topOfBook(product));
        }
        this.emit('bazaar', {
          orders: bazaarEngine.orderFlips(body.products, this.cfg).slice(0, 60),
          crafts: bazaarEngine.craftFlips(body.products, this.cfg).slice(0, 60),
          books,
          at: Date.now(),
        });
      } catch (e) {
        this.log('warn', `bazaar: ${e.message}`);
      }
      await this.sleep(60000);
    }
  }
}

module.exports = { Flipper, mapPool };
