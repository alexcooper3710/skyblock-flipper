// The workspace tree. All the awkward cases live here rather than being found
// by dragging things around in a browser.
import assert from 'node:assert';
import {
  makeView, makePanel, makeSplit, addView, activateView, closeView, closePanel,
  splitPanel, moveView, resizeSplit, normalize, serialize, deserialize,
  findNode, findView, findPanelWithView, parentOf, panels, allViews,
  isSplit, isPanel, MIN_FRACTION,
} from '../docs/layout.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const kinds = (t) => panels(t).map(p => p.views.map(v => v.kind).join('+')).join(' | ');
const sum = (a) => a.reduce((x, y) => x + y, 0);

// --- building --------------------------------------------------------------
let p1 = makePanel([makeView('flips')]);
ok(isPanel(p1) && p1.views.length === 1 && p1.active === p1.views[0].id, 'a new panel activates its only view');

let t = splitPanel(p1, p1.id, 'right', makeView('bazaar'));
ok(isSplit(t) && t.dir === 'row' && t.kids.length === 2, 'splitting right makes a row of two');
ok(kinds(t) === 'flips | bazaar', 'and the new view is on the right');
ok(Math.abs(sum(t.sizes) - 1) < 1e-9, 'sizes sum to one');

const left = panels(t)[0];
t = splitPanel(t, left.id, 'bottom', makeView('watchlist'));
ok(kinds(t) === 'flips | watchlist | bazaar', 'splitting down nests a column inside the row');
const col = t.kids.find(isSplit);
ok(col && col.dir === 'col', 'the nested split runs the other way');

// --- tabs ------------------------------------------------------------------
const bz = panels(t).find(p => p.views[0].kind === 'bazaar');
const chart = makeView('chart', { key: 'COAL' });
t = addView(t, bz.id, chart);
ok(findNode(t, bz.id).views.length === 2, 'a second view becomes a tab in the same panel');
ok(findNode(t, bz.id).active === chart.id, 'adding a view focuses it');

const chart2 = makeView('chart', { key: 'HYPERION' });
t = addView(t, bz.id, chart2, { activate: false });
ok(findNode(t, bz.id).active === chart.id, 'adding without activating leaves focus alone');
ok(findNode(t, bz.id).views.length === 3, 'three tabs in one panel');

t = activateView(t, chart2.id);
ok(findNode(t, bz.id).active === chart2.id, 'a tab can be activated');

// --- closing ---------------------------------------------------------------
t = closeView(t, chart2.id);
ok(findNode(t, bz.id).views.length === 2, 'closing a tab removes it');
ok(findNode(t, bz.id).active === chart.id, 'focus falls to a neighbour, not to nothing');

// Closing the last view in a panel must remove the panel and give its space back.
const wl = panels(t).find(p => p.views[0].kind === 'watchlist');
const before = panels(t).length;
t = closeView(t, wl.views[0].id);
ok(panels(t).length === before - 1, 'closing the last tab removes the panel');
ok(!findNode(t, wl.id), 'the panel is really gone');
ok(!isSplit(t.kids?.[0]) || t.kids[0].dir === 'row', 'the leftover single-child split collapsed');
ok(Math.abs(sum(t.sizes) - 1) < 1e-9, 'sizes are renormalised after a removal');

// --- normalisation ---------------------------------------------------------
// A row containing a row should be absorbed, with fractions scaled into the slot.
const inner = makeSplit('row', [makePanel([makeView('a')]), makePanel([makeView('b')])], [0.5, 0.5]);
const outer = makeSplit('row', [makePanel([makeView('c')]), inner], [0.6, 0.4]);
const flat = normalize(outer);
ok(flat.kids.length === 3, 'nested same-direction splits are flattened');
ok(Math.abs(flat.sizes[0] - 0.6) < 1e-9 && Math.abs(flat.sizes[1] - 0.2) < 1e-9,
  `the absorbed fractions are scaled, not reset (${flat.sizes.map(s => s.toFixed(2))})`);
const mixed = makeSplit('row', [makePanel([makeView('c')]), makeSplit('col', [makePanel([makeView('a')]), makePanel([makeView('b')])])]);
ok(normalize(mixed).kids.length === 2, 'a split running the other way is NOT absorbed');

// Emptying every panel must still leave something usable.
let doomed = makeSplit('row', [makePanel([makeView('x')]), makePanel([makeView('y')])]);
doomed = closeView(doomed, allViews(doomed)[0].id);
doomed = closeView(doomed, allViews(doomed)[0].id);
ok(doomed && isPanel(doomed), 'closing everything leaves an empty panel, not null');

