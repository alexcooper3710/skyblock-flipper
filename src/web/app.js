'use strict';
// Must match API_VERSION in src/server/server.js. If the running server is
// older, say so loudly instead of rendering blank panels.
const API_VERSION = 3;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

const fmt = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};
const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(1) + '%';
// Ladder rungs differ by fractions of a coin; abbreviating them to "1.3k"
// throws away the only thing that makes a book a book.
const exact = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};
const CSS = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = { flips: [], bazaar: { orders: [], crafts: [] }, alerts: [], watchlist: [], watchKeys: new Set(), bzQuery: '',
  range: '24h', item: null, flipFilter: 'all', bzMode: 'browse', ovMode: 'movers', unseen: 0, phase: null, seed: null };

// ---------------------------------------------------------------- charts
// Hand-rolled SVG: no chart library to install, and nothing to break offline.
const SVG_NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs) => { const n = document.createElementNS(SVG_NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

function niceTicks(min, max, count = 4) {
  if (min === max) return [min];
  const span = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(span)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= span) || mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

// One shared time axis, one value axis. Never two y-scales on one plot.
function lineChart(host, series, { height = 190, yFmt = fmt } = {}) {
  const live = series.filter(s => s.points.length);
  if (!live.length) { host.appendChild(el('div', 'empty', 'No history in this range yet.')); return; }

  const W = Math.max(280, host.clientWidth || 420), H = height;
  const M = { t: 10, r: 54, b: 20, l: 8 };
  const xs = live.flatMap(s => s.points.map(p => p[0]));
  const ys = live.flatMap(s => s.points.map(p => p[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.12; y0 -= pad; y1 += pad;
  const X = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
  const Y = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, height: H });

  const grid = mk('g', { class: 'grid' });
  const ticks = niceTicks(y0, y1, 4);
  for (const t of ticks) grid.appendChild(mk('line', { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t) }));
  svg.appendChild(grid);

  const axis = mk('g', { class: 'axis' });
  for (const t of ticks) {
    const tx = mk('text', { x: W - M.r + 6, y: Y(t) + 3.5 });
    tx.textContent = yFmt(t); axis.appendChild(tx);
  }
  const t0 = mk('text', { x: M.l, y: H - 5 }); t0.textContent = new Date(x0).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const t1 = mk('text', { x: W - M.r, y: H - 5, 'text-anchor': 'end' }); t1.textContent = new Date(x1).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  axis.appendChild(t0); axis.appendChild(t1);
  svg.appendChild(axis);

  for (const s of live) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    if (s.area) {
      const base = Y(y0);
      svg.appendChild(mk('path', { d: `${d}L${X(s.points.at(-1)[0])},${base}L${X(s.points[0][0])},${base}Z`, fill: s.color, class: 'area' }));
    }
    svg.appendChild(mk('path', { d, stroke: s.color, class: 'line' }));
    const last = s.points.at(-1);
    svg.appendChild(mk('circle', { cx: X(last[0]), cy: Y(last[1]), r: 4.5, fill: s.color, class: 'dot-end' }));
  }

  // crosshair + tooltip: an HTML chart is interactive by default
  const cross = mk('line', { class: 'crosshair', y1: M.t, y2: H - M.b, x1: 0, x2: 0, opacity: 0 });
  svg.appendChild(cross);
  const hit = mk('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  svg.appendChild(hit);
  const tip = $('tip');
  hit.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = (ev.clientX - box.left) * (W / box.width);
    const t = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('opacity', 1);
    let html = `<div class="th">${new Date(t).toLocaleString()}</div>`;
    for (const s of live) {
      let best = s.points[0];
      for (const p of s.points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      html += `<div class="row"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></i>${s.label}</span><span>${yFmt(best[1])}</span></div>`;
    }
    tip.innerHTML = html; tip.style.display = 'block';
    tip.style.left = Math.min(window.innerWidth - 170, ev.clientX + 14) + 'px';
    tip.style.top = (ev.clientY + 14) + 'px';
  });
  hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; cross.setAttribute('opacity', 0); });

  host.appendChild(svg);
  if (live.length >= 2) {
    const lg = el('div', 'legend');
    for (const s of live) {
      const w = el('span'); w.innerHTML = `<i style="background:${s.color}"></i>${s.label}`;
      lg.appendChild(w);
    }
    host.appendChild(lg);
  }
}

