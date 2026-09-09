'use strict';
// Boot: build the workspace, wire the live feed into it, and run the top bar.
//
// Everything that draws market data lives in panels.js; everything about where
// panels sit lives in workspace.js and layout.js. This file only connects them.
import { $, el, fmt } from './ui.js';
import { feed, bus, pushLog, setWatchlist } from './feed.js';
import { REGISTRY } from './panels.js';
import { Workspace } from './workspace.js';
import { makePanel, makeSplit, makeView } from './layout.js';

// Must match API_VERSION in src/server/server.js.
const API_VERSION = 3;

// Written by scripts/build-web.js. index.html carries the same value and, unlike
// the JS, is revalidated on every load - so a mismatch means this file came out
// of the browser cache while the page did not.
const BUILD = '9a8638e7';

window.__BUILD__ = BUILD;

(function checkBuild() {
  const meta = document.querySelector('meta[name="build"]');
  const want = meta && meta.content;
  const stamp = $('s-build');
  if (stamp) {
    stamp.textContent = BUILD === 'dev' ? 'dev' : BUILD.slice(0, 6);
    stamp.title = `build ${BUILD}`;
  }
  if (!want || want === 'dev' || want === BUILD) return;
  const bar = el('div', 'bootfail',
    `You are looking at a cached copy of this page (code ${BUILD.slice(0, 6)}, site ${want.slice(0, 6)}). Reload with Ctrl+Shift+R.`);
  bar.style.cursor = 'pointer';
  bar.onclick = () => location.reload(true);
  document.body.prepend(bar);
})();

// The layout you get on a first visit, and after Reset: the same six panels the
// fixed grid used to have, in the same places.
const defaultLayout = () => makeSplit('row', [
  makeSplit('col', [makePanel([makeView('flips')]), makePanel([makeView('watchlist')])], [0.575, 0.425]),
  makeSplit('col', [makePanel([makeView('chart')]), makePanel([makeView('overview')])], [0.575, 0.425]),
  makeSplit('col', [makePanel([makeView('bazaar')]), makePanel([makeView('alerts')])], [0.575, 0.425]),
], [0.286, 0.428, 0.286]);

const ws = new Workspace($('workspace'), REGISTRY, { storageKey: 'sbt.layout.v1', defaultLayout });
window.__ws = ws;
ws.render();

// A panel changing the watchlist changes stars in every other panel.
bus.addEventListener('change', () => ws.refreshAll());

// --- add-panel menu --------------------------------------------------------
const menu = el('div', 'ws-menu');
menu.style.display = 'none';
document.body.appendChild(menu);

function openMenu(anchor, panelId) {
  menu.textContent = '';
  const head = el('div', 'ws-menuhead', 'Add panel');
  menu.appendChild(head);
  for (const [kind, def] of Object.entries(REGISTRY)) {
    const row = el('button', 'ws-menuitem', def.label);
    row.onclick = () => { hideMenu(); ws.open(kind, {}, { panelId, focusExisting: false }); };
    menu.appendChild(row);
  }
  const hint = el('div', 'ws-menufoot', 'Drag a tab onto another panel to move it — near an edge to split.');
  menu.appendChild(hint);
  const r = anchor.getBoundingClientRect();
  menu.style.display = 'block';
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
}
const hideMenu = () => { menu.style.display = 'none'; };
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.ws-menu,.ws-btn,#addpanel')) hideMenu();
}, true);

ws.addEventListener('addrequest', (e) => {
  const panelEl = ws.root.querySelector(`.ws-panel[data-panel="${e.detail.panelId}"] .ws-btn`);
  openMenu(panelEl || $('addpanel'), e.detail.panelId);
});
$('addpanel').onclick = () => openMenu($('addpanel'), ws.focused);
$('resetlayout').onclick = () => {
  if (confirm('Put the panels back the way they started? Your data is not touched.')) ws.reset();
};

// --- top bar ---------------------------------------------------------------
function setStats(s) {
  if (!s) return;
  feed.stats = s;
  $('dot').classList.add('live');
  $('s-snap').textContent = s.snapshots;
  $('s-auc').textContent = fmt(s.totalAuctions);
  $('s-cycle').textContent = (s.lastCycleMs / 1000).toFixed(1) + 's';
  $('s-sold').textContent = fmt(s.book ? s.book.soldSamples : 0);
  if (s.seed !== undefined) feed.seed = s.seed;
  if (s.phase) {
    const was = feed.phase && feed.phase.code;
    feed.phase = s.phase;
    $('dot').title = s.phase.label;
    // Say plainly whether these numbers are live or a few minutes old. A market
    // terminal that will not tell you the age of its data is a liar.
    const label = s.phase.code === 'live' ? 'live'
      : s.phase.code === 'seed' ? `collector ${s.phase.ageMin < 1 ? '<1' : s.phase.ageMin}m`
      : s.phase.code === 'stopped' ? 'stopped' : 'starting…';
    $('s-mode').textContent = label;
    $('s-mode').className = s.phase.code === 'live' ? 'live' : s.phase.code === 'seed' ? 'seeded' : '';
    $('s-mode-wrap').title = s.phase.label;
    if (s.phase.code !== 'live' || was !== 'live') ws.refresh('flips');
  }
}

