// The workspace layout: a tree of splits, with panels at the leaves.
//
// Pure data. No DOM, no browser APIs, nothing async - so the fiddly part (what
// happens to the tree when you drag the last tab out of a panel that is the only
// child of a split nested inside another split of the same direction) can be
// tested properly instead of discovered by clicking around.
//
//   split: { id, t:'split', dir:'row'|'col', sizes:[fractions], kids:[node…] }
//   panel: { id, t:'panel', views:[{ id, kind, state }], active: viewId }
//
// 'row' lays its children out left-to-right, 'col' top-to-bottom, matching CSS
// grid-template-columns / -rows so the renderer is a direct translation.
//
// Every panel is a tab group. That is what makes "several charts open at once,
// switch between them at the top" and "drag panels around" the same feature
// rather than two: a chart is a view, a view lives in a panel, and dragging a
// view onto another panel makes it a tab there.

let counter = 0;
const nextId = (p) => `${p}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const isSplit = (n) => !!n && n.t === 'split';
export const isPanel = (n) => !!n && n.t === 'panel';

const clone = (n) => JSON.parse(JSON.stringify(n));

export function makeView(kind, state = {}) {
  return { id: nextId('v'), kind, state };
}

export function makePanel(views = []) {
  const v = views.map(x => (x && x.id ? x : makeView(x)));
  return { id: nextId('p'), t: 'panel', views: v, active: v.length ? v[0].id : null };
}

export function makeSplit(dir, kids, sizes) {
  return {
    id: nextId('s'), t: 'split', dir, kids,
    sizes: sizes && sizes.length === kids.length ? sizes.slice() : kids.map(() => 1 / kids.length),
  };
}

// --- walking ---------------------------------------------------------------

export function* walk(node, parent = null) {
  if (!node) return;
  yield [node, parent];
  if (isSplit(node)) for (const k of node.kids) yield* walk(k, node);
}

export const findNode = (tree, id) => {
  for (const [n] of walk(tree)) if (n.id === id) return n;
  return null;
};

export const parentOf = (tree, id) => {
  for (const [n, p] of walk(tree)) if (n.id === id) return p;
  return null;
};

export const findPanelWithView = (tree, viewId) => {
  for (const [n] of walk(tree)) if (isPanel(n) && n.views.some(v => v.id === viewId)) return n;
  return null;
};

export const findView = (tree, viewId) => {
  const p = findPanelWithView(tree, viewId);
  return p ? p.views.find(v => v.id === viewId) : null;
};

export const panels = (tree) => [...walk(tree)].map(([n]) => n).filter(isPanel);
export const allViews = (tree) => panels(tree).flatMap(p => p.views);

// --- normalisation ---------------------------------------------------------
// Run after every structural change. Three rules, applied until stable:
//   1. a panel with no views is removed
//   2. a split with one child is replaced by that child
//   3. a split whose child is a split of the same direction absorbs it,
//      so dragging things around cannot build a stack of pointless wrappers
export function normalize(node) {
  if (!isSplit(node)) return node && isPanel(node) && !node.views.length ? null : node;

  const kids = [];
  const sizes = [];
  node.kids.forEach((kid, i) => {
    const n = normalize(kid);
    if (!n) return;                       // dropped
    const share = node.sizes[i] ?? 1 / node.kids.length;
    if (isSplit(n) && n.dir === node.dir) {
      // absorb: the child's own fractions are scaled into the slot it occupied
      n.kids.forEach((gk, j) => { kids.push(gk); sizes.push(share * (n.sizes[j] ?? 1 / n.kids.length)); });
    } else {
      kids.push(n); sizes.push(share);
    }
  });

  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];

  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, kids, sizes: sizes.map(s => s / total) };
}

// --- mutations -------------------------------------------------------------
// Each returns a NEW tree. Trees are a handful of nodes, so cloning is free and
// it makes undo and change-detection trivial.

export function addView(tree, panelId, view, { activate = true } = {}) {
  const t = clone(tree);
  const p = findNode(t, panelId);
  if (!isPanel(p)) return tree;
  p.views.push(view);
  if (activate) p.active = view.id;
  return normalize(t);
}

export function activateView(tree, viewId) {
  const t = clone(tree);
  const p = findPanelWithView(t, viewId);
  if (!p) return tree;
  p.active = viewId;
  return t;
}

export function closeView(tree, viewId) {
  const t = clone(tree);
  const p = findPanelWithView(t, viewId);
  if (!p) return tree;
  const i = p.views.findIndex(v => v.id === viewId);
  p.views.splice(i, 1);
  if (p.active === viewId) {
    // Focus the neighbour you were most likely looking at before.
    const next = p.views[i] || p.views[i - 1] || null;
    p.active = next ? next.id : null;
  }
  const out = normalize(t);
  // Never hand back an empty workspace - an app with no panels has no way back.
  return out || makePanel([]);
}

export function closePanel(tree, panelId) {
  const t = clone(tree);
  const p = findNode(t, panelId);
  if (!isPanel(p)) return tree;
  p.views = [];
  p.active = null;
  return normalize(t) || makePanel([]);
}

// Split `panelId` and put `view` in the new half. `edge` says which side the new
// half lands on: left/right make a row, top/bottom a column.
export function splitPanel(tree, panelId, edge, view) {
  const t = clone(tree);
  const target = findNode(t, panelId);
  if (!isPanel(target)) return tree;

  const dir = (edge === 'left' || edge === 'right') ? 'row' : 'col';
  const before = (edge === 'left' || edge === 'top');
  const fresh = makePanel([view]);
  const parent = parentOf(t, panelId);

  // Extend the parent in place when it already runs the right way, rather than
  // nesting a split inside a split that does the same thing.
  if (isSplit(parent) && parent.dir === dir) {
    const i = parent.kids.findIndex(k => k.id === panelId);
    const share = parent.sizes[i];
    parent.kids.splice(before ? i : i + 1, 0, fresh);
    parent.sizes.splice(i, 1, share / 2, share / 2);
    return normalize(t);
  }

  const pair = before ? [fresh, target] : [target, fresh];
  const split = makeSplit(dir, pair, [0.5, 0.5]);
  if (!parent) return normalize(split);
  const i = parent.kids.findIndex(k => k.id === panelId);
  parent.kids[i] = split;
  return normalize(t);
}

// Move a view somewhere else. edge null -> becomes a tab in the target panel;
// otherwise the target splits and the view lands on that side.
export function moveView(tree, viewId, targetPanelId, edge = null, index = null) {
  const src = findPanelWithView(tree, viewId);
  if (!src) return tree;
  // Reordering inside the same panel with no split requested is a no-op unless
  // an index was given.
  if (src.id === targetPanelId && !edge && index == null) return tree;

  const view = clone(findView(tree, viewId));
  let t = clone(tree);

  // Detach first so the panel is gone by the time we look for the target - but
  // remember whether the source panel survived, because the target may BE it.
  const sp = findPanelWithView(t, viewId);
  const si = sp.views.findIndex(v => v.id === viewId);
  sp.views.splice(si, 1);
  if (sp.active === viewId) sp.active = (sp.views[si] || sp.views[si - 1] || {}).id ?? null;

  const targetStillThere = !!findNode(t, targetPanelId) && findNode(t, targetPanelId).views.length > 0;
  t = normalize(t) || makePanel([]);

  const target = findNode(t, targetPanelId);
  if (!target || !isPanel(target) || !targetStillThere) {
    // The target vanished (it was the source panel and that was its last view),
    // so the move has nowhere to go: put the view back where it can be seen.
    const home = panels(t)[0];
    if (!home) return normalize(makePanel([view])) || makePanel([view]);
    home.views.push(view); home.active = view.id;
    return normalize(t);
  }

  if (edge) return splitPanel(t, target.id, edge, view);

  const at = index == null ? target.views.length : Math.max(0, Math.min(index, target.views.length));
  target.views.splice(at, 0, view);
  target.active = view.id;
  return normalize(t);
}

// Drag a divider: hand back the two adjusted fractions for adjacent children.
// Clamped so a pane can be made small but never collapsed to nothing by accident.
export const MIN_FRACTION = 0.08;
export function resizeSplit(tree, splitId, index, delta) {
  const t = clone(tree);
  const s = findNode(t, splitId);
  if (!isSplit(s) || index < 0 || index >= s.kids.length - 1) return tree;
  const a = s.sizes[index], b = s.sizes[index + 1];
  const pair = a + b;
  let na = a + delta;
  na = Math.max(MIN_FRACTION, Math.min(pair - MIN_FRACTION, na));
  // A pair too small to divide is left alone rather than snapped to something.
  if (pair < MIN_FRACTION * 2) return tree;
  s.sizes[index] = na;
  s.sizes[index + 1] = pair - na;
  return t;
}

// --- persistence -----------------------------------------------------------
// Version it: a layout saved by an older build should be discarded rather than
// half-understood, and a layout referring to panel kinds that no longer exist
// should lose those views, not fail to load.
export const LAYOUT_VERSION = 1;

export function serialize(tree) {
  return JSON.stringify({ v: LAYOUT_VERSION, tree });
}

export function deserialize(raw, { knownKinds = null } = {}) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || data.v !== LAYOUT_VERSION || !data.tree) return null;
    const t = clone(data.tree);
    if (!validate(t)) return null;
    if (knownKinds) {
      for (const [n] of walk(t)) {
        if (!isPanel(n)) continue;
        n.views = n.views.filter(v => knownKinds.has(v.kind));
        if (!n.views.some(v => v.id === n.active)) n.active = n.views.length ? n.views[0].id : null;
      }
    }
    const out = normalize(t);
    return out && allViews(out).length ? out : null;
  } catch { return null; }
}

function validate(node) {
  if (!node || typeof node !== 'object') return false;
  if (isPanel(node)) return Array.isArray(node.views) && node.views.every(v => v && typeof v.kind === 'string' && typeof v.id === 'string');
  if (!isSplit(node)) return false;
  if (!Array.isArray(node.kids) || !node.kids.length) return false;
  if (!Array.isArray(node.sizes) || node.sizes.length !== node.kids.length) return false;
  if (node.dir !== 'row' && node.dir !== 'col') return false;
  return node.kids.every(validate);
}
