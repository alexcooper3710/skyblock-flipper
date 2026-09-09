// The live data every panel reads from, and the actions that change it.
//
// Panels used to read a single module-level `state` object that also held each
// panel's own settings. Once a panel can be opened twice those are different
// things: settings belong to the view (and are saved with the layout), while
// this is the one shared copy of what the market is doing.
export const feed = {
  flips: [],
  bazaar: { orders: [], crafts: [] },
  alerts: [],
  watchlist: [],
  watchKeys: new Set(),
  log: [],
  phase: null,
  seed: null,
  stats: null,
  item: null,          // last item clicked, for row highlighting
  unseen: 0,
};

export const bus = new EventTarget();
export const announce = (what) => bus.dispatchEvent(new CustomEvent('change', { detail: what }));

export const LOG_CAP = 500;
export function pushLog(entry) {
  feed.log.push(entry);
  if (feed.log.length > LOG_CAP) feed.log.splice(0, feed.log.length - LOG_CAP);
}

export function setWatchlist(rows) {
  feed.watchlist = rows || [];
  feed.watchKeys = new Set(feed.watchlist.map(w => w.key));
}

export async function toggleWatch(key, label) {
  const on = feed.watchKeys.has(key);
  const r = on
    ? await fetch('/api/watchlist?key=' + encodeURIComponent(key), { method: 'DELETE' }).then(x => x.json()).catch(() => null)
    : await fetch('/api/watchlist', { method: 'POST', body: JSON.stringify({ key, label }) }).then(x => x.json()).catch(() => null);
  if (r) setWatchlist(r.watchlist);
  // Stars live on rows all over the app, so everything repaints.
  announce('watchlist');
}