function barChart(host, points, { height = 74, color, yFmt = fmt, label = 'volume' } = {}) {
  if (!points.length) return;
  const W = Math.max(280, host.clientWidth || 420), H = height;
  const M = { t: 8, r: 54, b: 14, l: 8 };
  const x0 = Math.min(...points.map(p => p[0])), x1 = Math.max(...points.map(p => p[0]));
  const ymax = Math.max(...points.map(p => p[1])) || 1;
  const X = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  // 2px surface gap between adjacent bars
  const bw = Math.max(1.5, (W - M.l - M.r) / points.length - 2);
  for (const p of points) {
    const h = (p[1] / ymax) * (H - M.t - M.b);
    svg.appendChild(mk('rect', { x: X(p[0]) - bw / 2, y: H - M.b - h, width: bw, height: Math.max(1, h), rx: Math.min(2, bw / 2), fill: color }));
  }
  const ax = mk('g', { class: 'axis' });
  const tmax = mk('text', { x: W - M.r + 6, y: M.t + 4 }); tmax.textContent = yFmt(ymax);
  const lab = mk('text', { x: M.l, y: H - 3 }); lab.textContent = label;
  ax.appendChild(tmax); ax.appendChild(lab); svg.appendChild(ax);
  host.appendChild(svg);
}

