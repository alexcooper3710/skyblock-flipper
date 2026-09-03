// A rolling price series for every bazaar product, carried from one collector
// run to the next.
//
// This is the cheap half of price tracking. The collector already samples the
// whole bazaar every five minutes, so diffing consecutive runs gives real price
// movement for all ~2,200 products at zero extra request cost. Per-item detail
// charts still come from Coflnet on demand; this is what lets the LIST say what
// is moving without 2,200 requests to find out.
//
// Stored as { products: { ID: [[sell...], [buy...]] } } on a fixed step with
// nulls for gaps, so a product costs two numbers per sample rather than an
// object per sample.

export const STEP_MS = 5 * 60000;
export const KEEP = 288;              // 24 hours at five-minute resolution
export const MIN_VOLUME = 10000;      // products nobody trades are just weight

export function emptySeries() {
  return { v: 1, step: STEP_MS, t0: 0, products: {} };
}

function sampleCount(series) {
  const first = Object.values(series.products)[0];
  return first ? first[0].length : 0;
}

export function appendSeries(prev, products, ts, { minVolume = MIN_VOLUME } = {}) {
  const slot = Math.floor(ts / STEP_MS);
  const len = sampleCount(prev);
  // Cron is best effort, so runs are often more than one slot apart. Pad the
  // gap with nulls rather than pretending the samples are adjacent - otherwise
  // "an hour ago" silently means whatever twelve samples happen to span.
  const lastSlot = len ? Math.floor(prev.t0 / STEP_MS) + len - 1 : slot;
  const gap = Math.max(0, Math.min(KEEP, slot - lastSlot - 1));

  const out = { v: 1, step: STEP_MS, t0: 0, products: {} };
  for (const [id, p] of Object.entries(products)) {
    if (Math.max(p.sv || 0, p.bv || 0) < minVolume) continue;
    const old = prev.products[id];
    let sell = old ? old[0].slice() : [];
    let buy = old ? old[1].slice() : [];
    for (let i = 0; i < gap; i++) { sell.push(null); buy.push(null); }
    sell.push(p.s || null);
    buy.push(p.b || null);
    if (sell.length > KEEP) { sell = sell.slice(-KEEP); buy = buy.slice(-KEEP); }
    out.products[id] = [sell, buy];
  }
  const n = sampleCount(out) || 1;
  out.t0 = (slot - (n - 1)) * STEP_MS;
  return out;
}

// Percentage move over the last `mins` minutes. Returns null rather than
// reporting a twenty-minute move as a daily one - a change column that lies
// about its window is worse than a blank one.
export function changeOver(series, id, mins) {
  const row = series.products[id];
  if (!row) return null;
  const sell = row[0];
  const now = sell[sell.length - 1];
  if (!now) return null;
  const back = Math.round((mins * 60000) / STEP_MS);
  const from = sell.length - 1 - back;
  if (from < 0 || sell.length - 1 - Math.max(0, from) < back * 0.6) return null;
  for (let i = Math.max(0, from); i < sell.length - 1; i++) {
    if (sell[i]) return ((now - sell[i]) / sell[i]) * 100;
  }
  return null;
}
