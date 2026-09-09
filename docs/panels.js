// The panels.
//
// Every panel is a function that mounts itself into whatever element the
// workspace hands it and returns a refresh hook. Nothing here reaches for a
// hardcoded element id, which is what lets the same panel be opened twice, live
// in any pane, and be dragged somewhere else without re-fetching.
//
//   cfg  = this panel's own settings (filter, sort, which item) - saved with the layout
//   feed = the shared live data every panel reads from
import {
  el, fmt, pct, exact, ago, CSS, lineChart, barChart, sparkline, ladderView, wallView,
} from './ui.js';
import { feed, toggleWatch } from './feed.js';
import {
  realizedVol, rangeStats, maxDrawdown, makerEdge, takerCost, bookImbalance,
  hoursToClear, queueAhead, undercutRoom, sellThroughHours, salesRate,
} from './metrics.js';

// --- shared bits -----------------------------------------------------------
function watchStar(key, label) {
  const on = feed.watchKeys.has(key);
  const b = el('button', 'star' + (on ? ' on' : ''), on ? '\u2605' : '\u2606');
  b.title = on ? 'Stop watching' : 'Add to watchlist';
  b.onclick = (e) => { e.stopPropagation(); toggleWatch(key, label); };
  return b;
}
function starCell(key, label) {
  const td = el('td', 'stc');
  td.appendChild(watchStar(key, label));
  return td;
}

// A stat tile: one number, its name, and the thing you need to know to read it.
// Deliberately not a chart - a single figure is not a shape, and drawing it as
// one wastes the space that the figure's caveat should occupy.
function tile(grid, label, value, { sub = '', tone = '', title = '' } = {}) {
  const t = el('div', 'stat' + (tone ? ' ' + tone : ''));
  if (title) t.title = title;
  t.appendChild(el('div', 'statlab', label));
  t.appendChild(el('div', 'statval', value));
  if (sub) t.appendChild(el('div', 'statsub', sub));
  grid.appendChild(t);
  return t;
}

const signed = (n, unit = '%') => (n > 0 ? '+' : '') + n.toFixed(2) + unit;
const hours = (h) => h == null ? '—' : h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd';

// Everything a bazaar product's numbers say, in the order you would ask.
function bazaarStats(host, d, priceSeries) {
  const grid = el('div', 'stats');
  const book = d.book;
  const edge = makerEdge(book);
  const cost = takerCost(book);
  const imb = bookImbalance(book);
  const vol1 = realizedVol(priceSeries, { perHours: 1 });
  const vol24 = realizedVol(priceSeries, { perHours: 24 });
  const rng = rangeStats(priceSeries);
  const dd = maxDrawdown(priceSeries);

  if (edge) {
    tile(grid, 'edge / unit', fmt(edge.perUnit), {
      sub: edge.pct == null ? '' : signed(edge.pct),
      tone: edge.perUnit > 0 ? 'good' : 'bad',
      title: `Buy at ${exact(edge.buyAt)}, sell at ${exact(edge.sellAt)}, minus ${exact(edge.tax)} tax. What you make per unit if both orders fill — not the spread, which ignores the tax.`,
    });
  }
  if (cost) {
    tile(grid, 'spread', fmt(cost.spread), { sub: cost.pct == null ? '' : cost.pct.toFixed(2) + '% of mid',
      title: 'Bid to ask. What it costs to change your mind immediately.' });
  }
  if (vol1 != null) {
    tile(grid, 'volatility', vol1.toFixed(2) + '%/h', {
      sub: vol24 == null ? '' : vol24.toFixed(1) + '%/day',
      title: 'Standard deviation of log returns, scaled to an hour. Roughly how far the price wanders in either direction — bigger means your resting order is likelier to be run over.',
    });
  }
  if (rng) {
    tile(grid, 'range', `${fmt(rng.min)} – ${fmt(rng.max)}`, {
      sub: `now ${(rng.position * 100).toFixed(0)}% up the band`,
      title: 'Low and high across the window shown, and where the current price sits between them. A price that feels low is not the same as one that is.',
    });
  }
  if (dd != null) tile(grid, 'max drawdown', '-' + dd.toFixed(1) + '%', {
    tone: dd > 25 ? 'bad' : '', title: 'The worst peak-to-trough fall inside the window — the hole you would have sat through.' });

  if (imb) {
    const pct = imb.imbalance * 100;
    tile(grid, 'book skew', signed(pct, '%'), {
      sub: pct > 0 ? 'bid-heavy' : 'ask-heavy',
      tone: '',
      title: `${fmt(imb.bidUnits)} units bid against ${fmt(imb.askUnits)} offered. Positive means buyers are queued deeper than sellers. Totals come from quick_status, not the truncated ladder.`,
    });
  }
  if (book) {
    tile(grid, 'orders', `${fmt(book.buyOrders)} / ${fmt(book.sellOffers)}`, {
      sub: 'buy / sell', title: 'How many orders actually exist on each side. The visible ladder is truncated and shows fewer.' });
    const clearBid = hoursToClear(imb && imb.askUnits, book.sellVolWeek);
    if (clearBid != null) tile(grid, 'clears in', hours(clearBid), {
      sub: `${fmt(book.sellVolWeek)}/wk`,
      title: 'How long the resting sell side would take to clear at the recent rate of trade. A tight spread on a book that takes days to clear is not a liquid market.' });
    const q = queueAhead(book.bids, edge ? edge.buyAt - 0.1 : null);
    if (q != null) tile(grid, 'queue ahead', fmt(q), { sub: 'units at the touch',
      title: 'Size sitting in front of you at the best bid — what has to trade before your order does.' });
  }
  if (grid.children.length) host.appendChild(grid);
}