// A ticker needs a shape, not just a name. One series, so no legend - the row
// label names it (dataviz rule); the signed number beside it carries direction
// so colour is never doing the job alone.
function sparkline(points, { w = 96, h = 26, color } = {}) {
  const svg = mk('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  if (points.length < 2) return svg;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const X = v => ((v - x0) / (x1 - x0 || 1)) * (w - 4) + 2;
  const Y = v => h - 3 - ((v - y0) / (y1 - y0)) * (h - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  svg.appendChild(mk('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  const last = points.at(-1);
  svg.appendChild(mk('circle', { cx: X(last[0]), cy: Y(last[1]), r: 2.5, fill: color }));
  return svg;
}

// The order book, with the bar behind each row sized by cumulative volume - so
// you can see where the wall actually is rather than how many orders exist.
function ladderView(host, depth, title) {
  if (!depth || (!depth.bids.length && !depth.asks.length)) return;
  const wrap = el('div', 'ladder');
  wrap.appendChild(el('div', 'lhead', title));
  const cum = (rows) => { let t = 0; return rows.map(r => ({ ...r, cum: (t += r.price * r.amount) })); };
  const bids = cum(depth.bids), asks = cum(depth.asks);
  const max = Math.max(bids.at(-1)?.cum || 0, asks.at(-1)?.cum || 0) || 1;
  const grid = el('div', 'lgrid');

  const side = (rows, cls, colour, align) => {
    const col = el('div', 'lcol');
    for (const r of rows) {
      const row = el('div', 'lrow ' + cls);
      const bar = el('i');
      bar.style.width = ((r.cum / max) * 100).toFixed(1) + '%';
      bar.style.background = colour;
      row.appendChild(bar);
      const px = el('span', 'lp num', exact(r.price));
      const am = el('span', 'la num', fmt(r.amount));
      if (align === 'right') row.append(am, px); else row.append(px, am);
      row.title = `${exact(r.price)} × ${fmt(r.amount)} units · ${r.orders} order${r.orders === 1 ? '' : 's'} · ${fmt(r.price * r.amount)} coins`;
      col.appendChild(row);
    }
    return col;
  };
  grid.append(side(bids, 'bid', 'rgba(25,158,112,.22)', 'right'), side(asks, 'ask', 'rgba(217,89,38,.22)', 'left'));
  wrap.appendChild(grid);
  const lg = el('div', 'legend');
  lg.innerHTML = `<span><i style="background:var(--series-3)"></i>bids (you sell into)</span>
                  <span><i style="background:var(--series-2)"></i>asks (you buy from)</span>`;
  wrap.appendChild(lg);
  host.appendChild(wrap);
}

function wallView(host, wall) {
  if (!wall || !wall.prices.length) return;
  const wrap = el('div', 'ladder');
  wrap.appendChild(el('div', 'lhead', `BIN wall - ${wall.depth} listed`));
  const max = wall.prices.at(-1) || 1;
  const col = el('div', 'lcol');
  for (const price of wall.prices) {
    const row = el('div', 'lrow ask');
    const bar = el('i');
    bar.style.width = ((price / max) * 100).toFixed(1) + '%';
    bar.style.background = 'rgba(57,135,229,.22)';
    row.appendChild(bar);
    row.append(el('span', 'lp num', fmt(price)), el('span', 'la num', ''));
    col.appendChild(row);
  }
  wrap.appendChild(col);
  host.appendChild(wrap);
}

// Watching should be one click from wherever you spotted the thing, not a
// detour through the item page.
function watchStar(key, label) {
  const on = state.watchKeys.has(key);
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

// ---------------------------------------------------------------- panels
function renderFlips() {
  const host = $('flips');
  const rows = state.flipFilter === 'all' ? state.flips : state.flips.filter(f => f.strategy === state.flipFilter);
  host.innerHTML = '';
  if (!rows.length) {
    const p = state.phase;
    host.appendChild(el('div', 'empty',
      p && (p.code === 'first-snapshot' || p.code === 'seed') ? p.label
      : state.flipFilter !== 'all' ? 'No flips matching that filter right now.'
      : 'Nothing on the wall is under its own resale price right now. Rechecked every snapshot.'));
    return;
  }
  const t = el('table');
  t.innerHTML = '<thead><tr><th class="stc"></th><th>Item</th><th class="r">Buy</th><th class="r">Worth</th><th class="r">Profit</th></tr></thead>';
  const tb = el('tbody');
  for (const f of rows.slice(0, 120)) {
    const tr = el('tr');
    if (state.item === f.keyBase) tr.className = 'sel';
    const c1 = el('td'); c1.className = 'name';
    c1.appendChild(el('div', null, f.name));
    const sub = el('div', 'sub');
    sub.innerHTML = `<span class="tag ${f.strategy}">${f.strategy}</span>`
      + (f.isNew ? '<span class="tag new">new</span>' : '')
      + (f.seed ? '<span class="tag seed" title="from the collector snapshot - may already be gone">seed</span>' : '')
      + ` ${f.basis} · n=${f.samples} · ${ago(f.seenAt)}`;
    c1.appendChild(sub);
    const c2 = el('td', 'r num', fmt(f.price));
    const c3 = el('td', 'r num', fmt(f.value));
    const c4 = el('td', 'r num'); c4.innerHTML = `<span class="pos">+${fmt(f.profit)}</span><div class="sub">${f.marginPct}%</div>`;
    tr.append(starCell(f.keyBase, f.name), c1, c2, c3, c4);
    tr.onclick = () => { navigator.clipboard?.writeText(f.command); selectItem(f.keyBase, f.name); };
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
}

async function renderBazaarBook() {
  const host = $('bazaar');
  const r = await fetch('/api/bazaar?q=' + encodeURIComponent(state.bzQuery || '')).then(r => r.json()).catch(() => null);
  host.innerHTML = '';
  if (!r || !r.rows.length) {
    host.appendChild(el('div', 'empty', state.bzQuery ? `Nothing in the book matches "${state.bzQuery}".` : 'Pulling the bazaar book…'));
    return;
  }
  const t = el('table');
  t.innerHTML = '<thead><tr><th class="stc"></th><th>Product</th><th class="r">Buy</th><th class="r">Sell</th><th class="r">Spread</th></tr></thead>';
  const tb = el('tbody');
  for (const b of r.rows) {
    const tr = el('tr');
    if (state.item === b.id) tr.className = 'sel';
    const c1 = el('td', 'name');
    c1.appendChild(el('div', null, b.id));
    c1.appendChild(el('div', 'sub', `vol ${fmt(b.sellVol)}/wk · insta ${fmt(b.instantBuy)}/${fmt(b.instantSell)}`));
    tr.append(starCell(b.id, b.id), c1, el('td', 'r num', fmt(b.buy)), el('td', 'r num', fmt(b.sell)));
    const c4 = el('td', 'r num');
    c4.innerHTML = `${fmt(b.spread)}<div class="sub">${b.spreadPct.toFixed(1)}%</div>`;
    tr.appendChild(c4);
    tr.onclick = () => selectItem(b.id, b.id);
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
}

function renderBazaar() {
  const host = $('bazaar');
  $('bz-search').style.display = state.bzMode === 'browse' ? 'block' : 'none';
  if (state.bzMode === 'browse') return renderBazaarBook();
  const rows = state.bazaar[state.bzMode] || [];
  host.innerHTML = '';
  if (!rows.length) { host.appendChild(el('div', 'empty', 'Nothing clearing your thresholds right now.')); return; }
  const craft = state.bzMode === 'crafts';
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
    tr.onclick = () => selectItem(r.id, r.id);
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
}

async function renderOverview() {
  const host = $('overview');
  const data = await fetch('/api/overview?since=' + 6 * 3600e3).then(r => r.json()).catch(() => null);
  host.innerHTML = '';
  if (!data) { host.appendChild(el('div', 'empty', 'Overview unavailable.')); return; }

  if (state.ovMode === 'movers') {
    if (!data.movers.length) { host.appendChild(el('div', 'empty', 'Needs a few snapshots of history first.')); return; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Item</th><th class="r">Was</th><th class="r">Now</th><th class="r">6h</th></tr></thead>';
    const tb = el('tbody');
    for (const m of data.movers) {
      const tr = el('tr');
      tr.append(starCell(m.key, m.key), el('td', 'name', m.key), el('td', 'r num', fmt(m.then_price)), el('td', 'r num', fmt(m.now_price)));
      const c = el('td', 'r num ' + (m.pct >= 0 ? 'pos' : 'neg'), pct(m.pct));
      tr.appendChild(c);
      tr.onclick = () => selectItem(m.key, m.key);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else if (state.ovMode === 'bz') {
    if (!data.bzMovers || !data.bzMovers.length) { host.appendChild(el('div', 'empty', 'Needs a few bazaar snapshots first.')); return; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Product</th><th class="r">Was</th><th class="r">Now</th><th class="r">6h</th></tr></thead>';
    const tb = el('tbody');
    for (const m of data.bzMovers) {
      const tr = el('tr');
      tr.append(starCell(m.product, m.product), el('td', 'name', m.product), el('td', 'r num', fmt(m.then_price)), el('td', 'r num', fmt(m.now_price)));
      tr.appendChild(el('td', 'r num ' + (m.pct >= 0 ? 'pos' : 'neg'), pct(m.pct)));
      tr.onclick = () => selectItem(m.product, m.product);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else if (state.ovMode === 'volume') {
    const t = el('table');
    t.innerHTML = '<thead><tr><th class="stc"></th><th>Item</th><th class="r">Sales</th><th class="r">Avg</th><th class="r">Coins</th></tr></thead>';
    const tb = el('tbody');
    for (const v of data.volume) {
      const tr = el('tr');
      tr.append(starCell(v.key, v.key), el('td', 'name', v.key), el('td', 'r num', v.sales), el('td', 'r num', fmt(v.avg)), el('td', 'r num', fmt(v.coins)));
      tr.onclick = () => selectItem(v.key, v.key);
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
      tr.onclick = () => selectItem(s.id, s.id);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  }
}

async function selectItem(key, label) {
  state.item = key;
  $('item-title').textContent = label || key;
  const host = $('item');
  host.innerHTML = '<div class="empty">Loading…</div>';
  const d = await fetch(`/api/item?key=${encodeURIComponent(key)}&range=${state.range}`).then(r => r.json()).catch(() => null);
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
  } else {
    hero.innerHTML = '<span class="big">—</span><span class="lbl">no history stored for this item yet</span>';
  }
  if (d.kind) hero.appendChild(el('span', 'kindtag ' + d.kind, d.kind === 'both' ? 'AH + BZ' : d.kind.toUpperCase()));
  const watch = el('button', 'act', state.watchlist.some(w => w.key === key) ? 'Unwatch' : 'Watch');
  watch.onclick = () => toggleWatch(key, label);
  hero.appendChild(watch);
  host.appendChild(hero);

  // Only draw the auction panel if the item is actually on the auction house -
  // a bazaar-only product should not get an empty AH chart above its book.
  if (d.bin.length || d.sales.length) {
    const wrap = el('div', 'chartwrap');
    host.appendChild(wrap);
    lineChart(wrap, [
      { label: 'lowest BIN', color: CSS('--series-1'), area: true, points: d.bin.map(r => [r.t, r.low]) },
      { label: 'sold avg', color: CSS('--series-3'), points: d.sales.map(r => [r.t, r.avg]) },
    ]);
  }
  if (d.sales.length) {
    const vw = el('div', 'chartwrap');
    host.appendChild(vw);
    barChart(vw, d.sales.map(r => [r.t, r.n]), { color: CSS('--series-3'), yFmt: (n) => Math.round(n), label: 'sales per bucket' });
  }
  if (d.bazaar.length) {
    const bw = el('div', 'chartwrap');
    host.appendChild(bw);
    lineChart(bw, [
      { label: 'bz buy order', color: CSS('--series-1'), points: d.bazaar.map(r => [r.t, r.buy]) },
      { label: 'bz sell order', color: CSS('--series-2'), points: d.bazaar.map(r => [r.t, r.sell]) },
    ], { height: 140 });
  }

  if (bz) {
    const bzm = el('div', 'mini');
    bzm.innerHTML = `<span class="chip">insta buy <b>${fmt(bz.instant_buy)}</b></span>
      <span class="chip">insta sell <b>${fmt(bz.instant_sell)}</b></span>
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
  renderFlips();
}

async function renderWatchlist() {
  const host = $('watchlist');
  const r = await fetch('/api/tickers').then(r => r.json()).catch(() => ({ tickers: [] }));
  state.watchlist = r.tickers || [];
  state.watchKeys = new Set(state.watchlist.map(w => w.key));
  host.innerHTML = '';
  if (!state.watchlist.length) { host.appendChild(el('div', 'empty', 'Open an item and hit Watch.')); return; }

  for (const w of state.watchlist) {
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
    px.appendChild(el('div', 'num sub ' + (up ? 'pos' : 'neg'),
      w.changePct == null ? 'no data yet' : `${up ? '+' : ''}${w.changePct.toFixed(1)}% 6h`));
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
        renderWatchlist();
      };
      th.append(lbl, inp);
    }
    card.appendChild(th);
    card.onclick = () => selectItem(w.key, w.label);
    host.appendChild(card);
  }
}

function renderAlerts() {
  const host = $('alerts');
  host.innerHTML = '';
  if (!state.alerts.length) { host.appendChild(el('div', 'empty', 'Nothing yet.')); return; }
  const icon = { flip: '↑', watch: '◆', unusual: '!' };
  for (const a of state.alerts.slice(0, 80)) {
    const d = el('div', 'alert ' + a.kind);
    d.appendChild(el('div', 'ic', icon[a.kind] || '·'));
    const tx = el('div', 'tx');
    tx.appendChild(el('div', 'tt', a.title));
    tx.appendChild(el('div', 'sub', `${a.detail || ''} · ${ago(a.ts)} ago`));
    d.appendChild(tx);
    if (a.key) d.onclick = () => selectItem(a.key, a.key);
    host.appendChild(d);
  }
}

async function toggleWatch(key, label) {
  const on = state.watchlist.some(w => w.key === key);
  const r = on
    ? await fetch('/api/watchlist?key=' + encodeURIComponent(key), { method: 'DELETE' }).then(r => r.json())
    : await fetch('/api/watchlist', { method: 'POST', body: JSON.stringify({ key, label }) }).then(r => r.json());
  state.watchKeys = new Set((r.watchlist || []).map(w => w.key));
  await renderWatchlist();
  // repaint whatever is on screen so every star reflects the new state
  renderFlips(); renderBazaar(); renderOverview();
  if (state.item === key) selectItem(key, label);
}

// ---------------------------------------------------------------- wiring
function setStats(s) {
  if (!s) return;
  $('dot').classList.add('live');
  $('s-snap').textContent = s.snapshots;
  $('s-auc').textContent = fmt(s.totalAuctions);
  $('s-cycle').textContent = (s.lastCycleMs / 1000).toFixed(1) + 's';
  $('s-sold').textContent = fmt(s.book ? s.book.soldSamples : 0);
  if (s.seed !== undefined) state.seed = s.seed;
  if (s.phase) {
    const was = state.phase && state.phase.code;
    state.phase = s.phase;
    $('dot').title = s.phase.label;
    const mode = $('s-mode');
    if (mode) {
      // Say plainly whether these numbers are live or a few minutes old. A
      // market terminal that will not tell you the age of its data is a liar.
      const label = s.phase.code === 'live' ? 'live'
        : s.phase.code === 'seed' ? `collector ${s.phase.ageMin < 1 ? '<1' : s.phase.ageMin}m`
        : s.phase.code === 'stopped' ? 'stopped' : 'starting…';
      mode.textContent = label;
      mode.className = s.phase.code === 'live' ? 'live' : s.phase.code === 'seed' ? 'seeded' : '';
      $('s-mode-wrap').title = s.phase.label;
    }
    // Repaint the placeholder while it is still counting up, and once more when
    // the first snapshot finally lands.
    if (s.phase.code !== 'live' || was !== 'live') renderFlips();
  }
}

function bumpAlerts(n) { state.unseen += n; $('s-alerts').textContent = state.unseen; }

const es = new EventSource('/api/stream');
es.addEventListener('flips', (e) => {
  // The engine sends the whole current board every snapshot. Replace, don't
  // prepend: a flip that got bought must disappear instead of piling up.
  state.flips = JSON.parse(e.data);
  renderFlips();
});
es.addEventListener('bazaar', (e) => { state.bazaar = JSON.parse(e.data); renderBazaar(); });
es.addEventListener('stats', (e) => setStats(JSON.parse(e.data)));
es.addEventListener('alert', (e) => {
  state.alerts.unshift(JSON.parse(e.data));
  bumpAlerts(1); renderAlerts();
});
es.addEventListener('tick', () => { renderOverview(); renderWatchlist(); });

// segmented controls
const seg = (id, key, after) => {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...$(id).querySelectorAll('button')].forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    state[key] = b.dataset.f || b.dataset.r || b.dataset.m;
    after();
  });
};
seg('flip-filter', 'flipFilter', renderFlips);
seg('range', 'range', () => state.item && selectItem(state.item, $('item-title').textContent));
seg('bz-mode', 'bzMode', renderBazaar);
seg('ov-mode', 'ovMode', renderOverview);

let bzTimer;
$('bz-search').addEventListener('input', (e) => {
  clearTimeout(bzTimer);
  state.bzQuery = e.target.value.trim();
  bzTimer = setTimeout(renderBazaarBook, 180);
});

$('clear-alerts').onclick = async () => {
  await fetch('/api/alerts/seen', { method: 'POST' });
  state.unseen = 0; $('s-alerts').textContent = '0';
};
$('bell').onclick = () => { state.unseen = 0; $('s-alerts').textContent = '0'; };

// search
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const drop = $('drop');
  if (q.length < 2) { drop.style.display = 'none'; return; }
  searchTimer = setTimeout(async () => {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then(r => r.json()).catch(() => ({ results: [] }));
    drop.innerHTML = '';
    if (!r.results.length) { drop.style.display = 'none'; return; }
    for (const row of r.results) {
      const d = el('div');
      d.appendChild(watchStar(row.id, row.id));
      d.appendChild(document.createTextNode(' ' + row.id));
      d.appendChild(el('span', 'kindtag ' + row.kind, row.kind === 'both' ? 'AH+BZ' : row.kind.toUpperCase()));
      d.onclick = () => { drop.style.display = 'none'; $('search').value = ''; selectItem(row.id, row.id); };
      drop.appendChild(d);
    }
    const box = $('search').getBoundingClientRect();
    drop.style.left = box.left + 'px';
    drop.style.top = (box.bottom + 4) + 'px';
    drop.style.display = 'block';
  }, 180);
});
document.addEventListener('click', (e) => { if (!e.target.closest('#search,#drop')) $('drop').style.display = 'none'; });
window.addEventListener('resize', () => { if (state.item) selectItem(state.item, $('item-title').textContent); });

// Before anything else: is the process we are talking to the build these files
// belong to? Dropping new files over a running server is easy to do by accident.
(async () => {
  // The browser build has no server, so there is nothing to be stale against.
  // local-api.js sets this synchronously before its top-level await, which is
  // why it is readable here even though the fetch shim lands a tick later.
  if (window.__TERMINAL_LOCAL__) return;
  let v = null;
  try { const r = await fetch('/api/version'); if (r.ok) v = await r.json(); } catch { /* old build */ }
  if (v && v.api === API_VERSION) return;
  const bar = document.createElement('div');
  bar.id = 'stale';
  bar.textContent = v
    ? `This page expects API v${API_VERSION} but the running server is v${v.api}. Close the terminal window and run run-terminal.bat again.`
    : 'The running server is an older build than these files. Close the terminal window and run run-terminal.bat again.';
  document.body.prepend(bar);
})();

// first paint
fetch('/api/state').then(r => r.json()).then(s => {
  if (s.error) throw new Error(s.error);
  state.flips = s.flips || []; state.bazaar = s.bazaar || { orders: [], crafts: [] };
  state.alerts = s.alerts || []; state.watchlist = s.watchlist || [];
  setStats(s.stats);
  $('s-db').textContent = (s.db.bytes / 1048576).toFixed(0) + ' MB';
  bumpAlerts(state.alerts.filter(a => !a.seen).length);
  state.watchKeys = new Set((s.watchlist || []).map(w => w.key));
  renderFlips(); renderBazaar(); renderWatchlist(); renderAlerts(); renderOverview();
  setInterval(() => fetch('/api/db').then(r => r.json()).then(d => {
    $('s-db').textContent = (d.bytes / 1048576).toFixed(0) + ' MB';
  }), 60000);
}).catch((e) => {
  // Better a visible reason than four blank panels.
  $('flips').innerHTML = '';
  $('flips').appendChild(el('div', 'empty', `Could not start: ${e.message}`));
  console.error('[terminal] first paint failed', e);
});
