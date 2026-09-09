// Shared UI atoms: formatting, charts, and the two market views (order-book
// ladder, BIN wall) that more than one panel needs. No data fetching, no app
// state - so a panel can use any of it without dragging the whole app along.
export const $ = (id) => document.getElementById(id);
export const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

export const fmt = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  // Rounding to whole coins wipes out the entire bazaar. COAL trades at 6.6
  // against 8.8 - a 33% spread - and Math.round turned that into "7 against 9,
  // spread 2", which is both wrong and useless. Counts stay whole; anything
  // with a fraction keeps enough of it to mean something.
  if (Number.isInteger(n)) return String(n);
  if (a >= 100) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(3);
};
export const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(1) + '%';
// Ladder rungs differ by fractions of a coin; abbreviating them to "1.3k"
// throws away the only thing that makes a book a book.
export const exact = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
export const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};
export const CSS = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// ---------------------------------------------------------------- charts
// Hand-rolled SVG: no chart library to install, and nothing to break offline.
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const mk = (tag, attrs) => { const n = document.createElementNS(SVG_NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

export function niceTicks(min, max, count = 4) {
  if (min === max) return [min];
  const span = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(span)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= span) || mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

// One shared time axis, one value axis. Never two y-scales on one plot.
export function lineChart(host, series, { height = 190, yFmt = fmt } = {}) {
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

export function barChart(host, points, { height = 74, color, yFmt = fmt, label = 'volume' } = {}) {
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
export function sparkline(points, { w = 96, h = 26, color } = {}) {
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
export function ladderView(host, depth, title) {
  if (!depth || (!depth.bids.length && !depth.asks.length)) return;
  const wrap = el('div', 'ladder');
  const head = el('div', 'lhead');
  head.textContent = title;
  // The ladder is a window, not the book: Hypixel truncates it at 30 ask levels
  // and 15 bid. Say how many orders actually exist, from quick_status, or the
  // visible rungs read as the whole market.
  if (depth.buyOrders || depth.sellOffers) {
    const t = el('span', 'lsub');
    t.innerHTML = `<b>${fmt(depth.buyOrders)}</b> buy orders (${fmt(depth.bidUnits)} units)`
      + ` · <b>${fmt(depth.sellOffers)}</b> sell offers (${fmt(depth.askUnits)} units)`;
    t.title = 'Totals from quick_status. The rungs below are the top of the book only - Hypixel truncates the ladder at 30 levels a side.';
    head.appendChild(t);
  }
  wrap.appendChild(head);
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
      // Price is the number you are here for; units and order count are
      // context. Lead with the price on both sides.
      const px = el('span', 'lp num', exact(r.price));
      const am = el('span', 'la num', fmt(r.amount));
      const or = el('span', 'lo num', r.orders == null ? '' : '×' + r.orders);
      if (align === 'right') row.append(or, am, px); else row.append(px, am, or);
      px.classList.add('lead');
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

export function wallView(host, wall) {
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