// The auction-house equivalents. Different market, different questions.
function auctionStats(host, d, priceSeries) {
  const grid = el('div', 'stats');
  const wall = d.wall && d.wall.prices;
  const room = undercutRoom(wall);
  const vol = realizedVol(priceSeries, { perHours: 24 });
  const rng = rangeStats(priceSeries);
  const rate = salesRate(d.sales);

  if (d.current || wall) {
    const low = wall && wall[0];
    if (low) tile(grid, 'lowest BIN', fmt(low), { sub: `${(d.wall.depth || wall.length)} listed`,
      title: 'The cheapest copy on the market right now, and how many are listed behind it.' });
  }
  if (room) {
    tile(grid, 'undercut room', fmt(room.gap), { sub: signed(room.pct),
      tone: room.pct > 20 ? 'good' : '',
      title: 'Gap between the cheapest listing and the next one up. Thin room means you compete on price immediately; wide room means the cheapest is genuinely mispriced rather than merely first.' });
  }
  if (d.ref && d.ref.median) {
    tile(grid, 'typical sale', fmt(d.ref.median), {
      sub: d.ref.volume ? `${fmt(d.ref.volume)} traded` : '',
      title: 'What this item usually goes for, across every configuration of it. Per item ID, so it knows nothing about enchants or stars — context, not a valuation.' });
  }
  if (vol != null) tile(grid, 'volatility', vol.toFixed(1) + '%/day', {
    title: 'Standard deviation of log returns, scaled to a day. How much the price moves regardless of direction.' });
  if (rng) tile(grid, 'range', `${fmt(rng.min)} – ${fmt(rng.max)}`, {
    sub: `now ${(rng.position * 100).toFixed(0)}% up the band`,
    title: 'Low and high across the window shown, and where it sits between them.' });
  if (rate != null) {
    tile(grid, 'sales rate', rate.toFixed(1) + '/h', { title: 'Observed sales per hour across the window.' });
    const through = sellThroughHours(d.wall && d.wall.depth, rate);
    if (through != null) tile(grid, 'sell-through', hours(through), {
      sub: 'to clear the wall',
      title: 'How long the listings currently up would take to sell at that rate. Long means your copy waits behind them.' });
  }
  if (grid.children.length) host.appendChild(grid);
}

// A control strip above the panel body. Controls belong to the panel, not to
// the page, so two bazaar panels can be sorted differently at the same time.
function shell(host) {
  const bar = el('div', 'pctl');
  const body = el('div', 'pbody');
  host.append(bar, body);
  return { bar, body };
}

function seg(bar, options, current, onPick) {
  const box = el('div', 'seg');
  for (const [value, label] of options) {
    const b = el('button', value === current ? 'on' : '', label);
    b.onclick = () => {
      [...box.querySelectorAll('button')].forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onPick(value);
    };
    box.appendChild(b);
  }
  bar.appendChild(box);
  return box;
}


