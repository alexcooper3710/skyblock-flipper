'use strict';
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
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};
const CSS = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = { flips: [], bazaar: { orders: [], crafts: [] }, alerts: [], watchlist: [], bzQuery: '',
  range: '24h', item: null, flipFilter: 'all', bzMode: 'orders', ovMode: 'movers', unseen: 0 };

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

// ---------------------------------------------------------------- panels
function renderFlips() {
  const host = $('flips');
  const rows = state.flipFilter === 'all' ? state.flips : state.flips.filter(f => f.strategy === state.flipFilter);
  host.innerHTML = '';
  if (!rows.length) { host.appendChild(el('div', 'empty', 'No flips matching that filter yet.')); return; }
  const t = el('table');
  t.innerHTML = '<thead><tr><th>Item</th><th class="r">Buy</th><th class="r">Worth</th><th class="r">Profit</th></tr></thead>';
  const tb = el('tbody');
  for (const f of rows.slice(0, 120)) {
    const tr = el('tr');
    if (state.item === f.keyBase) tr.className = 'sel';
    const c1 = el('td'); c1.className = 'name';
    c1.appendChild(el('div', null, f.name));
    const sub = el('div', 'sub'); sub.innerHTML = `<span class="tag ${f.strategy}">${f.strategy}</span> ${f.basis} · n=${f.samples} · ${ago(f.seenAt)}`;
    c1.appendChild(sub);
    const c2 = el('td', 'r num', fmt(f.price));
    const c3 = el('td', 'r num', fmt(f.value));
    const c4 = el('td', 'r num'); c4.innerHTML = `<span class="pos">+${fmt(f.profit)}</span><div class="sub">${f.marginPct}%</div>`;
    tr.append(c1, c2, c3, c4);
    tr.onclick = () => { navigator.clipboard?.writeText(f.command); selectItem(f.keyBase, f.name); };
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
}

async function renderBazaarBook() {
  const host = $('bazaar');
  const r = await fetch('/api/bazaar?q=' + encodeURIComponent(state.bzQuery || '')).then(r => r.json()).catch(() => null);
  host.innerHTML = '';
  if (!r || !r.rows.length) { host.appendChild(el('div', 'empty', 'No bazaar history stored yet - give it a minute.')); return; }
  const t = el('table');
  t.innerHTML = '<thead><tr><th>Product</th><th class="r">Buy</th><th class="r">Sell</th><th class="r">Spread</th></tr></thead>';
  const tb = el('tbody');
  for (const b of r.rows) {
    const tr = el('tr');
    if (state.item === b.id) tr.className = 'sel';
    const c1 = el('td', 'name');
    c1.appendChild(el('div', null, b.id));
    c1.appendChild(el('div', 'sub', `vol ${fmt(b.sellVol)}/wk · insta ${fmt(b.instantBuy)}/${fmt(b.instantSell)}`));
    tr.append(c1, el('td', 'r num', fmt(b.buy)), el('td', 'r num', fmt(b.sell)));
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
  t.innerHTML = `<thead><tr><th>Product</th><th class="r">${craft ? 'Cost' : 'Buy'}</th><th class="r">${craft ? 'Revenue' : 'Sell'}</th><th class="r">Profit</th></tr></thead>`;
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const c1 = el('td'); c1.className = 'name';
    c1.appendChild(el('div', null, r.id));
    c1.appendChild(el('div', 'sub', craft ? `${r.qty}x ${r.input} · ${r.crafts}/hr` : `${r.units}/hr · vol ${fmt(r.weeklyVolume)}`));
    tr.append(c1,
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
    t.innerHTML = '<thead><tr><th>Item</th><th class="r">Was</th><th class="r">Now</th><th class="r">6h</th></tr></thead>';
    const tb = el('tbody');
    for (const m of data.movers) {
      const tr = el('tr');
      tr.append(el('td', 'name', m.key), el('td', 'r num', fmt(m.then_price)), el('td', 'r num', fmt(m.now_price)));
      const c = el('td', 'r num ' + (m.pct >= 0 ? 'pos' : 'neg'), pct(m.pct));
      tr.appendChild(c);
      tr.onclick = () => selectItem(m.key, m.key);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else if (state.ovMode === 'bz') {
    if (!data.bzMovers || !data.bzMovers.length) { host.appendChild(el('div', 'empty', 'Needs a few bazaar snapshots first.')); return; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Product</th><th class="r">Was</th><th class="r">Now</th><th class="r">6h</th></tr></thead>';
    const tb = el('tbody');
    for (const m of data.bzMovers) {
      const tr = el('tr');
      tr.append(el('td', 'name', m.product), el('td', 'r num', fmt(m.then_price)), el('td', 'r num', fmt(m.now_price)));
      tr.appendChild(el('td', 'r num ' + (m.pct >= 0 ? 'pos' : 'neg'), pct(m.pct)));
      tr.onclick = () => selectItem(m.product, m.product);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else if (state.ovMode === 'volume') {
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Item</th><th class="r">Sales</th><th class="r">Avg</th><th class="r">Coins</th></tr></thead>';
    const tb = el('tbody');
    for (const v of data.volume) {
      const tr = el('tr');
      tr.append(el('td', 'name', v.key), el('td', 'r num', v.sales), el('td', 'r num', fmt(v.avg)), el('td', 'r num', fmt(v.coins)));
      tr.onclick = () => selectItem(v.key, v.key);
      tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  } else {
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Product</th><th class="r">Spread</th><th class="r">Per unit</th><th class="r">Vol</th></tr></thead>';
    const tb = el('tbody');
    for (const s of data.spreads) {
      const tr = el('tr');
      tr.append(el('td', 'name', s.id), el('td', 'r num pos', s.spreadPct + '%'),
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

function renderWatchlist() {
  const host = $('watchlist');
  host.innerHTML = '';
  if (!state.watchlist.length) { host.appendChild(el('div', 'empty', 'Open an item and hit Watch.')); return; }
  const t = el('table');
  t.innerHTML = '<thead><tr><th>Item</th><th class="r">Below</th><th class="r">Above</th><th></th></tr></thead>';
  const tb = el('tbody');
  for (const w of state.watchlist) {
    const tr = el('tr');
    tr.append(el('td', 'name', w.label || w.key), el('td', 'r num', w.below ? fmt(w.below) : '—'), el('td', 'r num', w.above ? fmt(w.above) : '—'));
    const x = el('td', 'r'); const b = el('button', 'act', '×');
    b.onclick = (e) => { e.stopPropagation(); toggleWatch(w.key); };
    x.appendChild(b); tr.appendChild(x);
    tr.onclick = () => selectItem(w.key, w.label);
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
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
  state.watchlist = r.watchlist || [];
  renderWatchlist();
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
}

function bumpAlerts(n) { state.unseen += n; $('s-alerts').textContent = state.unseen; }

const es = new EventSource('/api/stream');
es.addEventListener('flips', (e) => {
  state.flips = [...JSON.parse(e.data), ...state.flips].slice(0, 300);
  renderFlips();
});
es.addEventListener('bazaar', (e) => { state.bazaar = JSON.parse(e.data); renderBazaar(); });
es.addEventListener('stats', (e) => setStats(JSON.parse(e.data)));
es.addEventListener('alert', (e) => {
  state.alerts.unshift(JSON.parse(e.data));
  bumpAlerts(1); renderAlerts();
});
es.addEventListener('tick', () => { if (state.ovMode) renderOverview(); });

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
      d.appendChild(document.createTextNode(row.id));
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

// first paint
fetch('/api/state').then(r => r.json()).then(s => {
  state.flips = s.flips || []; state.bazaar = s.bazaar || { orders: [], crafts: [] };
  state.alerts = s.alerts || []; state.watchlist = s.watchlist || [];
  setStats(s.stats);
  $('s-db').textContent = (s.db.bytes / 1048576).toFixed(0) + ' MB';
  bumpAlerts(state.alerts.filter(a => !a.seen).length);
  renderFlips(); renderBazaar(); renderWatchlist(); renderAlerts(); renderOverview();
  setInterval(() => fetch('/api/db').then(r => r.json()).then(d => {
    $('s-db').textContent = (d.bytes / 1048576).toFixed(0) + ' MB';
  }), 60000);
});