function bumpAlerts(n) { feed.unseen += n; $('s-alerts').textContent = feed.unseen; }

// --- live feed -------------------------------------------------------------
const es = new EventSource('/api/stream');
es.addEventListener('flips', (e) => {
  // The engine sends the whole current board every snapshot. Replace, don't
  // prepend: a flip that got bought must disappear instead of piling up.
  feed.flips = JSON.parse(e.data);
  ws.refresh('flips');
});
es.addEventListener('bazaar', (e) => {
  feed.bazaar = JSON.parse(e.data);
  ws.refresh('bazaar');
  ws.refresh('book');
});
es.addEventListener('stats', (e) => setStats(JSON.parse(e.data)));
es.addEventListener('alert', (e) => {
  feed.alerts.unshift(JSON.parse(e.data));
  bumpAlerts(1);
  ws.refresh('alerts');
});
es.addEventListener('log', (e) => { pushLog(JSON.parse(e.data)); ws.refresh('log'); });
es.addEventListener('tick', () => {
  ws.refresh('overview'); ws.refresh('watchlist'); ws.refresh('sold'); ws.refresh('chart');
});

$('bell').onclick = () => { feed.unseen = 0; $('s-alerts').textContent = '0'; };

// --- search ----------------------------------------------------------------
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const drop = $('drop');
  if (q.length < 2) { drop.style.display = 'none'; return; }
  searchTimer = setTimeout(async () => {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then(x => x.json()).catch(() => ({ results: [] }));
    drop.textContent = '';
    if (!r.results.length) { drop.style.display = 'none'; return; }
    for (const row of r.results) {
      const d = el('div');
      d.appendChild(document.createTextNode(row.id + ' '));
      d.appendChild(el('span', 'kindtag ' + row.kind, row.kind === 'both' ? 'AH+BZ' : row.kind.toUpperCase()));
      d.onclick = () => {
        drop.style.display = 'none';
        $('search').value = '';
        ws.open('chart', { key: row.id, label: row.id });
      };
      drop.appendChild(d);
    }
    const box = $('search').getBoundingClientRect();
    drop.style.left = box.left + 'px';
    drop.style.top = (box.bottom + 4) + 'px';
    drop.style.display = 'block';
  }, 180);
});
document.addEventListener('click', (e) => { if (!e.target.closest('#search,#drop')) $('drop').style.display = 'none'; });

// --- stale build check -----------------------------------------------------
(async () => {
  // The browser build has no server, so there is nothing to be stale against.
  if (window.__TERMINAL_LOCAL__) return;
  let v = null;
  try { const r = await fetch('/api/version'); if (r.ok) v = await r.json(); } catch { /* old build */ }
  if (v && v.api === API_VERSION) return;
  const bar = el('div');
  bar.id = 'stale';
  bar.textContent = v
    ? `This page expects API v${API_VERSION} but the running server is v${v.api}. Restart the terminal.`
    : 'The running server is an older build than these files. Restart the terminal.';
  document.body.prepend(bar);
})();

// --- first paint -----------------------------------------------------------
fetch('/api/state').then(r => r.json()).then(s => {
  if (s.error) throw new Error(s.error);
  feed.flips = s.flips || [];
  feed.bazaar = s.bazaar || { orders: [], crafts: [] };
  feed.alerts = s.alerts || [];
  setWatchlist(s.watchlist);
  setStats(s.stats);
  $('s-db').textContent = (s.db.bytes / 1048576).toFixed(0) + ' MB';
  bumpAlerts(feed.alerts.filter(a => !a.seen).length);
  ws.refreshAll();
  setInterval(() => fetch('/api/db').then(r => r.json()).then(d => {
    $('s-db').textContent = (d.bytes / 1048576).toFixed(0) + ' MB';
  }), 60000);
}).catch((e) => {
  // Better a visible reason than a screen of blank panels.
  const bar = el('div', 'bootfail', `Could not start: ${e.message}`);
  document.body.prepend(bar);
  console.error('[terminal] first paint failed', e);
});
