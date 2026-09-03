// GENERATED from src/main/engine/pricing.js by scripts/build-web.js - do not edit.
// The price book. Two independent views of "what is this worth":
//   1. the live BIN wall  (what it's listed at right now)
//   2. the sold feed      (what people actually paid, from auctions_ended)
// A flip only fires when at least one of them is confident.

const DEFAULT_WINDOW_MIN = 45;

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Trim the tails before taking a median: the sold feed is full of both
// mispriced dumps and whale overpays, and either will poison a small sample.
function trimmedMedian(values, trim = 0.15) {
  if (values.length < 4) return median([...values].sort((a, b) => a - b));
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  return median(s.slice(cut, s.length - cut));
}

// Hypixel's cut when your listing sells.
function auctionTax(price) {
  if (price >= 100000000) return price * 0.025;
  if (price >= 10000000) return price * 0.02;
  return price * 0.01;
}

class PriceBook {
  constructor(opts = {}) {
    this.windowMs = (opts.soldWindowMinutes || DEFAULT_WINDOW_MIN) * 60000;
    this.sold = new Map();        // key -> [{price, at}]
    this.lowestBin = new Map();   // key -> [p1, p2, p3] ascending
    this.seenSoldIds = new Set();
    this.lastSnapshotAt = 0;
  }

  // --- live BIN wall, rebuilt from scratch every snapshot -------------------
  rebuildBinWall(entries) {
    const buckets = new Map();
    for (const e of entries) {
      if (!e.bin || !e.keys) continue;
      // variant and base collide for plain items - only count the listing once
      for (const k of new Set([e.keys.variant, e.keys.base].filter(Boolean))) {
        let arr = buckets.get(k);
        if (!arr) buckets.set(k, (arr = []));
        arr.push(e.price);
      }
    }
    this.lowestBin.clear();
    for (const [k, arr] of buckets) {
      arr.sort((a, b) => a - b);
      this.lowestBin.set(k, arr.slice(0, 8));
    }
    this.lastSnapshotAt = Date.now();
  }

  binAt(key, index = 0) {
    const arr = this.lowestBin.get(key);
    return arr && arr.length > index ? arr[index] : 0;
  }

  binDepth(key) {
    const arr = this.lowestBin.get(key);
    return arr ? arr.length : 0;
  }

  // --- sold feed, appended every poll and aged out -------------------------
  addSales(sales) {
    const now = Date.now();
    for (const s of sales) {
      if (!s.key || !s.price) continue;
      if (s.auctionId && this.seenSoldIds.has(s.auctionId)) continue;
      if (s.auctionId) this.seenSoldIds.add(s.auctionId);
      let arr = this.sold.get(s.key);
      if (!arr) this.sold.set(s.key, (arr = []));
      arr.push({ price: s.price, at: s.at || now });
    }
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, arr] of this.sold) {
      const kept = arr.filter(x => x.at >= cutoff);
      if (kept.length) this.sold.set(k, kept);
      else this.sold.delete(k);
    }
    if (this.seenSoldIds.size > 200000) this.seenSoldIds.clear();
  }

  soldStats(key) {
    const arr = this.sold.get(key);
    if (!arr || !arr.length) return { n: 0, median: 0 };
    return { n: arr.length, median: trimmedMedian(arr.map(x => x.price)) };
  }

  // --- the actual valuation -------------------------------------------------
  // Returns { value, basis, confidence, samples }.
  // Variant-level evidence always beats base-level; sold beats listed.
  valuate(keys, { minSampleSize = 3 } = {}) {
    const candidates = [];

    const vSold = keys.variant ? this.soldStats(keys.variant) : { n: 0, median: 0 };
    if (vSold.n >= minSampleSize) {
      candidates.push({ value: vSold.median, basis: 'sold:variant', confidence: 0.95, samples: vSold.n });
    }

    // Second-lowest BIN is the honest "resale wall": undercutting the single
    // lowest listing is how you actually sell, so price against #2, not #1.
    const vBin2 = keys.variant ? this.binAt(keys.variant, 1) : 0;
    if (vBin2) {
      candidates.push({ value: vBin2, basis: 'bin2:variant', confidence: 0.8, samples: this.binDepth(keys.variant) });
    }

    const bSold = keys.base ? this.soldStats(keys.base) : { n: 0, median: 0 };
    if (bSold.n >= minSampleSize) {
      candidates.push({ value: bSold.median, basis: 'sold:base', confidence: 0.6, samples: bSold.n });
    }

    const bBin2 = keys.base ? this.binAt(keys.base, 1) : 0;
    if (bBin2) {
      candidates.push({ value: bBin2, basis: 'bin2:base', confidence: 0.45, samples: this.binDepth(keys.base) });
    }

    if (!candidates.length) return { value: 0, basis: 'none', confidence: 0, samples: 0 };
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0];
  }

  // --- persistence ----------------------------------------------------------
  // auctions_ended only yields ~90 sales a minute, so a cold start needs the
  // full window before sold-median means anything. Keeping it across restarts
  // is the difference between "useful now" and "useful in 45 minutes".
  serialize() {
    this.prune();
    const sold = [];
    for (const [k, arr] of this.sold) {
      // cap per key so one liquid item can't bloat the file
      sold.push([k, arr.slice(-40).map(x => [x.price, x.at])]);
    }
    return { v: 1, savedAt: Date.now(), windowMs: this.windowMs, sold };
  }

  hydrate(data) {
    if (!data || data.v !== 1 || !Array.isArray(data.sold)) return 0;
    const cutoff = Date.now() - this.windowMs;
    let restored = 0;
    for (const [k, rows] of data.sold) {
      const kept = rows
        .filter(r => Array.isArray(r) && r[1] >= cutoff)
        .map(([price, at]) => ({ price, at }));
      if (kept.length) { this.sold.set(k, kept); restored += kept.length; }
    }
    return restored;
  }

  stats() {
    return {
      soldKeys: this.sold.size,
      soldSamples: [...this.sold.values()].reduce((a, v) => a + v.length, 0),
      binKeys: this.lowestBin.size,
    };
  }
}

export { PriceBook, auctionTax, trimmedMedian, median };