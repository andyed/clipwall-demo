/**
 * clipwall — a pannable, zoomable wall of visual web excerpts.
 *
 * Reads a normalized clip index from /api/clips (whatever store the adapter
 * happens to be reading) and renders it as a filterable canvas. It never
 * writes: editing happens in Obsidian, one deep link away.
 *
 * SECURITY NOTE: every string here — titles, notes, tags, facet values —
 * originates from scraped third-party pages. All of it goes into the DOM via
 * textContent. There is no innerHTML path for clip-derived data anywhere in
 * this file, and there must not be one.
 */

import { sortClips } from './attributes.mjs';
import { createAttributeBrush } from './attribute-brush.mjs';
import { createPermalinks, canonical } from './permalink.mjs';
import { clipKey, filterScope, chooseCluster, contextClusters } from './context-clusters.mjs';
import { layout, frameAround, HEADER_H } from './layout.mjs';
import { Viewport } from './viewport.mjs';
import { createDetailPane } from './detail-pane.mjs';
import { ViewStateStore, mergePileState } from './view-state.mjs';

/** Facets that exist for layout, not for browsing. */
const FACET_BLOCKLIST = new Set(['dims', 'media', 'cover']);
/** Chips per facet before the tail is handed to search. */
const FACET_CHIP_LIMIT = 24;
let facetOrder = ['tags', 'source', 'kind', 'captured'];

const state = {
  clips: [],
  facets: {},
  filtered: [],
  query: '',
  branches: null, // null = whole corpus; otherwise union of explicit membership snapshots
  scopeHistory: [],
  clusters: [],
  contextVisible: false, // background plane revealed (kept as ui.context in permalinks)
  background: { key: '', full: null, framed: null, mounted: false },
  contextBase: null, // the working set at the moment a search began: search results are focus, this is their context
  corpus: null,
  layoutAspect: null,
  renderAspect: 1,
  arrangementOverride: null,
  permalinkBar: false,
  unresolvedFocus: null,
  detailMedia: null,
  facetLabels: {},
  active: new Map(),   // facetKey -> Set(values)
  groupKey: 'none',
  sort: { key: 'none', direction: 'asc' },
  selected: null,
  spatial: null,       // lazily constructed SpatialView
  spatialOn: false,
  spatialLoading: false,
  clipKey: null,
  viewState: new ViewStateStore(),
  viewStateError: '',
  tileEls: new Map(),  // [group label, clip.id] occurrence -> element
  positions: new Map(), // occurrence -> {clip,x,y,w,h}
  bgTileEls: new Map(), // background-plane occurrence -> element (mounted only while revealed)
  bgPositions: new Map()
};

const el = {
  stage: document.getElementById('stage'),
  spHost: document.getElementById('sp-host'),
  view3d: document.getElementById('view-3d'),
  canvas: document.getElementById('canvas'),
  rail: document.getElementById('rail'),
  search: document.getElementById('search'),
  group: document.getElementById('group'),
  count: document.getElementById('count'),
  detail: document.getElementById('detail'),
  empty: document.getElementById('empty')
};

