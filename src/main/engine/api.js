'use strict';
// Thin Hypixel SkyBlock API client.
// The auction endpoints are CDN-cached and refresh roughly once a minute.
// Everything here is built around knowing EXACTLY when that happens.

const BASE = 'https://api.hypixel.net/v2';

let apiKey = '';
function setApiKey(k) { apiKey = k || ''; }

function headers() {
  const h = { 'accept': 'application/json', 'user-agent': 'skyblock-flipper/1.0' };
  if (apiKey) h['API-Key'] = apiKey;
  return h;
}

async function getJson(path, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { headers: headers(), signal: ctrl.signal });
    const meta = {
      status: res.status,
      age: Number(res.headers.get('age') || 0),
      cacheControl: res.headers.get('cache-control') || '',
      lastModified: res.headers.get('last-modified') || '',
      receivedAt: Date.now(),
    };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
      err.meta = meta;
      throw err;
    }
    const body = await res.json();
    return { body, meta };
  } finally {
    clearTimeout(timer);
  }
}

// Hypixel refreshes the auction snapshot about once a minute. The CDN sends
// `max-age=60` (the real snapshot lifetime) alongside a much longer `s-maxage`,
// so trust `max-age` — and trust the body's own `lastUpdated` over both.
const SNAPSHOT_MS = 60000;

function secondsUntilNextSnapshot(meta) {
  const m = /(?:^|[ ,])max-age=(\d+)/.exec(meta.cacheControl);
  const ttl = m ? Number(m[1]) : 60;
  return Math.max(0, ttl - meta.age);
}

// Authoritative: the snapshot we just read was cut at `lastUpdated`, so the next
// one lands one interval later. Everything upstream schedules against this.
function nextSnapshotAt(lastUpdated) {
  return Number(lastUpdated) + SNAPSHOT_MS;
}

const getAuctionPage = (page) => getJson(`/skyblock/auctions?page=${page}`);
const getEndedAuctions = () => getJson('/skyblock/auctions_ended');
const getBazaar = () => getJson('/skyblock/bazaar');
const getItemsResource = () => getJson('/resources/skyblock/items', { timeoutMs: 30000 });

// Fetch every page of a snapshot with bounded concurrency. Pages are all served
// from the same CDN snapshot, so this is one coherent view of the market.
async function getAllAuctionPages(totalPages, concurrency = 16) {
  const out = new Array(totalPages);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, totalPages) }, async () => {
    while (true) {
      const page = next++;
      if (page >= totalPages) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { body } = await getAuctionPage(page);
          out[page] = body.auctions || [];
          break;
        } catch (e) {
          if (attempt === 2) out[page] = [];
          else await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
        }
      }
    }
  });
  await Promise.all(workers);
  return out.flat();
}

module.exports = {
  setApiKey, getJson, getAuctionPage, getEndedAuctions, getBazaar,
  getItemsResource, getAllAuctionPages, secondsUntilNextSnapshot, nextSnapshotAt, SNAPSHOT_MS,
};
