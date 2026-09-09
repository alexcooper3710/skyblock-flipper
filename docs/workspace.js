// Draws the layout tree and handles the dragging.
//
// docs/layout.js owns what the tree IS and is tested on its own; this file owns
// what it looks like and how a pointer changes it. Splitting them that way is
// the only reason the awkward cases (drag the last tab out of a panel that is
// the only child of a split) could be pinned down without a browser.
//
// Panels are tab groups. Drag a tab onto another panel's tab strip to move it
// there; drag it over the middle of a panel to tab into it, or near an edge to
// split that panel and drop it alongside. Drag the gaps to resize.
import {
  makeView, makePanel, addView, activateView, closeView, closePanel,
  moveView, resizeSplit, serialize, deserialize, findNode, findView,
  findPanelWithView, panels, allViews, isSplit, isPanel,
} from './layout.js';

const DIVIDER = 5;          // px; also the grab target, so not smaller than this
const EDGE_ZONE = 0.28;     // fraction of a panel that counts as "split here"
const DRAG_SLOP = 4;        // px before a click becomes a drag

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

export class Workspace extends EventTarget {
  // registry: { kind: { title, mount(host, view, api) -> {refresh?, destroy?} } }
  constructor(root, registry, { storageKey = 'workspace', defaultLayout } = {}) {
    super();
    this.root = root;
    this.registry = registry;
    this.storageKey = storageKey;
    this.defaultLayout = defaultLayout;
    this.instances = new Map();     // viewId -> { view, host, api }
    this.focused = null;            // panel id
    this.tree = this.load() || defaultLayout();
    this.drag = null;
  }

  // --- persistence ---------------------------------------------------------
  load() {
    try {
      return deserialize(localStorage.getItem(this.storageKey), { knownKinds: new Set(Object.keys(this.registry)) });
    } catch { return null; }
  }
  save() {
    try { localStorage.setItem(this.storageKey, serialize(this.tree)); } catch { /* private window, quota */ }
  }
  reset() {
    try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
    this.setTree(this.defaultLayout());
  }