const detailPane = createDetailPane(el.detail, el.stage);
const viewport = new Viewport(el.stage, el.canvas, onViewportChange);
let hydrating = false, links;
const brush = createAttributeBrush({
  canvas: el.canvas, stage: el.stage,
  legendHost: document.getElementById('review-tip'),
  getTiles: () => [...state.tileEls].map(([key, node]) => ({ node, clip: state.positions.get(key)?.clip })).filter(t => t.clip),
  getClips: () => state.filtered, getSort: () => state.sort,
  getLabel: key => state.facetLabels[key] || (key === 'title' ? 'Title' : key),
  onSort: (key, direction) => setSort(key, direction),
  onPinnedChange: key => { document.getElementById('attribute-lens').value = key || 'none'; },
});
const header = document.querySelector('.bar');
new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${header.getBoundingClientRect().height}px`)).observe(header);
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function linkNotice(message) {
  document.getElementById('link-message').textContent = message;
  document.getElementById('link-status').hidden = !message;
}
function captureView() {
  const r = el.stage.getBoundingClientRect();
  const preferred = parseFloat(document.body.style.getPropertyValue('--detail-preferred'));
  const spatial = state.spatial?.captureView() || null;
  const originalArrangement = state.arrangementOverride || state.viewState.doc;
  if (spatial && originalArrangement?.piles) {
    const merged = mergePileState(spatial.arrangement, originalArrangement, new Set(state.filtered.map(clipKey)));
    spatial.arrangement = { version: 1, piles: merged.piles };
  }
  return { v: 1, layoutVersion: 1, corpus: state.corpus,
    scope: { query: state.query, facets: [...state.active].filter(([, v]) => v.size).map(([k, v]) => [k, [...v].sort()]).sort(([a], [b]) => a.localeCompare(b)), branches: state.branches },
    presentation: { mode: state.spatialOn ? '3d' : 'flat', group: state.groupKey, pan: viewport.panMode, sort: { ...state.sort } },
    flat: { view: viewport.snapshot(), stage: { w: r.width, h: r.height }, aspect: state.renderAspect },
    spatial,
    ui: { lens: brush.getPinned(), mediaSource: state.detailMedia, rail: !el.rail.classList.contains('hidden'), context: state.contextVisible, scopeBar: !document.getElementById('scope-bar').hidden,
      focus: state.clips.find(c => c.id === state.selected) ? clipKey(state.clips.find(c => c.id === state.selected)) : state.unresolvedFocus,
      detailWidth: Number.isFinite(preferred) ? Math.min(1, preferred / window.innerWidth) : null },
  };
}
async function restoreView(spec) {
  if (spec.corpus.id !== state.corpus.id) throw new Error('This link belongs to a different corpus');
  hydrating = true; document.body.inert = true; document.body.dataset.restoring = 'true'; cancelAnimationFrame(filterFrame); viewport.resetEdge();
  const warnings = [];
  if (spec.corpus.revision !== state.corpus.revision) warnings.push('Corpus changed since this link was made');
  const known = new Set(state.clips.map(clipKey));
  const missing = new Set([...(spec.scope.branches || []).flatMap(b => b.keys), ...(spec.spatial?.arrangement.piles || []).flatMap(p => p.keys)].filter(k => !known.has(k)));
  if (missing.size) warnings.push(`${missing.size} missing item identities retained in the link`);
  try {
    state.permalinkBar = !!spec.ui.scopeBar;
    state.query = spec.scope.query; state.active = new Map(spec.scope.facets.map(([k, v]) => [k, new Set(v)]));
    state.branches = structuredClone(spec.scope.branches);
    state.sort = spec.presentation.sort || { key: 'none', direction: 'asc' };
    brush.clear(); brush.setPinned(spec.ui.lens || null);
    buildReviewControls();
    state.groupKey = spec.presentation.group; el.group.value = state.groupKey;
    if (el.group.value !== state.groupKey) { const option = document.createElement('option'); option.value = state.groupKey; option.textContent = state.groupKey; el.group.append(option); el.group.value = state.groupKey; }
    state.arrangementOverride = spec.spatial ? { ...spec.spatial.arrangement, mode: spec.spatial.mode } : null;
    el.search.value = state.query; buildFacetRail();
    el.rail.classList.toggle('hidden', !spec.ui.rail); el.stage.classList.toggle('full', !spec.ui.rail);
    viewport.panMode = spec.presentation.pan; document.getElementById('pan-behavior').value = viewport.panMode;
    if (spec.ui.detailWidth === null) document.body.style.removeProperty('--detail-preferred');
    else document.body.style.setProperty('--detail-preferred', `${spec.ui.detailWidth * window.innerWidth}px`);
    closeDetail();
    if (spec.ui.focus) { const focus = state.clips.find(c => clipKey(c) === spec.ui.focus); if (focus) {
      openDetail(focus);
      if (spec.ui.mediaSource) {
        state.detailMedia = spec.ui.mediaSource;
        const media = focus.media?.find(m => m.src === spec.ui.mediaSource);
        if (media && detailPane.content.querySelector('img')) detailPane.content.querySelector('img').src = media.src;
        else warnings.push('Selected media is unavailable');
      }
    } else { state.unresolvedFocus = spec.ui.focus; warnings.push('Focused item is unavailable'); } }
    state.layoutAspect = spec.flat.view.fitted ? null : spec.flat.aspect;
    state.filtered = filterScope(state.clips, state);
    state.clusters = contextClusters(state.clips, state.filtered, state.facetLabels, state.active);
    renderScope(); renderContext();
    await frames(); render();
    if (spec.spatial) {
      await toggleSpatial(true);
      if (!state.spatial?.built) throw new Error('Spatial renderer could not be loaded');
      state.spatial.restoreView(spec.spatial);
    }
    if (state.spatialOn !== (spec.presentation.mode === '3d')) await toggleSpatial(spec.presentation.mode === '3d');
    await frames();
    if (spec.flat.view.fitted) viewport.fit();
    else {
      const r = el.stage.getBoundingClientRect(), old = spec.flat.stage, view = spec.flat.view;
      const ratio = Math.min(r.width / old.w, r.height / old.h);
      const scale = view.scale * ratio;
      viewport.restore({ ...view, scale, x: r.width / 2 - (old.w / 2 - view.x) * ratio, y: r.height / 2 - (old.h / 2 - view.y) * ratio });
    }
    setBackgroundRevealed(!!spec.ui.context);
    await frames();
    linkNotice(warnings.join(' · '));
  } finally { hydrating = false; document.body.inert = false; delete document.body.dataset.restoring; }
}

/* ---------------------------------------------------------------- data --- */

async function boot() {
  let data;
  try {
    const res = await fetch('data/clips.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    showEmpty('Could not reach the clipwall server.', String(err.message || err));
    return;
  }

  state.clips = Array.isArray(data.clips) ? data.clips : [];
  // Production supplies a server-computed SHA revision. Legacy adapters and
  // fixture origins must still render when Web Crypto is unavailable.
  let revision = 'unversioned';
  if (!data.corpus && crypto.subtle) revision = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(canonical(state.clips))))].map(b => b.toString(16).padStart(2, '0')).join('');
  state.corpus = data.corpus || { id: `legacy:${location.origin}:${data.ui?.title || ''}`, revision };
  state.facets = data.facets || {};
  state.facetLabels = data.ui?.facetLabels || {};
  if (typeof data.ui?.title === 'string') {
    document.title = data.ui.title;
    document.querySelector('.brand').textContent = data.ui.title;
  }
  if (Array.isArray(data.ui?.facetOrder)) facetOrder = data.ui.facetOrder.filter(k => typeof k === 'string');
  buildFacetRail();
  buildGroupOptions();
  buildReviewControls();
  if ([...el.group.options].some(opt => opt.value === data.ui?.defaultGroup)) {
    state.groupKey = data.ui.defaultGroup;
    el.group.value = state.groupKey;
  }
  applyFilters();
  await frames();
  await links.start();
  document.body.dataset.viewReady = 'true';
}

function scopeLabel() {
  const parts = [...state.active].filter(([, values]) => values.size).map(([key, values]) =>
    `${state.facetLabels[key] || key}: ${[...values].join(' or ')}`);
  if (state.query.trim()) parts.unshift(`Search: ${state.query.trim()}`);
  if (state.branches) parts.unshift(state.branches.map(b => b.label).join(' OR '));
  return parts.join(' · ') || 'All content';
}
function scopeSnapshot() {
  return { query: state.query, active: new Map([...state.active].map(([k, v]) => [k, new Set(v)])),
    branches: state.branches?.map(b => ({ label: b.label, keys: [...b.keys] })) ?? null,
    groupKey: state.groupKey, view: viewport.snapshot() };
}
function rememberScope() {
  if (links?.ready) { void links.flush(); return; }
  state.scopeHistory.push(scopeSnapshot());
  if (state.scopeHistory.length > 30) state.scopeHistory.shift();
}
function selectCluster(cluster, add) {
  rememberScope();
  // Freeze the exact previewed membership. Refinements are consumed into the base
  // branch before a union, so an old query cannot silently exclude added members.
  const plainUnion = state.branches && !state.query.trim() && ![...state.active.values()].some(v => v.size);
  state.branches = add && plainUnion
    ? [...state.branches, { label: cluster.label, keys: [...cluster.keys] }]
    : chooseCluster(state.filtered, cluster, add, scopeLabel());
  state.query = ''; state.active.clear(); el.search.value = '';
  closeDetail(); buildFacetRail(); applyFilters();
  document.getElementById('scope-back').focus();
}
let filterFrame = 0;
function applyFilters({ restore = null } = {}) {
  if (!restore) state.layoutAspect = null;
  cancelAnimationFrame(filterFrame);
  if (!state.query.trim()) state.contextBase = null; // no search, no pre-search place
  setBackgroundRevealed(false);
  state.filtered = filterScope(state.clips, state);
  state.clusters = contextClusters(state.clips, state.filtered, state.facetLabels, state.active);
  renderScope(); renderContext();
  if (state.spatial?.built) refreshSpatial();
  render();
  filterFrame = requestAnimationFrame(() => {
    if (restore) viewport.restore(restore);
    else viewport.fit();
  });
}
function renderScope() {
  const host = document.getElementById('scope-bar');
  const scoped = !!state.branches || !!state.query.trim() || [...state.active.values()].some(v => v.size);
  host.hidden = !state.permalinkBar && !scoped && !(links?.ready ? links.canBack : state.scopeHistory.length);
  document.body.classList.toggle('has-scope', !host.hidden);
  document.getElementById('scope-back').disabled = links?.ready ? !links.canBack : !state.scopeHistory.length;
  const summary = document.getElementById('scope-summary');
  summary.replaceChildren();
  if (state.branches) for (const [index, branch] of state.branches.entries()) {
    if (index) summary.append(document.createTextNode(' OR '));
    const button = document.createElement('button'); button.className = 'btn scope-branch';
    button.textContent = `${branch.label} ×`;
    button.setAttribute('aria-label', `Remove ${branch.label}`);
    button.addEventListener('click', () => {
      rememberScope(); state.branches.splice(index, 1); applyFilters();
      document.getElementById('scope-back').focus();
    });
    summary.append(button);
  }
  const text = document.createElement('span');
  text.textContent = state.branches ? (state.branches.length ? ' · Search and facets refine this union' : 'Empty scope') : scopeLabel();
  summary.append(text);
  // Keep rail truth in sync after history and scope replacement.
  for (const chip of el.rail.querySelectorAll('[data-facet]'))
    chip.setAttribute('aria-pressed', String(state.active.get(chip.dataset.facet)?.has(chip.dataset.value) || false));
}
function renderContext() {
  const host = document.getElementById('context-clusters');
  host.hidden = true; // Cluster suggestions keep their mechanics; their placement is undecided.
  const list = document.getElementById('context-list'); list.replaceChildren();
  const hint = document.getElementById('context-preview');
  const instruction = 'Click to switch · Shift-click or Add to combine';
  hint.textContent = instruction;
  for (const cluster of state.clusters) {
    const card = document.createElement('article'); card.className = 'context-cluster'; card.dataset.cluster = cluster.id;
    const button = document.createElement('button'); button.className = 'cluster-select'; button.type = 'button';
    button.setAttribute('aria-label', `${cluster.label}: switch to ${cluster.keys.length} items outside the current scope`);
    const title = document.createElement('strong'); title.textContent = `${cluster.label} · ${cluster.keys.length}`;
    const reason = document.createElement('span'); reason.className = 'cluster-reason'; reason.textContent = cluster.reason;
    const montage = document.createElement('span'); montage.className = 'cluster-montage';
    const samples = Array.from({ length: Math.min(6, cluster.members.length) }, (_, i) =>
      cluster.members[Math.floor(i * cluster.members.length / Math.min(6, cluster.members.length))]);
    for (const clip of samples) {
      const src = clip.cover || clip.media?.[0]?.src;
      if (src) { const img = document.createElement('img'); img.src = src; img.alt = ''; img.draggable = false; montage.append(img); }
      else { const fallback = document.createElement('span'); fallback.textContent = clip.title || 'No image'; montage.append(fallback); }
    }
    button.append(title, montage, reason);
    const preview = () => { hint.textContent = `Switch: ${cluster.keys.length} items · Add: ${new Set([...state.filtered.map(clipKey), ...cluster.keys]).size} total`; };
    button.addEventListener('pointerenter', preview); button.addEventListener('focus', preview);
    card.addEventListener('pointerleave', () => { hint.textContent = instruction; });
    button.addEventListener('click', e => selectCluster(cluster, e.shiftKey));
    // Native Space activation loses modifier state in some engines; capture it explicitly.
    button.addEventListener('keydown', e => {
      if (e.shiftKey && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault(); selectCluster(cluster, true);
      }
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'btn cluster-add'; add.textContent = 'Add';
    add.setAttribute('aria-label', `Add ${cluster.label}`); add.addEventListener('click', () => selectCluster(cluster, true));
    add.addEventListener('focus', preview);
    card.append(button, add); list.append(card);
  }
}
/* ---------------------------------------------------- background plane --- */

/**
 * The full corpus stays laid out behind a filtered foreground, framed around
 * the working subset with its own stable geometry. Zooming out below Fit
 * reveals it; Fit, a scope change or 3D dismiss it. It never changes Fit
 * content, the match count, or membership: it is context, not scope.
 */
const bgPlane = document.getElementById('bg-plane');
function contextClips() { return state.contextBase?.clips ?? state.clips; }
function backgroundKey() {
  const base = contextClips();
  return [state.groupKey, state.sort.key, state.sort.direction, state.renderAspect.toFixed(3), base.length,
    state.contextBase ? state.contextBase.label : 'all'].join('|');
}
function renderBackground(foreground) {
  const base = contextClips();
  const inBase = new Set(base.map(clipKey));
  // Results that share nothing with the pre-search place have no context there: the plane fades away.
  const overlap = state.filtered.some(c => inBase.has(clipKey(c)));
  const wanted = state.filtered.length > 0 && state.filtered.length < base.length && overlap;
  if (!wanted) { state.background.framed = null; unmountBackground(); return; }
  const key = backgroundKey();
  if (state.background.key !== key || !state.background.full) {
    state.background.key = key;
    state.background.full = layout(sortClips(base, state.sort), state.groupKey, { viewportAspect: state.renderAspect });
  }
  state.background.framed = frameAround(state.background.full, { w: foreground.width, h: foreground.height });
  state.background.foreground = { w: foreground.width, h: foreground.height };
  if (state.contextVisible) mountBackground(); else unmountBackground();
}
/**
 * Depth and tilt of the plane, in world units so they scale with the camera.
 * The pivot is the foreground's centre line: above it the plane recedes, below
 * it comes forward but stays behind the foreground (depth exceeds the tilt's
 * forward reach at the plane's far edge). Parallax on pan follows for free.
 */
const BG_TILT_DEG = 10, BG_PERSPECTIVE = 1400;
function backgroundDepth() {
  const { framed, foreground } = state.background;
  if (!framed || !foreground) return null;
  const reach = (framed.bounds.h / 2 + Math.abs(framed.bounds.y)) * Math.sin(BG_TILT_DEG * Math.PI / 180);
  return { depth: Math.max(framed.bounds.h * 0.25, reach * 1.2), px: foreground.w / 2, py: foreground.h / 2 };
}
/**
 * The plane's internal scale: its content is laid out at roughly stage size in
 * CSS px and the transform multiplies back up. Chrome rasterises a perspective
 * layer at 1 CSS px per unit whatever the camera, so this bounds its texture
 * to about a screen instead of the full world (~10k px across).
 */
function planeScale(stage) {
  const b = state.background.framed?.bounds;
  if (!b || !b.w || !b.h) return 1;
  const base = Math.min(1, 1.25 * Math.min(stage.w / b.w, stage.h / b.h));
  // Zoomed into the plane, track the camera: a perspective layer rasterises at
  // its local size, so text set at 2px local never survives rasterisation
  // whatever the GPU scales it to. Local units at ~screen resolution keep
  // headings at their readable size and covers crisp.
  return Math.min(1, Math.max(base, viewport.scale));
}
function mirrorBackground(view, transition) {
  const d = backgroundDepth(), m = state.background.m, st = state.background.stage;
  if (!d || !m || !st) return;
  const k = view.scale / m;
  bgPlane.style.transition = [transition, 'opacity 0.35s ease'].filter(Boolean).join(', ');
  // Vanishing point at the stage centre, then the shared camera, then depth and
  // tilt about the foreground's centre line, all in the plane's internal units.
  bgPlane.style.transform = `translate(${st.w / 2}px, ${st.h / 2}px) perspective(${BG_PERSPECTIVE}px) translate(${-st.w / 2}px, ${-st.h / 2}px) `
    + `translate3d(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px, 0) scale3d(${k.toFixed(5)}, ${k.toFixed(5)}, ${k.toFixed(5)}) `
    + `translate(${d.px * m}px, ${d.py * m}px) translateZ(${-d.depth * m}px) rotateX(${BG_TILT_DEG}deg) translate(${-d.px * m}px, ${-d.py * m}px)`;
}
function planeLabelSizes(s) {
  const m = state.background.m; if (!m) return;
  const headingSize = Math.min(28, 14 + 5 * Math.log2(1 + s));
  bgPlane.style.setProperty('--group-heading-size', `${headingSize * m / s}px`);
  bgPlane.style.setProperty('--group-count-size', `${Math.max(12, headingSize * 0.74) * m / s}px`);
  bgPlane.style.setProperty('--group-label-unit', `${m / s}px`);
}
viewport.mirror = mirrorBackground;
function mountBackground() {
  const framed = state.background.framed;
  if (!framed) return;
  const inScope = new Set(state.filtered.map(clipKey));
  const seen = new Set();
  state.bgPositions.clear();
  const r = el.stage.getBoundingClientRect();
  state.background.stage = { w: r.width, h: r.height };
  const m = state.background.m = planeScale(state.background.stage);
  for (const stale of bgPlane.querySelectorAll('.block')) stale.remove();
  state.bgBlockEls = framed.blocks.map(b => { const node = buildBlock({ ...b, x: b.x * m, y: b.y * m, w: b.w * m, h: b.h * m }); bgPlane.append(node); return node; });
  for (const t of framed.tiles) {
    const key = JSON.stringify(['bg', t.group ?? '', t.clip.id]);
    seen.add(key); state.bgPositions.set(key, t); // world units, for culling
    let node = state.bgTileEls.get(key);
    if (!node) { node = buildTile(t.clip, { background: true }); state.bgTileEls.set(key, node); }
    if (!node.isConnected) bgPlane.append(node);
    node.classList.toggle('in-scope', inScope.has(clipKey(t.clip)));
    node.classList.toggle('selected', t.clip.id === state.selected);
    node.style.width = `${t.w * m}px`; node.style.height = `${t.h * m}px`;
    node.style.transform = `translate(${t.x * m}px, ${t.y * m}px)`;
  }
  planeLabelSizes(viewport.scale);
  for (const [key, node] of state.bgTileEls) if (!seen.has(key)) { node.remove(); state.bgTileEls.delete(key); }
  bgPlane.classList.toggle('search-context', !!state.contextBase);
  bgPlane.hidden = false;
  mirrorBackground({ x: viewport.x, y: viewport.y, scale: viewport.scale }, el.canvas.style.transition);
  state.background.mounted = true;
  // Bounded/edge pan may now reach the whole plane; Fit content stays the foreground.
  viewport.setItems([...state.positions.values(), ...framed.tiles]);
  updateVisibility();
}
function unmountBackground() {
  if (!state.background.mounted) return;
  bgPlane.hidden = true;
  for (const node of state.bgTileEls.values()) node.remove();
  for (const stale of bgPlane.querySelectorAll('.block')) stale.remove();
  state.bgPositions.clear();
  state.background.mounted = false;
  viewport.setItems([...state.positions.values()]);
}
function setBackgroundRevealed(on) {
  state.contextVisible = !!on;
  if (state.contextVisible) {
    mountBackground();
    // Mount first, then fade: a class set in the same frame as the mount skips the transition.
    requestAnimationFrame(() => { el.canvas.classList.toggle('bg-revealed', state.contextVisible); bgPlane.classList.toggle('revealed', state.contextVisible); });
  } else {
    el.canvas.classList.remove('bg-revealed'); bgPlane.classList.remove('revealed');
    unmountBackground();
  }
}
// Reveal latches on zooming out below Fit. Zooming back in keeps it, so a
// background item can be inspected; only Fit, a scope change or 3D clear it.
function updateBackgroundVisibility(r = el.stage.getBoundingClientRect()) {
  if (state.spatialOn || state.contextVisible || !state.background.framed) return;
  const pad = viewport.fitPadding(r);
  const fittedScale = Math.min((r.width - 2 * pad) / viewport.content.w, (r.height - 2 * pad) / viewport.content.h);
  const relativeScale = viewport.scale / Math.min(6, fittedScale);
  if (relativeScale < 0.9) setBackgroundRevealed(true);
}
// A revealed cluster can appear under the wheel pointer. Keep explicit canvas
// zoom routed to the same camera rather than falling through to browser zoom.
document.getElementById('context-clusters').addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault(); viewport.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * .01));
  }
}, { passive: false });
document.getElementById('scope-back').addEventListener('click', () => {
  if (links?.ready) { links.back(); return; }
  const previous = state.scopeHistory.pop(); if (!previous) return;
  Object.assign(state, { query: previous.query, active: previous.active, branches: previous.branches, groupKey: previous.groupKey });
  el.search.value = state.query; el.group.value = state.groupKey;
  closeDetail(); buildFacetRail(); applyFilters({ restore: previous.view });
});
document.getElementById('scope-clear').addEventListener('click', () => {
  rememberScope(); state.query = ''; state.active.clear(); state.branches = null;
  el.search.value = ''; closeDetail(); buildFacetRail(); applyFilters();
});

/* ------------------------------------------------------------- spatial --- */

/**
 * The 3D view is loaded on demand. It costs a WebGL context, three.js off a
 * CDN and ~100 MB of texture atlas — none of which a session that never opens
 * it should pay for, and all of which would make the flat wall's first paint
 * slower for no reason.
 */
async function toggleSpatial(on) {
  if (state.spatialLoading) return;
  if (on && !state.spatial) {
    state.spatialLoading = true;
    try {
      const { SpatialView, keyOfClip } = await import('/wall/spatial/spatial-view.mjs');
      state.clipKey = keyOfClip;
      state.spatial = new SpatialView(el.spHost, { onOpen: openDetail });
      await loadViewState();
    } catch (err) {
      // three.js comes from a CDN; offline, this is the failure. Say so rather
      // than leaving a blank panel and a working-looking button.
      showEmpty('Could not start the spatial view.', String(err.message || err));
      el.empty.classList.remove('hidden');
      return;
    } finally {
      state.spatialLoading = false;
    }
  }
  viewport.resetEdge();
  viewport.enabled = !on;
  document.getElementById('edge-feedback').hidden = on;
  document.getElementById('pan-behavior').disabled = on;
  document.getElementById('pan-behavior').title = on
    ? 'Pan comparison is available in the flat view' : 'Experimental flat-canvas pan behavior';
  state.spatialOn = on;
  brush.setEnabled(!on);
  for (const id of ['sort-key', 'sort-direction', 'attribute-lens']) document.getElementById(id).disabled = on;
  updateSortDirection();
  document.querySelector('#review-tip .brush-idle').textContent = on ? 'Attribute exploration is available in the flat view' : 'Hover a heading to explore its distribution · hover a value to find matches · click a heading to pin';
  renderContext();
  if (on) setBackgroundRevealed(false);
  el.spHost.hidden = !on;
  el.canvas.style.visibility = on ? 'hidden' : '';
  el.view3d.setAttribute('aria-pressed', String(on));
  el.view3d.classList.toggle('on', on);
  if (!on) updateBackgroundVisibility();
  if (on) {
    refreshSpatial();
    document.getElementById('sp-css3d')?.focus();
  }
}

function refreshSpatial() {
  // The scene and current clip map must exist BEFORE restoring URL-keyed piles.
  state.spatial.setClips(state.filtered, state.groupKey);
  const doc = state.arrangementOverride || state.viewState.doc;
  if (doc?.piles?.length && doc.mode !== 'mountain') state.spatial.restore(doc);
  else if (state.groupKey !== 'none') state.spatial.showPiles(state.groupKey);
}

function viewStateError(message, err) {
  state.viewStateError = message;
  console.warn(`[clipwall] ${message}:`, err.message);
  renderCount();
}

/** Pile membership persists as view state — never as a write to a note. */
async function loadViewState() {
  try {
    const doc = await state.viewState.load();
    if (!hydrating && [...el.group.options].some((opt) => opt.value === doc.groupKey)) {
      state.groupKey = doc.groupKey;
      el.group.value = doc.groupKey;
    }
    const known = new Set(state.clips.map(state.clipKey));
    const orphaned = (doc.piles || []).flatMap((p) => p.keys).filter((key) => !known.has(key));
    if (orphaned.length) {
      console.warn(`[clipwall] view state: ${orphaned.length} keys no longer resolve; retained in saved state`, orphaned.slice(0, 8));
    }
  } catch (err) {
    viewStateError('Saved piles not loaded — reload to retry', err);
  }
}

async function saveViewState() {
  if (!state.spatial || hydrating) return;
  try {
    const doc = mergePileState({
      ...state.spatial.serialize(),
      mode: state.spatial.mode,
      groupKey: state.groupKey,
    }, state.viewState.doc, new Set(state.filtered.map(state.clipKey)));
    await state.viewState.save(doc);
    state.viewStateError = '';
    renderCount();
  } catch (err) {
    viewStateError('View not saved — change grouping to retry', err);
  }
}

/* -------------------------------------------------------------- render --- */

function render() {
  const bounds = el.stage.getBoundingClientRect();
  const pad = viewport.fitPadding();
  state.renderAspect = state.layoutAspect || Math.max(1, bounds.width - pad * 2) / Math.max(1, bounds.height - pad * 2);
  const result = layout(sortClips(state.filtered, state.sort), state.groupKey, {
    viewportAspect: state.renderAspect
  });

  viewport.setContent(result.width, result.height, result.tiles);
  el.canvas.style.width = `${result.width}px`;
  el.canvas.style.height = `${result.height}px`;

  state.blocks = result.blocks;
  // Review order for Dive traversal: the laid-out order, one entry per clip.
  { const seen = new Set(); state.order = []; for (const t of result.tiles) if (!seen.has(t.clip.id)) { seen.add(t.clip.id); state.order.push(t.clip); } }
  renderBlocks(result.blocks);
  renderTiles(result.tiles);
  renderBackground(result);
  brush.refresh();

  renderCount();

  const nothing = state.filtered.length === 0;
  el.empty.classList.toggle('hidden', !nothing);
  if (nothing) {
    showEmpty(
      state.clips.length ? 'No clips match these filters.' : 'The vault is empty.',
      state.clips.length ? 'Clear the filters, or widen the search.' : null
    );
  }
  updateVisibility();
}

function renderCount() {
  el.count.replaceChildren();
  const strong = document.createElement('b');
  strong.textContent = String(state.filtered.length);
  el.count.append(strong, document.createTextNode(` of ${state.clips.length} clips`));
  if (state.viewStateError) el.count.append(document.createTextNode(` · ${state.viewStateError}`));
}

function renderBlocks(blocks) {
  for (const stale of el.canvas.querySelectorAll(':scope > .block')) stale.remove();
  state.blockEls = blocks.map(b => { const node = buildBlock(b); el.canvas.append(node); return node; });
  updateTightBlocks(viewport.scale);
}

/**
 * A heading has a readable floor, so at overview scale a long tail of tiny
 * groups (one-album artists) would carry labels larger than their covers.
 * The rule is text size to image size: a block drops its heading when the
 * heading on screen would be taller than the covers it names (ratio above
 * TIGHT_TEXT_RATIO), or when the block is too narrow to fit a label at all.
 * The heading returns as zoom grows the covers past the text.
 */
const TIGHT_BLOCK_PX = 96, TIGHT_TEXT_RATIO = 1.2;
function headingScreenPx(s) { return Math.min(28, 14 + 5 * Math.log2(1 + s)); }
function updateTightBlocks(s) {
  const text = headingScreenPx(s);
  const mark = (blocks, nodes) => { if (!blocks || !nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const b = blocks[i];
      nodes[i].classList.toggle('tight', b.w * s < TIGHT_BLOCK_PX || text > (b.tileH || 240) * s * TIGHT_TEXT_RATIO);
    } };
  mark(state.blocks, state.blockEls);
  if (state.background.mounted) mark(state.background.framed?.blocks, state.bgBlockEls);
}

function buildBlock(b) {
  const div = document.createElement('div');
  div.className = 'block';
  div.style.width = `${b.w}px`;
  div.style.height = `${b.h}px`;
  div.style.transform = `translate(${b.x}px, ${b.y}px)`;

  div.dataset.tileH = String(Math.round(b.tileH || 0));
  const h2 = document.createElement('h2');
  h2.textContent = b.label;                       // untrusted: textContent only
  // A heading is a control: it narrows the working set to that group. On the
  // context plane this is the scope pivot; in the foreground it is a group Dive.
  if (b.label && b.label !== '—') {
    h2.tabIndex = 0; h2.setAttribute('role', 'button');
    h2.setAttribute('aria-label', `${b.label}: show only this ${state.facetLabels[state.groupKey] || state.groupKey}, ${b.count} items`);
    h2.addEventListener('click', e => { if ((viewport.lastDragDistance || 0) > 4) return; selectGroup(b.label, e.shiftKey); });
    h2.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectGroup(b.label, e.shiftKey); } });
  }
  const n = document.createElement('span');
  n.textContent = String(b.count);
  h2.append(n);

  div.append(h2);
  return div;
}

function renderTiles(tiles) {
  const seen = new Set();
  state.positions.clear();

  for (const t of tiles) {
    const { clip } = t;
    const key = JSON.stringify([t.group ?? '', clip.id]);
    seen.add(key);
    state.positions.set(key, t);

    let node = state.tileEls.get(key);
    if (!node) {
      node = buildTile(clip);
      state.tileEls.set(key, node);
      el.canvas.append(node);
    }
    node.classList.toggle('selected', clip.id === state.selected);
    node.style.width = `${t.w}px`;
    node.style.height = `${t.h}px`;
    node.style.transform = `translate(${t.x}px, ${t.y}px)`;
  }

  for (const [id, node] of state.tileEls) {
    if (!seen.has(id)) {
      node.remove();
      state.tileEls.delete(id);
    }
  }
  const orderedNodes = tiles.map(t => state.tileEls.get(JSON.stringify([t.group ?? '', t.clip.id])));
  const currentNodes = [...el.canvas.querySelectorAll(':scope > .tile')];
  if (orderedNodes.some((node, index) => node !== currentNodes[index])) {
    const focused = document.activeElement;
    for (const node of orderedNodes) el.canvas.append(node);
    if (focused?.classList.contains('tile') && focused.isConnected) focused.focus({ preventScroll: true });
  }

}

function buildTile(clip, { background = false } = {}) {
  const node = document.createElement('div');
  node.className = background ? 'tile bg' : 'tile';
  // Background items are mouse-reachable context, not a second tab order
  // through the whole corpus; the facet rail remains the keyboard route.
  node.tabIndex = background ? -1 : 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', clip.title || 'clip');
  if (background) node.title = clip.title || '';

  const src = clip.cover || clip.media?.[0]?.src || '';
  if (src) {
    const img = document.createElement('img');
    img.alt = '';                    // decorative; the caption carries the name
    img.dataset.src = src;
    if (Array.isArray(clip.coverVariants) && clip.coverVariants.length) {
      img.dataset.srcset = clip.coverVariants.filter(v => typeof v.src === 'string' && Number.isFinite(v.width) && v.width > 0)
        .map(v => `${v.src} ${Math.round(v.width)}w`).join(', ');
    }
    img.draggable = false; // native image dragging cancels the canvas pointer gesture
    img.decoding = 'async';
    // A dead attachment must not leave an invisible hole in the wall.
    img.addEventListener('error', () => node.classList.add('broken'), { once: true });
    node.append(img);
  } else {
    node.classList.add('no-media');
    const fb = document.createElement('div');
    fb.className = 'fallback';
    fb.textContent = clip.title || clip.url || '';
    node.append(fb);
  }

  const cap = document.createElement('div');
  cap.className = 'cap';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = clip.title || '(untitled)';
  const m = document.createElement('div');
  m.className = 'm';
  m.textContent = [clip.source, clip.captured, (clip.tags || []).join(' · ')]
    .filter(Boolean)
    .join('  ·  ');
  cap.append(t, m);
  node.append(cap);

  const open = () => openDetail(clip);
  node.addEventListener('click', () => {
    // Suppress the click that ends a pan; 4px of slop covers a shaky trackpad.
    if ((viewport.lastDragDistance || 0) > 4) return;
    open();
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return node;
}

/* ------------------------------------------------- visibility & zoom  --- */

let labelScaleApplied = 0;
function onViewportChange(v) {
  const s = v.scale;
  // Read layout before any style write: a rect read after a write forces a
  // synchronous layout of every tile, on every frame of a zoom gesture.
  const stageRect = el.stage.getBoundingClientRect();
  // Screen-space label sizes are expressed in world units, so they would change
  // on every frame. Re-apply them only once the zoom has drifted ~8% from the
  // last applied value; between updates the compositor scales the text raster,
  // which is smoother than re-laying out every heading per frame.
  if (!labelScaleApplied || Math.abs(Math.log(s / labelScaleApplied)) > 0.08) {
    labelScaleApplied = s;
    // Set on the stage so the background plane, a sibling layer, inherits them.
    el.stage.style.setProperty('--label-scale', String(Math.max(1, 1 / s)));
    // Group names must survive overview zoom, while still responding to zoom.
    const headingSize = Math.min(28, 14 + 5 * Math.log2(1 + s));
    el.stage.style.setProperty('--group-heading-size', `${headingSize / s}px`);
    el.stage.style.setProperty('--group-count-size', `${Math.max(12, headingSize * 0.74) / s}px`);
    el.stage.style.setProperty('--group-label-unit', `${1 / s}px`);
    if (state.background.mounted) {
      // Re-layout the plane at a new internal scale once the camera has drifted
      // a factor of two from it (only while zoomed in past its base scale).
      const m = state.background.m;
      if (m < 1 && Math.abs(Math.log2(s / m)) > 1 && Math.max(s, m) > planeScale(state.background.stage) * 0.99 + 1e-9 && s !== m) mountBackground();
      else planeLabelSizes(s);
    }
    updateTightBlocks(s);
  }
  if (state.background.mounted) state.background.stage = { w: stageRect.width, h: stageRect.height };
  el.canvas.classList.toggle('z-far', s < 0.32);
  el.canvas.classList.toggle('z-near', s > 1.15);
  updateVisibility({ rect: stageRect, defer: true });
  updateBackgroundVisibility(stageRect);
  updateRowTitle(stageRect);
}

/** Narrow the working set to one group of the current grouping (Shift adds it to the current values). */
function selectGroup(value, add = false) {
  const key = state.groupKey;
  if (!key || key === 'none') return;
  rememberScope();
  const current = state.active.get(key);
  const next = add && current ? new Set(current) : new Set();
  next.add(value);
  state.active.set(key, next);
  closeDetail(); buildFacetRail(); applyFilters();
}

/* ------------------------------------------------------------ row title --- */

/**
 * When zooming in crops a group's heading off the top of the stage, name the
 * group under the viewport in screen space. The title follows the block at a
 * third of pan speed, is pushed off by the next block's top edge, and steps to
 * the neighbouring group on activation. It reads the camera; it never sets
 * layout, membership or the camera except through an explicit step.
 */
const rowTitle = document.getElementById('row-title');
let rowTitleLabel = '', rowTitleWidth = 0;
/** Foreground blocks in screen space, plus the context plane's blocks projected
 *  by its depth (an approximation along the pivot line; the tilt is ignored). */
function screenBlocks(stageRect) {
  const s = viewport.scale;
  const flat = (state.blocks || []).map(b => ({ b, layer: 'focus', x: b.x * s + viewport.x, y: b.y * s + viewport.y, w: b.w * s, h: b.h * s }));
  if (!state.background.mounted || !state.background.framed) return flat;
  const d = backgroundDepth(); if (!d) return flat;
  const f = BG_PERSPECTIVE / (BG_PERSPECTIVE + d.depth * s), cx = stageRect.width / 2, cy = stageRect.height / 2;
  const plane = state.background.framed.blocks.map(b => ({ b, layer: 'context',
    x: cx + (b.x * s + viewport.x - cx) * f, y: cy + (b.y * s + viewport.y - cy) * f, w: b.w * s * f, h: b.h * s * f }));
  return flat.concat(plane);
}
function dominantBlock(stageRect) {
  const W = stageRect.width, H = stageRect.height;
  let best = null, bestArea = 0;
  for (const r of screenBlocks(stageRect)) {
    const area = Math.max(0, Math.min(W, r.x + r.w) - Math.max(0, r.x)) * Math.max(0, Math.min(H, r.y + r.h) - Math.max(0, r.y));
    if (area > bestArea) { bestArea = area; best = r; }
  }
  return best;
}
function updateRowTitle(stageRect) {
  const grouped = state.groupKey && state.groupKey !== 'none';
  const best = !state.spatialOn && grouped ? dominantBlock(stageRect) : null;
  // The pinned title appears once the block's own heading is cropped off the top,
  // or (on the context plane) its label's left edge is off the stage.
  const headingOff = best && (best.y + HEADER_H * viewport.scale > 0 ? false : true);
  const leftOff = best && best.layer === 'context' && best.x < 0;
  if (!best || !(headingOff || leftOff)) { rowTitle.hidden = true; return; }
  const list = best.layer === 'context' ? state.background.framed.blocks : state.blocks;
  const index = list.indexOf(best.b), n = list.length;
  const label = `${best.layer}\u0000${best.b.label || 'Ungrouped'}\u0000${best.b.count}\u0000${index + 1}/${n}`;
  if (label !== rowTitleLabel) {
    rowTitleLabel = label;
    rowTitle.querySelector('strong').textContent = best.b.label || 'Ungrouped';
    rowTitle.querySelector('.n').textContent = String(best.b.count);
    rowTitle.querySelector('.pos').textContent = `${index + 1} of ${n}`;
    rowTitle.querySelector('.rt-focus').setAttribute('aria-label', `${best.b.label}, ${best.b.count} items, group ${index + 1} of ${n}${best.layer === 'context' ? ', on the context plane' : ''}. Show only this group`);
    rowTitle.dataset.layer = best.layer;
    rowTitle.hidden = false;
    rowTitleWidth = rowTitle.offsetWidth; // measured only when the text changes
  }
  rowTitle.dataset.index = String(index);
  rowTitle.dataset.label = best.b.label || '';
  // Sticky push-off: the next block's top edge pushes the title up and away.
  let push = 0;
  for (const r of screenBlocks(stageRect)) if (r !== best && r.y > 0 && r.y < 46) push = Math.max(push, 46 - r.y);
  // Parallax: drift with the block's left edge at a third of its speed, kept on stage.
  const x = Math.max(12, Math.min(stageRect.width - rowTitleWidth - 12, 12 + best.x * 0.35));
  rowTitle.style.transform = `translate(${x.toFixed(1)}px, ${(-push).toFixed(1)}px)`;
  rowTitle.hidden = false;
}
/** Ease the camera so the neighbouring group's heading sits just below the stage top. */
function stepGroup(delta) {
  if (state.spatialOn || !state.blocks?.length) return;
  const r = el.stage.getBoundingClientRect(), s = viewport.scale;
  const current = dominantBlock(r);
  const i = current ? state.blocks.indexOf(current.b) : -1, n = state.blocks.length;
  const b = state.blocks[((i + delta) % n + n) % n];
  const x = b.w * s < r.width ? (r.width - b.w * s) / 2 - b.x * s : 12 - b.x * s;
  viewport.panTo(x, 12 - b.y * s, { duration: 420 });
}
rowTitle.querySelector('.rt-next').addEventListener('click', e => stepGroup(e.shiftKey ? -1 : 1));
rowTitle.querySelector('.rt-focus').addEventListener('click', e => { if (rowTitle.dataset.label) selectGroup(rowTitle.dataset.label, e.shiftKey); });

/**
 * Load images only once they can be seen, and hide the ones that cannot.
 * A vault of a few thousand clippings would otherwise open several thousand
 * concurrent requests on first paint.
 */
let loadTimer = 0, lastLoadFlush = 0;
/**
 * Culling is immediate. Image loads during a gesture are deferred until the
 * camera has been quiet for a moment (bounded to every 250ms mid-gesture), so
 * decodes do not compete with rasterising the zoom itself.
 */
function updateVisibility({ rect = null, defer = false } = {}) {
  const r = viewport.visibleRect(400, rect || undefined);
  const now = performance.now();
  // While an eased zoom is still landing, decodes would pop in mid-flight.
  const inFlight = now < viewport.settlesAt;
  const load = !defer || (!inFlight && now - lastLoadFlush > 250);
  if (load) { lastLoadFlush = now; clearTimeout(loadTimer); loadTimer = 0; }
  else { clearTimeout(loadTimer); loadTimer = setTimeout(() => { loadTimer = 0; updateVisibility(); }, inFlight ? viewport.settlesAt - now + 30 : 120); }
  revealTiles(r, state.tileEls, state.positions, load);
  if (state.background.mounted) {
    // Perspective shrinks the plane toward the stage centre, so a world rect
    // that is off the flat canvas can still be on screen: cull generously.
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, grow = 2;
    revealTiles({ x: cx - r.w * grow / 2, y: cy - r.h * grow / 2, w: r.w * grow, h: r.h * grow }, state.bgTileEls, state.bgPositions, load);
  }
}
function revealTiles(r, tileEls, positions, load) {
  for (const [id, node] of tileEls) {
    const p = positions.get(id);
    if (!p) continue;
    const visible = p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y;
    node.style.visibility = visible ? '' : 'hidden';
    if (!visible || !load) continue;
    const img = node.querySelector('img');
    if (!img) continue;
    if (img.dataset.srcset) {
      // sizes is in screen pixels: CSS transforms do not inform srcset selection.
      const sizes = `${Math.max(1, Math.ceil(p.w * viewport.scale))}px`;
      if (img.sizes !== sizes) img.sizes = sizes;
      if (!img.srcset) img.srcset = img.dataset.srcset;
    }
    if (img.dataset.src) {
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
  }
}

/* -------------------------------------------------------------- facets --- */

function buildFacetRail() {
  el.rail.replaceChildren();
  const keys = [
    ...facetOrder.filter((k) => state.facets[k]),
    ...Object.keys(state.facets).filter((k) => !facetOrder.includes(k) && !FACET_BLOCKLIST.has(k))
  ];

  for (const key of keys) {
    const all = Object.entries(state.facets[key] || {});
    if (all.length < 2) continue;   // a facet with one value filters nothing
    // A long tail of rare values (one-album artists) is noise as chips and is
    // better reached by search. Keep the most frequent, plus anything active.
    const active = state.active.get(key) || new Set();
    const keep = new Set(all.slice().sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FACET_CHIP_LIMIT).map(([v]) => v));
    const values = all.filter(([v]) => keep.has(v) || active.has(v));
    const dropped = all.length - values.length;
    values.sort((a, b) => key === 'captured' || key === 'year'
      ? b[0].localeCompare(a[0]) : b[1] - a[1] || a[0].localeCompare(b[0]));

    const section = document.createElement('div');
    section.className = 'facet';
    const h3 = document.createElement('h3');
    const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'facet-heading'; heading.dataset.attribute = key;
    heading.textContent = state.facetLabels[key] || key;
    brush.bindHeading(heading, key);
    h3.append(heading);
    const chips = document.createElement('div');
    chips.className = 'chips';

    for (const [value, n] of values) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(state.active.get(key)?.has(value) || false));
      chip.dataset.facet = key; chip.dataset.value = value;
      const label = document.createElement('span');
      label.textContent = value;                     // untrusted
      const num = document.createElement('span');
      num.className = 'n';
      num.textContent = String(n);
      chip.append(label, num);
      brush.bindValue(chip, key, value);
      chip.addEventListener('click', () => toggleFacet(key, value, chip));
      chips.append(chip);
    }
    if (dropped > 0) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'chip chip-more';
      more.textContent = `${dropped} more · search`;
      more.title = `${dropped} rarer ${state.facetLabels[key] || key} values are not listed; type one in the search box`;
      more.addEventListener('click', () => el.search.focus());
      chips.append(more);
    }
    section.append(h3, chips);
    el.rail.append(section);
  }
}

function toggleFacet(key, value, chip) {
  rememberScope();
  if (!state.active.has(key)) state.active.set(key, new Set());
  const set = state.active.get(key);
  const on = set.has(value);
  if (on) set.delete(value);
  else set.add(value);
  chip.setAttribute('aria-pressed', String(!on));
  applyFilters();
  closeRailIfNarrow();
}

function buildGroupOptions() {
  const keys = ['none', ...facetOrder.filter((k) => state.facets[k])];
  for (const k of Object.keys(state.facets)) {
    if (FACET_BLOCKLIST.has(k) || keys.includes(k)) continue;
    // Grouping by a near-unique key produces one block per clip; useless.
    if (Object.keys(state.facets[k]).length <= 24) keys.push(k);
  }
  el.group.replaceChildren();
  for (const k of keys) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k === 'none' ? 'no grouping' : state.facetLabels[k] || k;
    el.group.append(opt);
  }
}

function buildReviewControls() {
  const keys = ['title', ...new Set([...facetOrder, ...Object.keys(state.facets)].filter(k => !FACET_BLOCKLIST.has(k) && Object.keys(state.facets[k] || {}).length))];
  for (const [id, value, label] of [['sort-key', state.sort.key, 'Original order'], ['attribute-lens', brush.getPinned() || 'none', 'No lens']]) {
    const select = document.getElementById(id); select.replaceChildren();
    for (const key of ['none', ...keys, ...(!keys.includes(value) && value !== 'none' ? [value] : [])]) {
      const option = document.createElement('option'); option.value = key;
      option.textContent = key === 'none' ? label : state.facetLabels[key] || (key === 'title' ? 'Title' : key);
      select.append(option);
    }
    select.value = value;
  }
  updateSortDirection();
}
function updateSortDirection() {
  const button = document.getElementById('sort-direction');
  const asc = state.sort.direction === 'asc';
  button.textContent = asc ? '↑ Ascending' : '↓ Descending';
  button.setAttribute('aria-label', asc ? 'Sort ascending; reverse to descending' : 'Sort descending; reverse to ascending');
  button.disabled = state.spatialOn || state.sort.key === 'none';
}
function setSort(key, direction = state.sort.direction) {
  if (state.spatialOn) return;
  rememberScope();
  state.sort = { key, direction };
  document.getElementById('sort-key').value = key;
  updateSortDirection();
  state.layoutAspect = null;
  render(); viewport.fit();
}
document.getElementById('sort-key').addEventListener('change', e => setSort(e.target.value));
document.getElementById('sort-direction').addEventListener('click', () => setSort(state.sort.key, state.sort.direction === 'asc' ? 'desc' : 'asc'));
document.getElementById('attribute-lens').addEventListener('change', e => brush.setPinned(e.target.value === 'none' ? null : e.target.value));

/* -------------------------------------------------------------- detail --- */

function openDetail(clip) {
  state.unresolvedFocus = null; state.detailMedia = null;
  state.selected = clip.id;
  for (const [key, node] of state.tileEls) node.classList.toggle('selected', state.positions.get(key)?.clip.id === clip.id);
  for (const [key, node] of state.bgTileEls) node.classList.toggle('selected', state.bgPositions.get(key)?.clip.id === clip.id);

  const d = detailPane.content;
  d.replaceChildren();

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeDetail);
  d.append(close);

  // Traverse the review order without leaving Dive: buttons, arrow keys, or a swipe.
  const order = state.order || [], at = order.findIndex(c => c.id === clip.id);
  if (order.length > 1 && at >= 0) {
    const nav = document.createElement('div'); nav.className = 'detail-nav';
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'btn'; prev.textContent = '‹'; prev.setAttribute('aria-label', 'Previous item'); prev.addEventListener('click', () => stepDetail(-1));
    const pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = `${at + 1} of ${order.length}`;
    const next = document.createElement('button'); next.type = 'button'; next.className = 'btn'; next.textContent = '›'; next.setAttribute('aria-label', 'Next item'); next.addEventListener('click', () => stepDetail(1));
    nav.append(prev, pos, next); d.append(nav);
  }

  const cover = clip.detailCover || clip.cover || clip.media?.[0]?.src;
  if (cover) {
    const img = document.createElement('img');
    img.src = cover;
    img.alt = '';
    d.append(img);
  }

  const h2 = document.createElement('h2');
  h2.textContent = clip.title || '(untitled)';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [clip.source, clip.captured, clip.kind].filter(Boolean).join('  ·  ');
  d.append(h2, meta);

  if (clip.tags?.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const t of clip.tags) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t;
      chips.append(c);
    }
    d.append(chips);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (clip.sourceUrl || clip.url) actions.append(linkButton(clip.sourceLabel || 'Open source ↗', clip.sourceUrl || clip.url, true));
  // The whole point of the Obsidian bootstrap: corrections happen over there.
  if (clip.editUri) actions.append(linkButton('Edit in Obsidian', clip.editUri, false));
  d.append(actions);

  if (Array.isArray(clip.palette)) {
    const palette = document.createElement('div');
    palette.className = 'palette';
    palette.setAttribute('aria-label', 'Extracted palette');
    for (const hex of clip.palette.filter(value => /^#[0-9a-f]{6}$/i.test(value))) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = hex;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, document.createTextNode(hex));
      palette.append(item);
    }
    d.append(palette);
  }

  if (clip.note) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = clip.note;
    d.append(note);
  }

  if (clip.media?.length > 1) {
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    for (const m of clip.media) {
      const img = document.createElement('img');
      img.src = m.src;
      img.alt = '';
      img.addEventListener('click', () => { state.detailMedia = m.src; d.querySelector('img').src = m.src; });
      thumbs.append(img);
    }
    d.append(thumbs);
  }

  detailPane.open();
}

function linkButton(text, href, external) {
  const a = document.createElement('a');
  a.className = 'btn';
  a.textContent = text;
  a.href = href;
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}

/** Open the neighbouring item in review order and bring its tile under the camera at the current scale. */
function stepDetail(delta) {
  const order = state.order || [];
  const i = order.findIndex(c => c.id === state.selected);
  if (i < 0 || order.length < 2) return;
  const clip = order[((i + delta) % order.length + order.length) % order.length];
  openDetail(clip);
  if (state.spatialOn) return;
  const p = [...state.positions.values()].find(t => t.clip.id === clip.id);
  if (!p) return;
  const r = el.stage.getBoundingClientRect(), s = viewport.scale;
  viewport.panTo(r.width / 2 - (p.x + p.w / 2) * s, r.height / 2 - (p.y + p.h / 2) * s, { duration: 300 });
}
// Swipe across the detail pane steps through the review order (phones).
{ let start = null;
  el.detail.addEventListener('pointerdown', e => { start = e.pointerType === 'touch' && !e.target.closest('.detail-resize') ? { x: e.clientX, y: e.clientY } : null; });
  el.detail.addEventListener('pointerup', e => { if (!start) return; const dx = e.clientX - start.x, dy = e.clientY - start.y; start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) stepDetail(dx < 0 ? 1 : -1); });
  el.detail.addEventListener('pointercancel', () => { start = null; }); }

function closeDetail() {
  state.unresolvedFocus = null; state.detailMedia = null;
  detailPane.close();
  state.selected = null;
  for (const node of state.tileEls.values()) node.classList.remove('selected');
  for (const node of state.bgTileEls.values()) node.classList.remove('selected');
}

function showEmpty(title, detail) {
  el.empty.replaceChildren();
  const h2 = document.createElement('h2');
  h2.textContent = title;
  el.empty.append(h2);
  if (detail) {
    const p = document.createElement('p');
    p.textContent = detail;
    el.empty.append(p);
  }
  if (!state.clips.length) {
    const code = document.createElement('code');
    code.textContent = 'node clip.mjs "https://…" --tags govee,game-room --shot';
    el.empty.append(code);
  }
  el.empty.classList.remove('hidden');
}

/* --------------------------------------------------------------- input --- */

el.search.addEventListener('input', () => {
  if (!state.scopeHistory.length || state.scopeHistory.at(-1).query === state.query) rememberScope();
  // Search is the first focus: the place you searched from becomes the context
  // plane, results are the focus, and matches light up where they were.
  if (!state.query.trim() && el.search.value.trim()) state.contextBase = { clips: state.filtered.slice(), label: scopeLabel() };
  state.query = el.search.value;
  applyFilters();
});

el.group.addEventListener('change', () => {
  state.arrangementOverride = null; state.layoutAspect = null;
  state.groupKey = el.group.value;
  if (state.spatialOn && state.spatial) {
    if (state.groupKey === 'none') state.spatial.showMountain();
    else state.spatial.showPiles(state.groupKey);
    saveViewState();
  }
  render();
  requestAnimationFrame(() => viewport.fit());
});

const panBehavior = document.getElementById('pan-behavior');
const edgeFeedback = document.getElementById('edge-feedback');
const edgeUndo = document.getElementById('edge-undo');
panBehavior.addEventListener('change', () => {
  viewport.setPanMode(panBehavior.value);
  const url = new URL(location.href);
  if (panBehavior.value === 'free') url.searchParams.delete('pan');
  else url.searchParams.set('pan', panBehavior.value);
  history.replaceState(history.state, '', url);
});
edgeUndo.addEventListener('click', () => viewport.undoEdge());
el.stage.addEventListener('edge-pan', ({ detail }) => {
  const labels = { limit: 'Collection edge', edge: 'Edge reached · keep dragging to zoom',
    zoom: 'Edge zoom · reverse this drag to undo', done: 'Edge zoom applied · Esc or Undo restores the previous view' };
  edgeFeedback.textContent = labels[detail.phase] || (detail.mode === 'edge'
    ? 'Drag beyond an edge to zoom · wheel scrolling stays bounded'
    : detail.mode === 'bounded' ? 'Panning stops at collection edges' : '');
  edgeUndo.hidden = !detail.canUndo;
});

document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.3));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
function zoomBy(factor) {
  if (state.spatialOn) state.spatial.zoomBy(factor);
  else viewport.zoomBy(factor);
}
function fitWall() {
  state.layoutAspect = null;
  if (state.spatialOn) state.spatial.fitView();
  else { setBackgroundRevealed(false); render(); viewport.fit(); }
}
document.getElementById('zoom-fit').addEventListener('click', fitWall);
/** Phones: the rail is an overlay that starts closed and closes after a choice. */
const narrow = () => matchMedia('(max-width: 700px) and (hover: none)').matches; // phones, not narrow desktop windows
function closeRailIfNarrow() { if (narrow() && !el.rail.classList.contains('hidden')) { el.rail.classList.add('hidden'); el.stage.classList.add('full'); } }
if (narrow()) { el.rail.classList.add('hidden'); el.stage.classList.add('full'); }
document.getElementById('toggle-rail').addEventListener('click', () => {
  el.rail.classList.toggle('hidden');
  el.stage.classList.toggle('full');
});

el.view3d.addEventListener('click', () => toggleSpatial(!state.spatialOn));
window.addEventListener('keydown', (e) => {
  // '3' only when not typing — the search box owns every printable key.
  if (e.key === '3' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable)
      && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleSpatial(!state.spatialOn);
  }
});

el.stage.addEventListener('dblclick', (e) => { if (!state.spatialOn) viewport.zoomAt(e.clientX, e.clientY, 1.9); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.detail.classList.contains('open')) {
    closeDetail(); e.stopPropagation();
  }
}, true);

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (!state.spatialOn && viewport.undoEdge()) { e.preventDefault(); return; }
    closeDetail(); el.search.blur(); return;
  }
  if (typing) return;
  if (state.selected && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest?.('.detail-resize')) {
    e.preventDefault(); stepDetail(e.key === 'ArrowRight' ? 1 : -1); return;
  }

  if (e.key === '/') { e.preventDefault(); el.search.focus(); }
  else if (e.key === '0') fitWall();
  else if (e.key === '=' || e.key === '+') zoomBy(1.3);
  else if (e.key === '-') zoomBy(1 / 1.3);
  else if (e.key === ']') stepGroup(1);
  else if (e.key === '[') stepGroup(-1);
});

// Repack an overview when its usable area changes, including the filter rail.
// While exploring at a custom zoom, preserve the user's camera and positions;
// the next Fit explicitly recomposes for the new viewport.
new ResizeObserver(() => {
  if (hydrating || links?.restoring) return;
  if (!state.spatialOn && viewport.fitted) fitWall();
  else { updateVisibility(); updateBackgroundVisibility(); }
}).observe(el.stage);

const initialPan = new URL(location.href).searchParams.get('pan');
if (['bounded', 'edge'].includes(initialPan)) {
  panBehavior.value = initialPan;
  viewport.setPanMode(initialPan);
}
links = createPermalinks({ capture: captureView, restore: restoreView, notice: linkNotice, onHistory: renderScope });
document.getElementById('copy-view').addEventListener('click', () => links.copy().catch(err => linkNotice(err.message)));
document.getElementById('new-view').addEventListener('click', () => { links.newView(); linkNotice(''); });
boot();