export function flipsPanel(host, view, ws) {
  const cfg = view.state;
  const { bar, body } = shell(host);
  const ctx = {
    host: body, ws, view,
    openChart: (key, label) => ws.open('chart', { key, label: label || key }),
    refreshAll: () => ws.refreshAll(),
    setTitle: (t) => ws.setViewState(view.id, { label: t }),
  };
  cfg.flipFilter = cfg.flipFilter || 'all';
  seg(bar, [['all', 'all'], ['lowest-bin', 'bin'], ['sold-median', 'sold'], ['attribute', 'attr']],
    cfg.flipFilter, (v) => { cfg.flipFilter = v; ws.setViewState(view.id, { flipFilter: v }); render(); });

  const render = async () => {
  const host = ctx.host;
  const rows = cfg.flipFilter === 'all' ? feed.flips : feed.flips.filter(f => f.strategy === cfg.flipFilter);
  host.innerHTML = '';
  if (!rows.length) {
    const p = feed.phase;
    host.appendChild(el('div', 'empty',
      p && (p.code === 'first-snapshot' || p.code === 'seed') ? p.label
      : cfg.flipFilter !== 'all' ? 'No flips matching that filter right now.'
      : 'Nothing on the wall is under its own resale price right now. Rechecked every snapshot.'));
    return;
  }
  const t = el('table');
  t.innerHTML = '<thead><tr><th class="stc"></th><th>Item</th><th class="r">Buy</th><th class="r">Worth</th><th class="r">Profit</th></tr></thead>';
  const tb = el('tbody');
  for (const f of rows.slice(0, 120)) {
    const tr = el('tr');
    if (feed.item === f.keyBase) tr.className = 'sel';
    const c1 = el('td'); c1.className = 'name';
    c1.appendChild(el('div', null, f.name));
    const sub = el('div', 'sub');
    sub.innerHTML = `<span class="tag ${f.strategy}">${f.strategy}</span>`
      + (f.isNew ? '<span class="tag new">new</span>' : '')
      + (f.seed ? '<span class="tag seed" title="from the collector snapshot - may already be gone">seed</span>' : '')
      + ` ${f.basis} · n=${f.samples}`
      + (f.ref && f.ref.median ? ` · typ ${fmt(f.ref.median)}` : '')
      + ` · ${ago(f.seenAt)}`;
    c1.appendChild(sub);
    const c2 = el('td', 'r num', fmt(f.price));
    const c3 = el('td', 'r num', fmt(f.value));
    const c4 = el('td', 'r num'); c4.innerHTML = `<span class="pos">+${fmt(f.profit)}</span><div class="sub">${f.marginPct}%</div>`;
    tr.append(starCell(f.keyBase, f.name), c1, c2, c3, c4);
    tr.onclick = () => { navigator.clipboard?.writeText(f.command); ctx.openChart(f.keyBase, f.name); };
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
};

  render();
  return { refresh: render };
}

export function bazaarPanel(host, view, ws) {
  const cfg = view.state;
  cfg.bzMode = cfg.bzMode || 'browse';
  cfg.bzSort = cfg.bzSort || 'volume';
  const { bar, body } = shell(host);
  const ctx = { host: body, ws, view, openChart: (k, l) => ws.open('chart', { key: k, label: l || k }),
    refreshAll: () => ws.refreshAll(), search: null, sortSeg: null };

  seg(bar, [['orders', 'flips'], ['crafts', 'crafts'], ['browse', 'book']], cfg.bzMode,
    (v) => { cfg.bzMode = v; ws.setViewState(view.id, { bzMode: v }); render(); });
  ctx.sortSeg = seg(bar, [['volume', 'vol'], ['movers', 'movers'], ['spread', 'spread'], ['price', 'price']],
    cfg.bzSort, (v) => { cfg.bzSort = v; ws.setViewState(view.id, { bzSort: v }); renderBook(); });
  ctx.sortSeg.classList.add('sub');
  const search = el('input', 'pfilter');
  search.placeholder = 'filter the book…';
  search.value = cfg.bzQuery || '';
  let timer = null;
  search.oninput = () => {
    cfg.bzQuery = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => { ws.setViewState(view.id, { bzQuery: cfg.bzQuery }); renderBook(); }, 180);
  };
  bar.appendChild(search);
  ctx.search = search;

  const renderBook = async () => {
  const host = ctx.host;
  const r = await fetch(`/api/bazaar?q=${encodeURIComponent(cfg.bzQuery || '')}&sort=${cfg.bzSort}`)
    .then(r => r.json()).catch(() => null);
  host.innerHTML = '';
  if (!r || !r.rows.length) {
    host.appendChild(el('div', 'empty', cfg.bzQuery ? `Nothing in the book matches "${cfg.bzQuery}".` : 'Pulling the bazaar book…'));
    return;
  }
  const t = el('table');
  t.innerHTML = '<thead><tr><th class="stc"></th><th>Product</th><th class="r">Buy</th><th class="r">Sell</th><th class="r">Δ</th><th class="r">Spread</th></tr></thead>';
  const tb = el('tbody');
  for (const b of r.rows) {
    const tr = el('tr');
    if (feed.item === b.id) tr.className = 'sel';
    const c1 = el('td', 'name');
    c1.appendChild(el('div', null, b.id));
    c1.appendChild(el('div', 'sub',
      `${fmt(b.buyOrders)} buy / ${fmt(b.sellOffers)} sell orders · vol ${fmt(b.sellVol)}/wk · insta ${fmt(b.instantBuy)}/${fmt(b.instantSell)}`));
    tr.append(starCell(b.id, b.id), c1, el('td', 'r num', fmt(b.buy)), el('td', 'r num', fmt(b.sell)));
    // Price movement. A blank means we do not have an hour of samples for it
    // yet - better than printing 0.0% and calling it flat.
    const cd = el('td', 'r num');
    if (b.chg1h == null) {
      cd.innerHTML = '<span class="muted">—</span>';
      cd.title = 'not enough samples yet for an hourly change';
    } else {
      cd.innerHTML = `<span class="${b.chg1h >= 0 ? 'pos' : 'neg'}">${pct(b.chg1h)}</span>`
        + (b.chg24h == null ? '<div class="sub">1h</div>' : `<div class="sub">1h · 24h ${pct(b.chg24h)}</div>`);
    }
    tr.appendChild(cd);
    const c4 = el('td', 'r num');
    c4.innerHTML = `${fmt(b.spread)}<div class="sub">${b.spreadPct.toFixed(1)}%</div>`;
    tr.appendChild(c4);
    tr.onclick = () => ctx.openChart(b.id, b.id);
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
};
  const render = () => {
  const host = ctx.host;
  const browsing = cfg.bzMode === 'browse';
  ctx.search.style.display = browsing ? 'block' : 'none';
  ctx.sortSeg.style.display = browsing ? 'flex' : 'none';
  if (cfg.bzMode === 'browse') return renderBook();
  const rows = feed.bazaar[cfg.bzMode] || [];
  host.innerHTML = '';
  if (!rows.length) { host.appendChild(el('div', 'empty', 'Nothing clearing your thresholds right now.')); return; }
  const craft = cfg.bzMode === 'crafts';
  const t = el('table');
  t.innerHTML = `<thead><tr><th class="stc"></th><th>Product</th><th class="r">${craft ? 'Cost' : 'Buy'}</th><th class="r">${craft ? 'Revenue' : 'Sell'}</th><th class="r">Profit</th></tr></thead>`;
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const c1 = el('td'); c1.className = 'name';
    c1.appendChild(el('div', null, r.id));
    c1.appendChild(el('div', 'sub', craft ? `${r.qty}x ${r.input} · ${r.crafts}/hr` : `${r.units}/hr · vol ${fmt(r.weeklyVolume)}`));
    tr.append(starCell(r.id, r.id), c1,
      el('td', 'r num', fmt(craft ? r.costPerCraft : r.buyAt)),
      el('td', 'r num', fmt(craft ? r.revenuePerCraft : r.sellAt)));
    const c4 = el('td', 'r num');
    c4.innerHTML = `<span class="pos">+${fmt(r.profit)}</span><div class="sub">${craft ? r.marginPct : r.spreadPct}%</div>`;
    tr.appendChild(c4);
    tr.onclick = () => ctx.openChart(r.id, r.id);
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
};
  render();
  return { refresh: render };
}

export function overviewPanel(host, view, ws) {
  const cfg = view.state;
  const { bar, body } = shell(host);
  const ctx = {
    host: body, ws, view,
    openChart: (key, label) => ws.open('chart', { key, label: label || key }),
    refreshAll: () => ws.refreshAll(),
    setTitle: (t) => ws.setViewState(view.id, { label: t }),
  };
  cfg.ovMode = cfg.ovMode || 'movers';
  seg(bar, [['movers', 'ah movers'], ['bz', 'bz movers'], ['volume', 'volume'], ['spreads', 'spreads']],
    cfg.ovMode, (v) => { cfg.ovMode = v; ws.setViewState(view.id, { ovMode: v }); render(); });

  const render = async () => {
  const host = ctx.host;
  const data = await fetch('/api/overview?since=' + 6 * 3600e3).then(r => r.json()).catch(() => null);
  host.innerHTML = '';
  if (!data) { host.appendChild(el('div', 'empty', 'Overview unavailable.')); return; }

  if (cfg.ovMode === 'movers') {
    if (!data.movers.length) { host.appendChild(el('div', 'empty', 'Needs a few snapshots of history first.')); return; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Item</th><th class="r">Was</th><th class="r">Now</th><th class="r">6h</th></tr></thead>';
    const tb = el('tbody');
    for (const m of data.movers) {
      const tr = el('tr');
      tr.append(starCell(m.key, m.key), el('td', 'name', m.key), el('td', 'r num', fmt(m.then_price)), el('td', 'r num', fmt(m.now_price)));
      const c = el('td', 'r num ' + (m.pct >= 0 ? 'pos' : 'neg'), pct(m.pct));
      tr.appendChild(c);
      tr.onclick = () => ctx.openChart(m.key, m.key);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else if (cfg.ovMode === 'bz') {
    if (!data.bzMovers || !data.bzMovers.length) { host.appendChild(el('div', 'empty', 'Needs a few bazaar snapshots first.')); return; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Product</th><th class="r">Was</th><th class="r">Now</th><th class="r">6h</th></tr></thead>';
    const tb = el('tbody');
    for (const m of data.bzMovers) {
      const tr = el('tr');
      tr.append(starCell(m.product, m.product), el('td', 'name', m.product), el('td', 'r num', fmt(m.then_price)), el('td', 'r num', fmt(m.now_price)));
      tr.appendChild(el('td', 'r num ' + (m.pct >= 0 ? 'pos' : 'neg'), pct(m.pct)));
      tr.onclick = () => ctx.openChart(m.product, m.product);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else if (cfg.ovMode === 'volume') {
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Item</th><th class="r">Sales</th><th class="r">Avg</th><th class="r">Coins</th></tr></thead>';
    const tb = el('tbody');
    for (const v of data.volume) {
      const tr = el('tr');
      tr.append(starCell(v.key, v.key), el('td', 'name', v.key), el('td', 'r num', v.sales), el('td', 'r num', fmt(v.avg)), el('td', 'r num', fmt(v.coins)));
      tr.onclick = () => ctx.openChart(v.key, v.key);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else {
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Product</th><th class="r">Spread</th><th class="r">Per unit</th><th class="r">Vol</th></tr></thead>';
    const tb = el('tbody');
    for (const s of data.spreads) {
      const tr = el('tr');
      tr.append(starCell(s.id, s.id), el('td', 'name', s.id), el('td', 'r num pos', s.spreadPct + '%'),
        el('td', 'r num', fmt(s.perUnit)), el('td', 'r num', fmt(s.weeklyVolume)));
      tr.onclick = () => ctx.openChart(s.id, s.id);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  }
};

  render();
  return { refresh: render };
}

export function chartPanel(host, view, ws) {
  const cfg = view.state;
  cfg.range = cfg.range || '24h';
  const { bar, body } = shell(host);
  const ctx = { host: body, ws, view,
    openChart: (k, l) => ws.open('chart', { key: k, label: l || k }),
    refreshAll: () => ws.refreshAll(),
    setTitle: (t) => { if (t && t !== cfg.label) ws.setViewState(view.id, { label: t }); } };

  seg(bar, [['1h', '1h'], ['6h', '6h'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['all', 'all']],
    cfg.range, (v) => { cfg.range = v; ws.setViewState(view.id, { range: v }); render(); });

  const render = async () => {
    const key = cfg.key;
    const label = cfg.label || cfg.key;
    if (!key) {
      body.textContent = '';
      body.appendChild(el('div', 'empty', 'Click any row in another panel to chart it here.'));
      return;
    }

  feed.item = key;
  ctx.setTitle(label || key);
  const host = ctx.host;
  host.innerHTML = '<div class="empty">Loading…</div>';
  const d = await fetch(`/api/item?key=${encodeURIComponent(key)}&range=${cfg.range}`).then(r => r.json()).catch(() => null);
  host.innerHTML = '';
  if (!d) { host.appendChild(el('div', 'empty', 'Could not load that item.')); return; }

  const cur = d.current;
  const bz = d.bzCurrent;
  const hero = el('div', 'hero');
  if (cur) {
    hero.innerHTML = `<span class="big">${fmt(cur.lowest)}</span>
      <span class="lbl">lowest BIN${cur.second ? ` · 2nd ${fmt(cur.second)}` : ''} · ${cur.depth} listed</span>`;
  } else if (bz) {
    const spread = bz.sell_order - bz.buy_order;
    hero.innerHTML = `<span class="big">${fmt(bz.sell_order)}</span>
      <span class="lbl">bazaar sell order · buy ${fmt(bz.buy_order)} · spread ${fmt(spread)}
      (${bz.buy_order ? ((spread / bz.buy_order) * 100).toFixed(1) : '0'}%)</span>`;
  } else if (d.ref && d.ref.median) {
    hero.innerHTML = `<span class="big">${fmt(d.ref.median)}</span>
      <span class="lbl">typical sale price · not listed right now</span>`;
  } else {
    hero.innerHTML = '<span class="big">—</span><span class="lbl">nothing listed, and no sale history for it</span>';
  }
  if (d.kind) hero.appendChild(el('span', 'kindtag ' + d.kind, d.kind === 'both' ? 'AH + BZ' : d.kind.toUpperCase()));
  const watch = el('button', 'act', feed.watchlist.some(w => w.key === key) ? 'Unwatch' : 'Watch');
  watch.onclick = () => toggleWatch(key, label);
  hero.appendChild(watch);
  host.appendChild(hero);

  // What this item normally goes for, and where the chart below came from.
  // Hypixel serves no history at all, so anything older than this tab is
  // Coflnet's archive - say so rather than letting it look like ours.
  if (d.ref || (d.history && (d.history.ah !== 'none' || d.history.bz !== 'none'))) {
    const ctx = el('div', 'mini');
    const bits = [];
    if (d.ref) {
      bits.push(`<span class="chip">typical <b>${fmt(d.ref.median)}</b></span>`);
      if (d.ref.mean) bits.push(`<span class="chip">mean <b>${fmt(d.ref.mean)}</b></span>`);
      if (d.ref.min) bits.push(`<span class="chip">low <b>${fmt(d.ref.min)}</b></span>`);
      if (d.ref.max) bits.push(`<span class="chip">high <b>${fmt(d.ref.max)}</b></span>`);
      if (d.ref.volume) bits.push(`<span class="chip">vol <b>${fmt(d.ref.volume)}</b></span>`);
    }
    const src = (d.history && (d.history.ah !== 'none' ? d.history.ah : d.history.bz)) || 'none';
    if (src !== 'none') {
      bits.push(`<span class="chip src" title="Hypixel publishes no price history; anything older than this tab comes from Coflnet's public archive">history <b>${src}</b></span>`);
    }
    ctx.innerHTML = bits.join('');
    host.appendChild(ctx);
  }

  // Only draw the auction panel if the item is actually on the auction house -
  // a bazaar-only product should not get an empty AH chart above its book.
  if (d.bin.length || d.sales.length) {
    const wrap = el('div', 'chartwrap');
    host.appendChild(wrap);
    lineChart(wrap, [
      { label: 'lowest BIN', color: CSS('--series-1'), area: true, points: d.bin.map(r => [r.t, r.low]).filter(p => p[1] > 0) },
      { label: 'sold price', color: CSS('--series-3'), points: d.sales.map(r => [r.t, r.avg]).filter(p => p[1] > 0) },
    ], { height: 200 });
  }
  // The numbers, above the charts. A chart shows you a shape; these answer the
  // questions the shape does not - what the edge is after tax, how hard the
  // thing moves, how long you would wait.
  const priceSeries = d.bazaar.length
    ? d.bazaar.map(r => [r.t, r.sell]).filter(p => p[1] > 0)
    : d.bin.map(r => [r.t, r.low]).filter(p => p[1] > 0);
  if (d.book) bazaarStats(host, d, priceSeries);
  else auctionStats(host, d, priceSeries);

  // Price first, and big. This is a market terminal - the question is what the
  // thing costs and where it has been, not how many of them changed hands.
  if (d.bazaar.length) {
    const bw = el('div', 'chartwrap');
    host.appendChild(bw);
    lineChart(bw, [
      // Both series are in OUR convention: buy = the bid side (where you place
      // a buy order), sell = the ask side (where you list a sell offer).
      { label: 'sell offer (ask)', color: CSS('--series-2'), points: d.bazaar.map(r => [r.t, r.sell]).filter(p => p[1] > 0) },
      { label: 'buy order (bid)', color: CSS('--series-1'), points: d.bazaar.map(r => [r.t, r.buy]).filter(p => p[1] > 0) },
    ], { height: 200 });

    // High, low and spread over whatever the chart is actually showing.
    const asks = d.bazaar.map(r => r.sell).filter(v => v > 0);
    const bids = d.bazaar.map(r => r.buy).filter(v => v > 0);
    if (asks.length && bids.length) {
      const sp = asks[asks.length - 1] - bids[bids.length - 1];
      const rng = el('div', 'mini');
      rng.innerHTML = `<span class="chip">ask high <b>${fmt(Math.max(...asks))}</b></span>
        <span class="chip">ask low <b>${fmt(Math.min(...asks))}</b></span>
        <span class="chip">bid high <b>${fmt(Math.max(...bids))}</b></span>
        <span class="chip">bid low <b>${fmt(Math.min(...bids))}</b></span>
        <span class="chip">spread now <b>${fmt(sp)}</b> (${bids.at(-1) ? ((sp / bids.at(-1)) * 100).toFixed(1) : '0'}%)</span>`;
      host.appendChild(rng);
    }
  }
  // How many orders sit on each side, over time. Order count moving while price
  // does not is the wall being built or pulled, which is the thing you want to
  // catch before it moves the price.
  if (d.orders && d.orders.length >= 2) {
    const ow = el('div', 'chartwrap');
    host.appendChild(ow);
    lineChart(ow, [
      { label: 'buy orders', color: CSS('--series-1'), points: d.orders.map(r => [r.t, r.buyOrders]) },
      { label: 'sell offers', color: CSS('--series-2'), points: d.orders.map(r => [r.t, r.sellOffers]) },
    ], { height: 120, yFmt: (n) => Math.round(n).toLocaleString() });
  } else if (d.book) {
    const note = el('div', 'mini');
    note.innerHTML = '<span class="chip">order counts over time start collecting once this tab has run a few minutes</span>';
    host.appendChild(note);
  }

  // Sales-per-bucket is an auction-house statistic. On a bazaar product it is
  // both empty and beside the point, and it was crowding out the price chart.
  if (d.sales.length && d.kind !== 'bz') {
    const vw = el('div', 'chartwrap');
    host.appendChild(vw);
    barChart(vw, d.sales.map(r => [r.t, r.n]), { color: CSS('--series-3'), yFmt: (n) => Math.round(n), label: 'auctions sold per bucket' });
  }

  if (bz) {
    const bzm = el('div', 'mini');
    bzm.innerHTML = `<span class="chip">insta buy <b>${fmt(bz.instant_buy)}</b></span>
      <span class="chip">insta sell <b>${fmt(bz.instant_sell)}</b></span>
      ${bz.buy_orders != null ? `<span class="chip">buy orders <b>${fmt(bz.buy_orders)}</b></span>` : ''}
      ${bz.sell_offers != null ? `<span class="chip">sell offers <b>${fmt(bz.sell_offers)}</b></span>` : ''}
      <span class="chip">buy vol/wk <b>${fmt(bz.buy_vol_week)}</b></span>
      <span class="chip">sell vol/wk <b>${fmt(bz.sell_vol_week)}</b></span>`;
    host.appendChild(bzm);
  }

  if (d.depth) ladderView(host, d.depth, 'Order book');
  if (d.wall) wallView(host, d.wall);

  const sales = d.recentSales;
  // the AH sales summary is meaningless for a bazaar-only product
  const mini = el('div', 'mini');
  if (!sales.length && d.kind === 'bz') {
    // nothing to say - the bazaar chips above already cover it
  } else if (sales.length) {
    const avg = sales.reduce((a, s) => a + s.price, 0) / sales.length;
    mini.innerHTML = `<span class="chip">recent sales <b>${sales.length}</b></span>
      <span class="chip">avg <b>${fmt(avg)}</b></span>
      <span class="chip">last <b>${fmt(sales[0].price)}</b> ${ago(sales[0].ts)} ago</span>`;
  } else {
    mini.innerHTML = '<span class="chip">no sales recorded in the window</span>';
  }
  host.appendChild(mini);

  if (d.flips.length) {
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Flips seen</th><th class="r">Buy</th><th class="r">Profit</th><th class="r">When</th></tr></thead>';
    const tb = el('tbody');
    for (const f of d.flips) {
      const tr = el('tr');
      tr.append(el('td', 'name', f.strategy), el('td', 'r num', fmt(f.price)),
        el('td', 'r num pos', '+' + fmt(f.profit)), el('td', 'r num sub', ago(f.ts)));
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  }
  // The lists highlight whichever row is being charted, so they repaint - but
  // named, not "everything", because everything includes this panel.
  ws.refresh('flips'); ws.refresh('bazaar'); ws.refresh('overview');
  };
  render();
  return { refresh: render };
}

export function watchlistPanel(host, view, ws) {
  const cfg = view.state;
  const { bar, body } = shell(host);
  const ctx = {
    host: body, ws, view,
    openChart: (key, label) => ws.open('chart', { key, label: label || key }),
    refreshAll: () => ws.refreshAll(),
    setTitle: (t) => ws.setViewState(view.id, { label: t }),
  };

  const render = async () => {
  const host = ctx.host;
  const r = await fetch('/api/tickers').then(r => r.json()).catch(() => ({ tickers: [] }));
  feed.watchlist = r.tickers || [];
  feed.watchKeys = new Set(feed.watchlist.map(w => w.key));
  host.innerHTML = '';
  if (!feed.watchlist.length) { host.appendChild(el('div', 'empty', 'Open an item and hit Watch.')); return; }

  for (const w of feed.watchlist) {
    const card = el('div', 'ticker' + (w.hit ? ' hit' : ''));
    const up = (w.changePct ?? 0) >= 0;
    const colour = w.spark.length < 2 ? CSS('--text-muted') : up ? CSS('--good') : CSS('--critical');

    const top = el('div', 'trow');
    const nm = el('div', 'tname');
    nm.appendChild(document.createTextNode(w.label || w.key));
    if (w.kind !== 'none') nm.appendChild(el('span', 'kindtag ' + w.kind, w.kind.toUpperCase()));
    top.appendChild(nm);
    top.appendChild(sparkline(w.spark, { color: colour }));
    const px = el('div', 'tprice');
    px.appendChild(el('div', 'num big', w.price == null ? '—' : fmt(w.price)));
    // Both sides, labelled for the market it is: bid/ask on the bazaar, the
    // cheapest listing and the one you would undercut on the auction house.
    if (w.buy != null || w.sell != null) {
      const sides = el('div', 'num sub tsides');
      sides.innerHTML = w.kind === 'bz'
        ? `buy <b>${fmt(w.buy)}</b> · sell <b>${fmt(w.sell)}</b>${w.spread != null && w.buy ? ` · ${((w.spread / w.buy) * 100).toFixed(1)}%` : ''}`
        : `low <b>${fmt(w.buy)}</b>${w.sell ? ` · next <b>${fmt(w.sell)}</b>` : ''}${w.depth ? ` · ${w.depth} listed` : ''}`;
      px.appendChild(sides);
    }
    // Say which window the change is over. A sparkline drawn from the archive
    // spans a day; one drawn from what this tab has collected spans six hours.
    const win = w.source === 'coflnet' ? '24h' : '6h';
    px.appendChild(el('div', 'num sub ' + (up ? 'pos' : 'neg'),
      w.changePct == null ? 'no history yet' : `${up ? '+' : ''}${w.changePct.toFixed(1)}% ${win}`));
    top.appendChild(px);
    const x = el('button', 'act', '×');
    x.onclick = (e) => { e.stopPropagation(); toggleWatch(w.key); };
    top.appendChild(x);
    card.appendChild(top);

    // thresholds, editable in place
    const th = el('div', 'trow thr');
    for (const field of ['below', 'above']) {
      const lbl = el('span', 'sub', field);
      const inp = document.createElement('input');
      inp.className = 'thr-in num';
      inp.value = w[field] || '';
      inp.placeholder = '—';
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = async () => {
        const v = Number(String(inp.value).replace(/[^0-9.]/g, '')) || null;
        await fetch('/api/watchlist', { method: 'POST',
          body: JSON.stringify({ key: w.key, label: w.label, below: field === 'below' ? v : w.below, above: field === 'above' ? v : w.above }) });
        render();
      };
      th.append(lbl, inp);
    }
    card.appendChild(th);
    card.onclick = () => ctx.openChart(w.key, w.label);
    host.appendChild(card);
  }
};

  render();
  return { refresh: render };
}

export function alertsPanel(host, view, ws) {
  const cfg = view.state;
  const { bar, body } = shell(host);
  const ctx = {
    host: body, ws, view,
    openChart: (key, label) => ws.open('chart', { key, label: label || key }),
    refreshAll: () => ws.refreshAll(),
    setTitle: (t) => ws.setViewState(view.id, { label: t }),
  };

  const render = async () => {
  const host = ctx.host;
  host.innerHTML = '';
  if (!feed.alerts.length) { host.appendChild(el('div', 'empty', 'Nothing yet.')); return; }
  const icon = { flip: '↑', watch: '◆', unusual: '!' };
  for (const a of feed.alerts.slice(0, 80)) {
    const d = el('div', 'alert ' + a.kind);
    d.appendChild(el('div', 'ic', icon[a.kind] || '·'));
    const tx = el('div', 'tx');
    tx.appendChild(el('div', 'tt', a.title));
    tx.appendChild(el('div', 'sub', `${a.detail || ''} · ${ago(a.ts)} ago`));
    d.appendChild(tx);
    if (a.key) d.onclick = () => ctx.openChart(a.key, a.key);
    host.appendChild(d);
  }
};

  render();
  return { refresh: render };
}

// --- order book ------------------------------------------------------------
// The depth ladder as a panel in its own right, pinned to one product, so you
// can keep a book open while charting something else.
export function bookPanel(host, view, ws) {
  const cfg = view.state;
  const { bar, body } = shell(host);

  const pick = el('input', 'pfilter');
  pick.placeholder = 'product id, e.g. COAL';
  pick.value = cfg.product || '';
  pick.onchange = () => {
    cfg.product = pick.value.trim().toUpperCase();
    ws.setViewState(view.id, { product: cfg.product, label: cfg.product || 'Order book' });
    render();
  };
  bar.appendChild(pick);

  const render = async () => {
    body.textContent = '';
    if (!cfg.product) {
      body.appendChild(el('div', 'empty', 'Type a bazaar product id above, or click one in the bazaar book.'));
      return;
    }
    const d = await fetch('/api/depth?product=' + encodeURIComponent(cfg.product)).then(r => r.json()).catch(() => null);
    if (!d || !d.live) {
      body.appendChild(el('div', 'empty', `Nothing in the book for "${cfg.product}".`));
      return;
    }
    const hero = el('div', 'hero');
    const bid = d.live.bids && d.live.bids[0] ? d.live.bids[0].price : 0;
    const ask = d.live.asks && d.live.asks[0] ? d.live.asks[0].price : 0;
    hero.innerHTML = `<span class="big">${fmt(ask)}</span>
      <span class="lbl">ask · bid ${fmt(bid)} · spread ${fmt(ask - bid)}${bid ? ` (${(((ask - bid) / bid) * 100).toFixed(1)}%)` : ''}</span>`;
    body.appendChild(hero);
    ladderView(body, d.live, cfg.product);
  };
  render();
  return { refresh: render };
}

// --- sold feed -------------------------------------------------------------
// A tape of what actually changed hands, newest first. The flip board says what
// something is worth; this says what somebody actually paid.
export function soldPanel(host, view, ws) {
  const { bar, body } = shell(host);
  const cfg = view.state;
  cfg.minPrice = cfg.minPrice || 0;
  seg(bar, [[0, 'all'], [1000000, '1m+'], [10000000, '10m+'], [100000000, '100m+']], cfg.minPrice,
    (v) => { cfg.minPrice = v; ws.setViewState(view.id, { minPrice: v }); render(); });

  const render = async () => {
    const r = await fetch('/api/sold?limit=200').then(x => x.json()).catch(() => null);
    body.textContent = '';
    const rows = (r && r.sales || []).filter(s => s.price >= cfg.minPrice);
    if (!rows.length) {
      body.appendChild(el('div', 'empty', r ? 'Nothing has sold above that yet — the feed only covers the last hour.' : 'Waiting for the sold feed…'));
      return;
    }
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Sold</th><th class="r">Price</th><th class="r">When</th></tr></thead>';
    const tb = el('tbody');
    for (const s of rows.slice(0, 150)) {
      const tr = el('tr');
      const c1 = el('td', 'name');
      c1.appendChild(el('div', null, s.name || s.key));
      if (s.name && s.key && s.name !== s.key) c1.appendChild(el('div', 'sub', s.key));
      tr.append(starCell(s.key, s.name || s.key), c1,
        el('td', 'r num', fmt(s.price)), el('td', 'r num sub', ago(s.at)));
      tr.onclick = () => ws.open('chart', { key: s.key, label: s.name || s.key });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);
  };
  render();
  return { refresh: render };
}

// --- engine log ------------------------------------------------------------
// Snapshot timings, decode counts, and whatever went wrong. Here so that when
// something looks off you can find out why without opening devtools.
export function logPanel(host, view, ws) {
  const { bar, body } = shell(host);
  const cfg = view.state;
  cfg.level = cfg.level || 'all';
  seg(bar, [['all', 'all'], ['warn', 'warnings'], ['error', 'errors']], cfg.level,
    (v) => { cfg.level = v; ws.setViewState(view.id, { level: v }); render(); });

  const render = () => {
    const rows = feed.log.filter(l => cfg.level === 'all'
      || (cfg.level === 'warn' && l.level !== 'info')
      || (cfg.level === 'error' && l.level === 'error'));
    body.textContent = '';
    if (!rows.length) { body.appendChild(el('div', 'empty', 'Nothing logged yet.')); return; }
    const box = el('div', 'logbox');
    // Newest at the top: you are looking for what just happened.
    for (const l of rows.slice(-400).reverse()) {
      const line = el('div', 'logline ' + l.level);
      line.appendChild(el('span', 'logt', new Date(l.at).toLocaleTimeString()));
      line.appendChild(el('span', 'logm', l.msg));
      box.appendChild(line);
    }
    body.appendChild(box);
  };
  render();
  return { refresh: render };
}

// --- crafts ----------------------------------------------------------------
// Every bazaar conversion, priced, whether or not it makes money today. The
// bazaar panel's "crafts" mode only shows what clears a threshold, which is the
// wrong shape for something you sit and watch: a conversion 2% underwater is
// worth knowing about, and one deeply underwater tells you the input is what
// is in demand, not the output.
export function craftsPanel(host, view, ws) {
  const cfg = view.state;
  cfg.sort = cfg.sort || 'hourly';
  cfg.show = cfg.show || 'profitable';
  const { bar, body } = shell(host);

  seg(bar, [['profitable', 'profitable'], ['all', 'all']], cfg.show,
    (v) => { cfg.show = v; ws.setViewState(view.id, { show: v }); render(); });
  seg(bar, [['hourly', '/hour'], ['per', '/craft'], ['margin', 'margin'], ['volume', 'volume']], cfg.sort,
    (v) => { cfg.sort = v; ws.setViewState(view.id, { sort: v }); render(); }).classList.add('sub');

  const search = el('input', 'pfilter');
  search.placeholder = 'filter by item…';
  search.value = cfg.q || '';
  let timer = null;
  search.oninput = () => {
    cfg.q = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => { ws.setViewState(view.id, { q: cfg.q }); render(); }, 180);
  };
  bar.appendChild(search);

  const render = async () => {
    const r = await fetch(`/api/crafts?sort=${cfg.sort}&q=${encodeURIComponent(cfg.q || '')}`)
      .then(x => x.json()).catch(() => null);
    body.textContent = '';
    if (!r) { body.appendChild(el('div', 'empty', 'Could not load the craft table.')); return; }
    if (r.waiting) { body.appendChild(el('div', 'empty', 'Waiting for the first bazaar poll…')); return; }

    const rows = cfg.show === 'all' ? r.rows : r.rows.filter(x => x.profitable);
    if (!rows.length) {
      body.appendChild(el('div', 'empty', cfg.q
        ? `No conversion matches "${cfg.q}".`
        : 'Nothing is profitable to craft at the moment. Switch to "all" to see how far off each one is.'));
      return;
    }

    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Craft</th><th class="r">Cost</th>'
      + '<th class="r">Sells for</th><th class="r">Per craft</th><th class="r">Per hour</th></tr></thead>';
    const tb = el('tbody');
    for (const c of rows.slice(0, 200)) {
      const tr = el('tr');
      if (feed.item === c.id) tr.className = 'sel';

      const c1 = el('td', 'name');
      c1.appendChild(el('div', null, c.id));
      // The recipe and the bottleneck. "You cannot get the input" and "nobody is
      // buying the output" are different problems with different answers.
      c1.appendChild(el('div', 'sub',
        `${fmt(c.qty)} × ${c.input} @ ${exact(c.inputPrice)} · capped by ${c.limitedBy}`));

      const cost = el('td', 'r num', fmt(c.costPerCraft));
      const rev = el('td', 'r num');
      rev.innerHTML = `${fmt(c.revenuePerCraft)}<div class="sub">after ${fmt(c.tax)} tax</div>`;

      const per = el('td', 'r num');
      per.innerHTML = `<span class="${c.perCraft >= 0 ? 'pos' : 'neg'}">${c.perCraft >= 0 ? '+' : ''}${fmt(c.perCraft)}</span>`
        + `<div class="sub">${c.marginPct >= 0 ? '+' : ''}${c.marginPct.toFixed(1)}%</div>`;

      const hr = el('td', 'r num');
      hr.innerHTML = c.crafts
        ? `<span class="${c.hourly >= 0 ? 'pos' : 'neg'}">${c.hourly >= 0 ? '+' : ''}${fmt(c.hourly)}</span>`
          + `<div class="sub">${fmt(c.crafts)} crafts</div>`
        : '<span class="muted">—</span><div class="sub">no throughput</div>';

      tr.append(starCell(c.id, c.id), c1, cost, rev, per, hr);
      tr.onclick = () => ws.open('chart', { key: c.id, label: c.id });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);

    const note = el('div', 'mini');
    const good = r.rows.filter(x => x.profitable).length;
    note.innerHTML = `<span class="chip">${good} of ${r.rows.length} conversions profitable</span>`
      + '<span class="chip" title="Input bought by placing an order a tick above the best bid; output sold a tick under the best ask, net of tax. Pricing the input at the instant-buy price instead would make almost every craft look dead.">priced as maker on both legs</span>';
    body.appendChild(note);
  };

  render();
  return { refresh: render };
}

// --- registry --------------------------------------------------------------
// title() is what the tab says. Keep it short - tabs get narrow.
export const REGISTRY = {
  flips:     { label: 'Flips',      title: () => 'Flips',        mount: flipsPanel },
  chart:     { label: 'Chart',      title: (s) => s.label || s.key || 'Chart', mount: chartPanel },
  bazaar:    { label: 'Bazaar',     title: () => 'Bazaar',       mount: bazaarPanel },
  overview:  { label: 'Market',     title: () => 'Market',       mount: overviewPanel },
  watchlist: { label: 'Watchlist',  title: () => 'Watchlist',    mount: watchlistPanel },
  alerts:    { label: 'Alerts',     title: () => 'Alerts',       mount: alertsPanel },
  book:      { label: 'Order book', title: (s) => s.product ? `Book ${s.product}` : 'Order book', mount: bookPanel },
  crafts:    { label: 'Crafts',     title: () => 'Crafts',       mount: craftsPanel },
  sold:      { label: 'Sold feed',  title: () => 'Sold',         mount: soldPanel },
  log:       { label: 'Engine log', title: () => 'Log',          mount: logPanel },
};
