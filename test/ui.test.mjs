// Boots the real page in a DOM and drives it.
//
// Everything else about this UI is untestable without a browser, and the two
// worst bugs this project has had were both "the page loads and renders
// nothing" - a module-ordering mistake and a dead first-paint promise. Neither
// would have survived actually loading index.html once. So: load index.html,
// stub the API, and check that panels appear, tabs work, and dragging one panel
// onto another does what it says.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// --- a stand-in for the engine ---------------------------------------------
const API = {
  '/api/state': {
    stats: { snapshots: 3, totalAuctions: 44413, lastCycleMs: 1771, decodes: 43076, flips: 12,
      book: { soldSamples: 2488, soldKeys: 1409, binKeys: 12966 }, warmedUp: true,
      phase: { code: 'live', label: 'live' } },
    flips: [
      { uuid: 'u1', command: '/viewauction u1', name: 'Hyperion', keyBase: 'HYPERION', keyVariant: 'HYPERION|s5',
        price: 450000000, value: 900000000, profit: 432000000, marginPct: 96, strategy: 'lowest-bin',
        basis: 'bin2:variant', samples: 6, seenAt: Date.now() - 30000, isNew: true, lore: [] },
    ],
    bazaar: { orders: [], crafts: [], at: Date.now() },
    alerts: [], watchlist: [], db: { bytes: 62284385 }, canWrite: true,
    cfg: { alerts: {}, minProfit: 1e6, maxBudget: 2e8 },
  },
  '/api/bazaar': { rows: [
    { id: 'COAL', buy: 6.6, sell: 8.8, instantBuy: 9.53, instantSell: 6.43, spread: 2.2, spreadPct: 33.3,
      buyVol: 55396322, sellVol: 627855825, buyOrders: 180, sellOffers: 648, chg1h: -1.4, chg24h: 3.2 },
  ], sort: 'volume' },
  '/api/overview': { movers: [], volume: [], spreads: [], bzMovers: [], warming: true },
  '/api/tickers': { tickers: [] },
  '/api/sold': { sales: [{ name: 'Terminator', key: 'TERMINATOR', price: 520000000, at: Date.now() - 5000 }] },
  '/api/db': { bytes: 62284385 },
  '/api/item': { key: 'COAL', kind: 'bz', current: null,
    bzCurrent: { buy_order: 6.6, sell_order: 8.8, instant_buy: 9.53, instant_sell: 6.43, buy_vol_week: 1, sell_vol_week: 2 },
    bin: [], sales: [], bazaar: [ { t: Date.now() - 7200e3, buy: 6.4, sell: 8.9 }, { t: Date.now(), buy: 6.6, sell: 8.8 } ],
    recentSales: [], ref: null, history: { ah: 'none', bz: 'coflnet', tag: 'COAL' },
    wall: null, depth: null, depthHistory: [], flips: [] },
  '/api/depth': { product: 'COAL', live: { bids: [{ price: 6.5, amount: 100, orders: 3 }], asks: [{ price: 8.9, amount: 90, orders: 1 }], buyOrders: 180, sellOffers: 648 } },
  '/api/version': { api: 3 },
};

const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.github.io/skyblock-flipper/', pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document;
global.CustomEvent = window.CustomEvent; global.Node = window.Node;
// Workspace extends EventTarget; in a browser both sides come from window,
// so node's own EventTarget must not be the one it picks up here.
global.EventTarget = window.EventTarget; global.Event = window.Event;
global.localStorage = window.localStorage;   // saving the layout is a bare global in a browser
global.getComputedStyle = window.getComputedStyle;

const calls = [];
window.fetch = global.fetch = async (url, init) => {
  const u = String(url); calls.push(u);
  const key = Object.keys(API).find(k => u.startsWith(k));
  if (!key) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => API[key] };
};
window.EventSource = global.EventSource = class {
  constructor() { this.h = {}; window.__es = this; }
  addEventListener(t, f) { this.h[t] = f; }
  fire(t, d) { if (this.h[t]) this.h[t]({ data: JSON.stringify(d) }); }
  close() {}
};
window.confirm = () => true;
window.__TERMINAL_LOCAL__ = true;

// jsdom has no layout, so every rect is zero; give the drag code something.
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300 };
};

