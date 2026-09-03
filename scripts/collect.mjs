// The server.
//
// GitHub Pages cannot run anything, so this runs on GitHub Actions instead: it
// polls Hypixel on a schedule with the SAME engine modules the browser build
// uses, computes the flip board and the bazaar book, and force-pushes the result
// to an orphan `market-data` branch. The page fetches that from
// raw.githubusercontent.com (which sends access-control-allow-origin: *) and has
// a real market on screen before its own first poll has even finished.
//
// Orphan + force-push on purpose: the data is a snapshot, not a history, so
// replacing the branch each run keeps the repository from growing without bound.
//
// No npm dependencies. docs/nbt.js is a dependency-free NBT reader and
// docs/shared/* is generated from src/main/engine, so CI needs nothing installed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { decodeItemBytes } = await import(path.join(ROOT, 'docs/nbt.js'));
const { readItem, pricingKeys } = await import(path.join(ROOT, 'docs/shared/itemkeys.js'));
const { PriceBook } = await import(path.join(ROOT, 'docs/shared/pricing.js'));
const { evaluate } = await import(path.join(ROOT, 'docs/shared/strategies.js'));
const { topOfBook, orderFlips, craftFlips } = await import(path.join(ROOT, 'docs/shared/bazaar.js'));

const OUT = path.join(ROOT, 'out');
const PREV = path.join(ROOT, 'prev');
const BASE = 'https://api.hypixel.net/v2';

// Deliberately looser than the browser defaults. This board is a starting point
// the user scrolls, not an alert that costs them money when it is wrong - and a
// seed that is empty because the thresholds were tight is a seed that failed.
const CFG = {
  maxBudget: 500000000, minProfit: 250000, minMarginPct: 6, minSampleSize: 3,
  soldWindowMinutes: 60,
  strategies: { lowestBinSnipe: true, soldMedian: true, attributeAware: true, bazaarAndCraft: true },
  bazaar: { minWeeklyVolume: 100000, minSpreadPct: 4, minProfitPerFlip: 50000, taxPct: 1.25 },
  blacklistIds: ['SKYBLOCK_MENU'],
};

const SOLD_POLLS = Number(process.env.SOLD_POLLS || 3);
const SOLD_GAP_MS = Number(process.env.SOLD_GAP_MS || 60000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function getJson(pathname, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + pathname, { headers: { 'user-agent': 'skyblock-terminal-collector' } });
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw new Error(`${pathname}: ${last && last.message}`);
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Last run's sold samples, so the window is continuous across runs instead of
// being the 60 seconds auctions_ended happens to cover.
async function loadPrevSold() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(PREV, 'sold-raw.json'), 'utf8'));
    const cutoff = Date.now() - CFG.soldWindowMinutes * 60000;
    const rows = [];
    for (const [key, arr] of raw.sold || []) {
      for (const [price, at] of arr) if (at >= cutoff) rows.push({ key, price, at, auctionId: `${key}:${at}:${price}` });
    }
    log(`carried ${rows.length} sold samples forward from the previous run`);
    return rows;
  } catch { return []; }
}

async function pollSold(book, seen) {
  const body = await getJson('/skyblock/auctions_ended');
  const rows = (await mapPool(body.auctions || [], 16, async (s) => {
    if (seen.has(s.auction_id)) return null;
    seen.add(s.auction_id);
    try {
      const keys = pricingKeys(readItem(await decodeItemBytes(s.item_bytes)));
      if (!keys) return null;
      return [...new Set([keys.variant, keys.base].filter(Boolean))]
        .map(k => ({ key: k, price: s.price, at: s.timestamp, auctionId: `${s.auction_id}:${k}` }));
    } catch { return null; }
  })).filter(Boolean).flat();
  book.addSales(rows);
  return rows.length;
}