  setTree(next) {
    if (!next || next === this.tree) return;
    this.tree = next;
    this.save();
    this.render();
    this.emit('layout');
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // --- opening and closing -------------------------------------------------
  // Opening the same kind+key twice focuses what is already there instead of
  // stacking duplicates - clicking six flips for the same item should not leave
  // six identical chart tabs behind.
  open(kind, state = {}, { panelId = null, edge = null, focusExisting = true } = {}) {
    if (focusExisting && state.key) {
      const dupe = allViews(this.tree).find(v => v.kind === kind && v.state && v.state.key === state.key);
      if (dupe) { this.setTree(activateView(this.tree, dupe.id)); this.focusView(dupe.id); return dupe.id; }
    }
    const view = makeView(kind, state);
    const target = panelId || this.focused || (panels(this.tree)[0] || {}).id;
    if (!target) { this.setTree(makePanel([view])); return view.id; }
    this.setTree(edge ? this.splitInto(target, edge, view) : addView(this.tree, target, view));
    return view.id;
  }

  splitInto(panelId, edge, view) {
    // splitPanel lives in layout.js; go through moveView-style semantics here by
    // adding then moving, so there is one code path for "put this view there".
    const withView = addView(this.tree, panelId, view, { activate: false });
    return moveView(withView, view.id, panelId, edge);
  }

  close(viewId) { this.setTree(closeView(this.tree, viewId)); }
  closePanel(panelId) { this.setTree(closePanel(this.tree, panelId)); }

  focusView(viewId) {
    const p = findPanelWithView(this.tree, viewId);
    if (p) this.focused = p.id;
  }

  // Tell every open instance of a kind to redraw. app.js calls this when data
  // arrives, without needing to know how many copies of a panel are open.
  refresh(kind) {
    for (const inst of this.instances.values()) {
      if (kind && inst.view.kind !== kind) continue;
      try { inst.api && inst.api.refresh && inst.api.refresh(); } catch (e) { console.error('[panel]', inst.view.kind, e); }
    }
  }

  refreshAll() { this.refresh(null); }

  // Update a view's stored state (e.g. which item a chart tab is showing).
  setViewState(viewId, patch) {
    const v = findView(this.tree, viewId);
    if (!v) return;
    Object.assign(v.state, patch);
    this.save();
    const inst = this.instances.get(viewId);
    if (inst) this.paintTabs();
  }

  // --- rendering -----------------------------------------------------------
  render() {
    const keep = new Set(allViews(this.tree).map(v => v.id));
    // Detach hosts we are about to reparent so they survive the rebuild with
    // their scroll position and DOM state intact.
    for (const [id, inst] of this.instances) {
      if (!keep.has(id)) { this.destroyInstance(id); continue; }
      if (inst.host.parentNode) inst.host.parentNode.removeChild(inst.host);
    }
    this.root.textContent = '';
    this.root.appendChild(this.renderNode(this.tree));
    if (!this.focused || !findNode(this.tree, this.focused)) {
      this.focused = (panels(this.tree)[0] || {}).id || null;
    }
  }

  renderNode(node) {
    return isSplit(node) ? this.renderSplit(node) : this.renderPanel(node);
  }

  renderSplit(node) {
    const box = el('div', 'ws-split ws-' + node.dir);
    const tracks = [];
    node.kids.forEach((k, i) => {
      if (i) tracks.push(`${DIVIDER}px`);
      tracks.push(`minmax(0, ${node.sizes[i]}fr)`);
    });
    box.style[node.dir === 'row' ? 'gridTemplateColumns' : 'gridTemplateRows'] = tracks.join(' ');
    node.kids.forEach((kid, i) => {
      if (i) box.appendChild(this.renderDivider(node, i - 1));
      box.appendChild(this.renderNode(kid));
    });
    return box;
  }

  renderDivider(split, index) {
    const d = el('i', 'ws-div ws-div-' + split.dir);
    d.addEventListener('pointerdown', (e) => this.beginResize(e, split, index, d));
    return d;
  }

  renderPanel(node) {
    const box = el('div', 'ws-panel');
    box.dataset.panel = node.id;
    if (node.id === this.focused) box.classList.add('focus');
    box.addEventListener('pointerdown', () => { this.focused = node.id; this.paintFocus(); }, true);

    const head = el('div', 'ws-tabs');
    head.dataset.panel = node.id;
    for (const v of node.views) head.appendChild(this.renderTab(node, v));

    const spacer = el('div', 'ws-tabfill');
    spacer.addEventListener('dblclick', () => this.emit('addrequest', { panelId: node.id }));
    head.appendChild(spacer);

    const add = el('button', 'ws-btn', '+');
    add.title = 'Add a panel here';
    add.onclick = (e) => { e.stopPropagation(); this.focused = node.id; this.emit('addrequest', { panelId: node.id }); };
    head.appendChild(add);

    box.appendChild(head);

    const body = el('div', 'ws-body');
    const active = node.views.find(v => v.id === node.active) || node.views[0];
    if (!active) {
      const empty = el('div', 'empty', 'Empty panel — press + to put something here.');
      body.appendChild(empty);
    } else {
      body.appendChild(this.hostFor(active));
    }
    box.appendChild(body);
    return box;
  }

  renderTab(panel, view) {
    const def = this.registry[view.kind];
    const tab = el('div', 'ws-tab' + (view.id === panel.active ? ' on' : ''));
    tab.dataset.view = view.id;
    const label = def && def.title ? def.title(view.state) : view.kind;
    tab.appendChild(el('span', 'ws-tabname', label));
    const x = el('button', 'ws-x', '×');
    x.title = 'Close';
    x.onclick = (e) => { e.stopPropagation(); this.close(view.id); };
    tab.appendChild(x);
    tab.onclick = () => { this.focused = panel.id; this.setTree(activateView(this.tree, view.id)); };
    // Middle-click closes, the way tabs work everywhere else.
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.close(view.id); } });
    tab.addEventListener('pointerdown', (e) => this.beginTabDrag(e, view, tab));
    return tab;
  }

  hostFor(view) {
    let inst = this.instances.get(view.id);
    if (inst) { inst.view = view; return inst.host; }
    const host = el('div', 'ws-view');
    host.dataset.view = view.id;
    const def = this.registry[view.kind];
    inst = { view, host, api: null };
    this.instances.set(view.id, inst);
    if (!def) {
      host.appendChild(el('div', 'empty', `No panel called "${view.kind}" in this build.`));
      return host;
    }
    try {
      inst.api = def.mount(host, view, this) || null;
    } catch (e) {
      console.error('[panel] mount failed', view.kind, e);
      host.appendChild(el('div', 'empty', `${view.kind} failed to start: ${e.message}`));
    }
    return host;
  }

  destroyInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) return;
    try { inst.api && inst.api.destroy && inst.api.destroy(); } catch { /* going away anyway */ }
    if (inst.host.parentNode) inst.host.parentNode.removeChild(inst.host);
    this.instances.delete(id);
  }

  paintFocus() {
    for (const p of this.root.querySelectorAll('.ws-panel')) {
      p.classList.toggle('focus', p.dataset.panel === this.focused);
    }
  }

  paintTabs() {
    for (const tab of this.root.querySelectorAll('.ws-tab')) {
      const v = findView(this.tree, tab.dataset.view);
      if (!v) continue;
      const def = this.registry[v.kind];
      const name = tab.querySelector('.ws-tabname');
      if (name && def && def.title) name.textContent = def.title(v.state);
    }
  }

  // --- resizing ------------------------------------------------------------
  beginResize(e, split, index, handle) {
    e.preventDefault();
    const box = handle.parentElement;
    const horizontal = split.dir === 'row';
    const total = horizontal ? box.clientWidth : box.clientHeight;
    if (total <= 0) return;
    const start = horizontal ? e.clientX : e.clientY;
    const live = findNode(this.tree, split.id);
    if (!live) return;
    const a0 = live.sizes[index], b0 = live.sizes[index + 1];
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('ws-resizing');

    const move = (ev) => {
      const px = (horizontal ? ev.clientX : ev.clientY) - start;
      const next = resizeSplit(this.tree, split.id, index, px / total);
      const s = findNode(next, split.id);
      if (!s) return;
      // Repaint the track sizes directly rather than re-rendering: a full
      // re-render mid-drag would remount every panel and lose scroll positions.
      const tracks = [];
      s.kids.forEach((k, i) => { if (i) tracks.push(`${DIVIDER}px`); tracks.push(`minmax(0, ${s.sizes[i]}fr)`); });
      box.style[horizontal ? 'gridTemplateColumns' : 'gridTemplateRows'] = tracks.join(' ');
      this.pendingResize = next;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('ws-resizing');
      if (this.pendingResize) {
        this.tree = this.pendingResize;
        this.pendingResize = null;
        this.save();
        this.emit('layout');
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    void a0; void b0;
  }

  // --- tab dragging --------------------------------------------------------
  beginTabDrag(e, view, tab) {
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    let started = false;
    let ghost = null, hint = null;

    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_SLOP) return;
        started = true;
        tab.setPointerCapture(ev.pointerId);
        document.body.classList.add('ws-dragging');
        ghost = el('div', 'ws-ghost', tab.querySelector('.ws-tabname').textContent);
        document.body.appendChild(ghost);
        hint = el('div', 'ws-hint');
        document.body.appendChild(hint);
      }
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`;
      const drop = this.dropTargetAt(ev.clientX, ev.clientY, tab);
      if (!drop) { hint.style.display = 'none'; this.pendingDrop = null; return; }
      this.pendingDrop = drop;
      const r = drop.rect;
      hint.style.display = 'block';
      const z = { left: [r.x, r.y, r.width / 2, r.height], right: [r.x + r.width / 2, r.y, r.width / 2, r.height],
        top: [r.x, r.y, r.width, r.height / 2], bottom: [r.x, r.y + r.height / 2, r.width, r.height / 2],
        center: [r.x, r.y, r.width, r.height] }[drop.edge || 'center'];
      hint.style.left = z[0] + 'px'; hint.style.top = z[1] + 'px';
      hint.style.width = z[2] + 'px'; hint.style.height = z[3] + 'px';
    };

    const up = () => {
      tab.removeEventListener('pointermove', move);
      tab.removeEventListener('pointerup', up);
      tab.removeEventListener('pointercancel', up);
      document.body.classList.remove('ws-dragging');
      if (ghost) ghost.remove();
      if (hint) hint.remove();
      const drop = this.pendingDrop;
      this.pendingDrop = null;
      if (!started || !drop) return;
      this.setTree(moveView(this.tree, view.id, drop.panelId, drop.edge, drop.index));
      this.focusView(view.id);
      this.paintFocus();
    };

    tab.addEventListener('pointermove', move);
    tab.addEventListener('pointerup', up);
    tab.addEventListener('pointercancel', up);
  }

  dropTargetAt(x, y, dragTab) {
    const under = document.elementFromPoint(x, y);
    if (!under) return null;

    // Over a tab strip: insert between tabs, so tabs can be reordered.
    const strip = under.closest('.ws-tabs');
    if (strip) {
      const panelId = strip.dataset.panel;
      const tabs = [...strip.querySelectorAll('.ws-tab')].filter(t => t !== dragTab);
      let index = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (x < r.x + r.width / 2) { index = i; break; }
      }
      return { panelId, edge: null, index, rect: strip.getBoundingClientRect() };
    }

    const panelEl = under.closest('.ws-panel');
    if (!panelEl) return null;
    const rect = panelEl.getBoundingClientRect();
    const fx = (x - rect.x) / rect.width;
    const fy = (y - rect.y) / rect.height;
    // Nearest edge wins, but only inside the edge band; the middle means "tab".
    let edge = null;
    const m = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (m < EDGE_ZONE) {
      edge = m === fx ? 'left' : m === 1 - fx ? 'right' : m === fy ? 'top' : 'bottom';
    }
    return { panelId: panelEl.dataset.panel, edge, index: null, rect };
  }
}

export { makeView, makePanel };