// --- moving ----------------------------------------------------------------
let m = makeSplit('row', [makePanel([makeView('flips')]), makePanel([makeView('bazaar')])]);
const [pa, pb] = panels(m);
const moving = pa.views[0];
m = moveView(m, moving.id, pb.id);            // drop as a tab
ok(isPanel(m), 'moving the only view out of a panel collapses the split to one panel');
ok(m.views.length === 2 && m.active === moving.id, 'both views now live in the target, focused on the moved one');

// Dropping on an edge splits the target instead of tabbing into it.
let e = makeSplit('row', [makePanel([makeView('flips'), makeView('log')]), makePanel([makeView('bazaar')])]);
const [ea, eb] = panels(e);
e = moveView(e, ea.views[1].id, eb.id, 'bottom');
ok(panels(e).length === 3, 'an edge drop creates a new panel');
const colSplit = [...panels(e)].length && isSplit(e) ? e.kids.find(isSplit) : null;
ok(colSplit && colSplit.dir === 'col', 'dropping on the bottom edge makes a column');

// Dragging a panel's only view onto itself must not destroy it.
let solo = makePanel([makeView('flips')]);
const soloView = solo.views[0];
const after = moveView(solo, soloView.id, solo.id);
ok(after && allViews(after).length === 1 && allViews(after)[0].kind === 'flips',
  'dropping a panel\'s last view back on itself keeps the view');

// Same, but with an edge - the target is about to stop existing.
let solo2 = makePanel([makeView('flips')]);
const after2 = moveView(solo2, solo2.views[0].id, solo2.id, 'right');
ok(after2 && allViews(after2).length === 1, 'edge-dropping a panel\'s last view on itself does not lose it');

// Reordering within a panel.
let r = makePanel([makeView('a'), makeView('b'), makeView('c')]);
const third = r.views[2];
r = moveView(r, third.id, r.id, null, 0);
ok(r.views[0].id === third.id, 'a tab can be dragged to a new position in its own panel');
ok(r.views.length === 3, 'and nothing is lost doing it');

// --- resizing --------------------------------------------------------------
let rs = makeSplit('row', [makePanel([makeView('a')]), makePanel([makeView('b')])], [0.5, 0.5]);
rs = resizeSplit(rs, rs.id, 0, 0.2);
ok(Math.abs(rs.sizes[0] - 0.7) < 1e-9 && Math.abs(rs.sizes[1] - 0.3) < 1e-9, 'a divider moves both sides');
ok(Math.abs(sum(rs.sizes) - 1) < 1e-9, 'the pair still sums to one');
rs = resizeSplit(rs, rs.id, 0, 5);
ok(rs.sizes[1] >= MIN_FRACTION - 1e-9, 'a pane cannot be dragged out of existence');
rs = resizeSplit(rs, rs.id, 0, -5);
ok(rs.sizes[0] >= MIN_FRACTION - 1e-9, 'nor the other way');
ok(resizeSplit(rs, rs.id, 9, 0.1) === rs, 'an out-of-range divider index is ignored');

// --- persistence -----------------------------------------------------------
const round = deserialize(serialize(t));
ok(round && kinds(round) === kinds(t), 'a layout survives a save/load round trip');
ok(deserialize('not json') === null, 'garbage does not throw');
ok(deserialize(JSON.stringify({ v: 999, tree: t })) === null, 'a layout from another version is refused');
ok(deserialize(JSON.stringify({ v: 1, tree: { t: 'split', dir: 'row', kids: [] } })) === null, 'a malformed tree is refused');

// A saved layout naming panels this build no longer has should lose those views
// rather than fail to load entirely.
const withGhost = addView(t, panels(t)[0].id, makeView('some_removed_panel'));
const cleaned = deserialize(serialize(withGhost), { knownKinds: new Set(['flips', 'bazaar', 'chart', 'watchlist']) });
ok(cleaned && !allViews(cleaned).some(v => v.kind === 'some_removed_panel'), 'unknown panel kinds are dropped on load');
ok(cleaned && allViews(cleaned).length === allViews(t).length, 'and everything else survives');

// A layout whose views are ALL unknown is worthless - fall back to the default.
const allGhosts = makePanel([makeView('gone_a'), makeView('gone_b')]);
ok(deserialize(serialize(allGhosts), { knownKinds: new Set(['flips']) }) === null,
  'a layout with nothing recognisable falls back rather than opening blank');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL LAYOUT TESTS PASSED');
process.exit(fails ? 1 : 0);