(async () => {
  const t0 = Date.now();
  await fs.mkdir(OUT, { recursive: true });
  const book = new PriceBook(CFG);
  const seenSales = new Set();

  book.addSales(await loadPrevSold());

  // ---- bazaar: one request, the whole market ------------------------------
  const bz = await getJson('/skyblock/bazaar');
  const products = {};
  for (const [id, p] of Object.entries(bz.products)) {
    const t = topOfBook(p);
    if (!t.buyOrder && !t.sellOrder && !t.instantBuy) continue;
    products[id] = {
      b: Number(t.buyOrder.toFixed(1)), s: Number(t.sellOrder.toFixed(1)),
      ib: Number((t.instantBuy || 0).toFixed(1)), is: Number((t.instantSell || 0).toFixed(1)),
      bv: t.buyVolWeek, sv: t.sellVolWeek,
      // A handful of rungs is enough to show where the wall is; the tab fills in
      // the full 30-deep ladder from its own poll a second after it opens.
      bids: t.bids.slice(0, 6).map(l => [Number(l.price.toFixed(1)), l.amount, l.orders]),
      asks: t.asks.slice(0, 6).map(l => [Number(l.price.toFixed(1)), l.amount, l.orders]),
    };
  }
  log(`bazaar: ${Object.keys(products).length} products`);

  // ---- auctions: the expensive half ---------------------------------------
  const head = await getJson('/skyblock/auctions?page=0');
  const pages = await mapPool([...Array(head.totalPages).keys()], 8,
    async (p) => { try { return (await getJson(`/skyblock/auctions?page=${p}`)).auctions || []; } catch { return []; } });
  const auctions = pages.flat();
  const bins = auctions.filter(a => a.bin);
  log(`auctions: ${auctions.length} total, ${bins.length} BIN, ${head.totalPages} pages, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const tDec = Date.now();
  const keyed = new Map();
  await mapPool(bins, 24, async (a) => {
    try {
      const item = readItem(await decodeItemBytes(a.item_bytes));
      const keys = pricingKeys(item);
      if (keys) keyed.set(a.uuid, { keys, item });
    } catch { /* one bad item must not sink the run */ }
  });
  log(`decoded ${keyed.size} items in ${((Date.now() - tDec) / 1000).toFixed(1)}s`);

  const entries = [];
  for (const a of bins) { const c = keyed.get(a.uuid); if (c) entries.push({ bin: true, price: a.starting_bid, keys: c.keys }); }
  book.rebuildBinWall(entries);

  // ---- sold feed: several polls so the window is not a single 60s slice ----
  for (let i = 0; i < SOLD_POLLS; i++) {
    if (i) await sleep(SOLD_GAP_MS);
    try { log(`sold poll ${i + 1}/${SOLD_POLLS}: +${await pollSold(book, seenSales)} samples`); }
    catch (e) { log(`sold poll ${i + 1} failed: ${e.message}`); }
  }

  // ---- the board ----------------------------------------------------------
  const board = [];
  for (const a of bins) {
    const c = keyed.get(a.uuid);
    if (!c || CFG.blacklistIds.includes(c.item.id)) continue;
    const f = evaluate({ auction: a, item: c.item, keys: c.keys, book, cfg: CFG });
    if (f) { f.isNew = false; f.seed = true; board.push(f); }
  }
  board.sort((a, b) => b.profit - a.profit);
  const flips = board.slice(0, 250);
  log(`board: ${board.length} listings under their own resale price`);

  // ---- what the page needs to price things before its own snapshot lands ---
  const wall = {};
  const wanted = new Set();
  for (const f of flips) { if (f.keyBase) wanted.add(f.keyBase); if (f.keyVariant) wanted.add(f.keyVariant); }
  for (const [k, arr] of book.lowestBin) {
    if (wanted.has(k) || (arr.length >= 4 && arr[0] >= 500000)) wall[k] = arr.slice(0, 4);
  }
  const sold = {};
  for (const k of book.sold.keys()) {
    const st = book.soldStats(k);
    if (st.n >= 2 && st.median > 0) sold[k] = [Math.round(st.median), st.n];
  }
  log(`seed: ${Object.keys(wall).length} wall keys, ${Object.keys(sold).length} sold keys`);

  const ts = Date.now();
  const meta = {
    ts, generated: new Date(ts).toISOString(), tookMs: ts - t0,
    totalAuctions: auctions.length, binCount: bins.length, decoded: keyed.size,
    flips: flips.length, boardSize: board.length,
    wallKeys: Object.keys(wall).length, soldKeys: Object.keys(sold).length,
    bazaarProducts: Object.keys(products).length,
    snapshotAt: head.lastUpdated, cfg: CFG,
  };

  const write = async (name, obj) => {
    const s = JSON.stringify(obj);
    await fs.writeFile(path.join(OUT, name), s);
    log(`wrote ${name}  ${(s.length / 1048576).toFixed(2)} MB`);
  };
  await write('meta.json', meta);
  await write('bazaar.json', { ts, products, orders: orderFlips(bz.products, CFG).slice(0, 60), crafts: craftFlips(bz.products, CFG).slice(0, 60) });
  await write('ah.json', { ts, flips, wall, sold });
  await write('sold-raw.json', book.serialize());

  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error('COLLECT FAILED', e); process.exit(1); });