const app = await import(pathToFileURL(path.join(DOCS, 'app.js')).href);
const ws = window.__ws;
const settle = () => new Promise(r => setTimeout(r, 30));
await settle();

// --- it renders ------------------------------------------------------------
const panelEls = () => [...document.querySelectorAll('.ws-panel')];
ok(panelEls().length === 6, `the default layout opens six panels (got ${panelEls().length})`);
ok(document.querySelectorAll('.ws-div').length > 0, 'dividers exist between panels');
ok(document.querySelectorAll('.ws-tab').length === 6, 'each panel has a tab');

const tabNames = [...document.querySelectorAll('.ws-tabname')].map(n => n.textContent);
ok(tabNames.includes('Flips') && tabNames.includes('Bazaar') && tabNames.includes('Watchlist'),
  `tabs are named (${tabNames.join(', ')})`);

await settle();
ok(document.body.textContent.includes('Hyperion'), 'the flip from /api/state actually rendered');
ok(!document.querySelector('.bootfail'), 'first paint did not fail');
ok(document.getElementById('s-snap').textContent === '3', 'the header picked up the stats');

// --- live events reach the panels ------------------------------------------
window.__es.fire('flips', [{ ...API['/api/state'].flips[0], uuid: 'u2', name: 'Necron Handle', keyBase: 'NECRON_HANDLE' }]);
await settle();
ok(document.body.textContent.includes('Necron Handle'), 'a flips event repaints the flips panel');

window.__es.fire('log', { level: 'error', msg: 'something went wrong', at: Date.now() });
await settle();
ok(true, 'a log event with no log panel open does not throw');

// --- tabs ------------------------------------------------------------------
const before = panelEls().length;
ws.open('log', {});
await settle();
ok(panelEls().length === before, 'opening a panel adds a tab rather than a pane');
ok([...document.querySelectorAll('.ws-tabname')].some(n => n.textContent === 'Log'), 'the new tab is there');
ok(document.body.textContent.includes('something went wrong'), 'and the log panel shows what was logged');

// Two charts, two tabs, one panel.
ws.open('chart', { key: 'COAL', label: 'COAL' });
ws.open('chart', { key: 'HYPERION', label: 'HYPERION' });
await settle();
const chartTabs = [...document.querySelectorAll('.ws-tabname')].filter(n => ['COAL', 'HYPERION'].includes(n.textContent));
ok(chartTabs.length === 2, `two charts open as two tabs (got ${chartTabs.length})`);

// Opening the same item again focuses it instead of stacking duplicates.
ws.open('chart', { key: 'COAL', label: 'COAL' });
await settle();
ok([...document.querySelectorAll('.ws-tabname')].filter(n => n.textContent === 'COAL').length === 1,
  'reopening an item focuses the existing tab rather than duplicating it');

// --- splitting -------------------------------------------------------------
const paneCount = panelEls().length;
ws.open('sold', {}, { edge: 'bottom' });
await settle();
ok(panelEls().length === paneCount + 1, 'opening with an edge splits into a new pane');
ok(document.body.textContent.includes('Terminator'), 'the sold feed rendered its tape');

// --- closing ---------------------------------------------------------------
const logTab = [...document.querySelectorAll('.ws-tab')].find(t => t.textContent.startsWith('Log'));
logTab.querySelector('.ws-x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle();
ok(![...document.querySelectorAll('.ws-tabname')].some(n => n.textContent === 'Log'), 'the × closes a tab');

// --- persistence -----------------------------------------------------------
const saved = window.localStorage.getItem('sbt.layout.v1');
ok(saved && saved.includes('"t":"split"'), 'the layout is saved as you rearrange it');
ws.reset();
await settle();
ok(panelEls().length === 6, 'reset puts the six default panels back');

// --- panel-local settings --------------------------------------------------
// Two bazaar panels must be able to disagree about how they are sorted.
ws.open('bazaar', {}, { edge: 'right', focusExisting: false });
await settle();
const bazaarViews = [...ws.instances.values()].filter(i => i.view.kind === 'bazaar');
ok(bazaarViews.length === 2, 'the same panel kind can be open twice');
bazaarViews[0].view.state.bzSort = 'movers';
ok(bazaarViews[1].view.state.bzSort !== 'movers', 'and they keep separate settings');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL UI TESTS PASSED');
process.exit(fails ? 1 : 0);
