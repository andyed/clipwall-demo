/**
 * clipwall — the spatial view.
 *
 * The flat wall answers "show me fifty things at once and let me narrow by
 * property". This answers a different question: "which of these belong
 * together, and what is the shape of what I have collected". Same index, same
 * filters, same adapter — a second reading of one corpus, not a second corpus.
 *
 * Everything structural lives in the vendored muriel lib (see lib/VENDOR.md).
 * What is here is clipwall's own: mapping clips onto the field, turning facets
 * into piles, keeping the `obsidian://` deep link on every promoted card, and
 * persisting pile membership as VIEW STATE — an annotation over the corpus,
 * never a write to the notes.
 *
 * SECURITY NOTE: as in wall.mjs, every string here — titles, notes, tags, facet
 * values — comes from scraped third-party pages, and all of it goes into the
 * DOM via textContent. There is no innerHTML path for clip-derived data. The
 * hybrid's build() hook is a node-filling callback for exactly this reason.
 */

import { createScene, makePlane, THREE }
  from './lib/spatial.js';
import { TileField } from './lib/instanced.js';
import { HybridField } from './lib/hybrid.js';
import { PileLayout } from './lib/piles.js';
import { FieldNavigator } from './lib/navigate.js';
import { CardHost, supported as drawableSupported } from './lib/cards.js';
import { RowMotion } from './lib/motion.js';
import { groupBy, layout } from '../layout.mjs';



/** Same fallback as layout.mjs — a clip with no usable dims is assumed 4:3. */
function aspectOfClip(clip) {
  const dim = String(clip.props?.dims?.[0] || clip.props?.dims || '');
  const m = dim.match(/^(\d+)x(\d+)$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return Math.min(4, Math.max(0.3, w / h));
    }
  }
  return 4 / 3;
}

/**
 * The stable key for view state.
 *
 * NOT clip.id. Ids are the note filename (obsidian), the tiddler title
 * (tiddlywiki) or an upstream id (interests) — none of them survive a rename,
 * and clip.mjs builds the filename out of a title slug, which is exactly the
 * thing you correct in Obsidian three weeks later. The URL is what was actually
 * clipped: stable across renames, across retitles, and across swapping the
 * adapter underneath. Id is the fallback for the URL-less.
 */
export const keyOfClip = (clip) => clip.url || `id:${clip.id}`;

/**
 * Route remote images through clipwall's own origin.
 *
 * A texture atlas is a canvas, so a cross-origin image needs the publisher to
 * send CORS headers — the loader has to request crossOrigin="anonymous", and
 * every publisher that does not send Access-Control-Allow-Origin fails
 * silently, leaving a blank tile. Measured on this corpus: plain <img> loads
 * 90% of harvested heroes, the same URLs with crossOrigin load 63%. Serving
 * them same-origin sidesteps the whole problem, and stops leaking a referrer
 * to each publisher on every render besides.
 *
 * Vault media is already same-origin and is left alone.
 */
function proxied(src) {
  // Same-origin media needs no proxy: root-relative (the server) or relative
  // (the static demo, served from a sub-path). Only absolute remote URLs go through it.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) return src;
  if (new URL(src, location.href).origin === location.origin) return src;
  return `/api/proxy?url=${encodeURIComponent(src)}`;
}

export class SpatialView {
  /**
   * @param {HTMLElement} host element to mount into
   * @param {object} hooks
   * @param {(clip:object) => void} hooks.onOpen  open the detail panel
   * @param {(clip:object) => void} [hooks.onHover]  the pointer rests on an item
   * @param {() => void} [hooks.onHoverEnd]  the pointer has left every item
   * @param {() => boolean} [hooks.hoverEnabled]  asked BEFORE each pick, so a
   *   field nobody is previewing costs nothing
   */
  constructor(host, { onOpen, onHover, onHoverEnd, hoverEnabled } = {}) {
    this.host = host;
    this.onOpen = onOpen || (() => {});
    this.onHover = onHover || (() => {});
    this.onHoverEnd = onHoverEnd || (() => {});
    this.hoverEnabled = hoverEnabled || (() => false);
    this._hovered = -1;
    this._hoverFrame = 0;
    this.clips = [];
    this.groupKey = 'none';
    this.built = false;
    this.mode = 'mountain';
  }

  /** Build the scene. Deferred until the view is first shown — a WebGL context
   *  and a 100 MB atlas are not worth creating for a session that never opens
   *  it. */
  _ensureScene() {
    if (this.built) return;
    this.built = true;

    this.host.replaceChildren();
    const webgl = document.createElement('div');
    webgl.id = 'sp-webgl';
    const css3d = document.createElement('div');
    css3d.id = 'sp-css3d';
    this.host.append(webgl, css3d);
    this.backButton = document.createElement('button');
    this.backButton.type = 'button';
    this.backButton.className = 'btn sp-back';
    this.backButton.textContent = '← All stacks';
    this.backButton.hidden = true;
    this.backButton.addEventListener('click', () => { this.collapse(); css3d.focus(); });
    this.host.append(this.backButton);

    const rig = createScene({
      webglMount: '#sp-webgl',
      cssMount: '#sp-css3d',
      container: this.host,          // an app pane, not the window
      cameraPos: [0, 360, 1650],
      lookAt: [0, 560, -950],
      far: 14000,
    });
    Object.assign(this, rig);

    // A reading plane with real stack depth. The old demo slope reserved most
    // of the viewport for a grid and kept moving even when nobody touched it.
    this.surface = { planeToWorld: (u, v, h) => new THREE.Vector3(u, v + h / 2, 0) };
    this.basePos = new THREE.Vector3(0, 0, 1600);
    this.lookTarget = new THREE.Vector3();
    this.motion = new RowMotion({ speed: 0, wrapSpan: 0, sweep: 0 });
    this.motion.setEnabled(false);
    this._replaceField();

    this.nav = new FieldNavigator({
      field: this.field, hybrid: this.hybrid, camera: this.camera,
      container: css3d,
      labelOf: (i) => this._label(i),
      onSelect: (i, centre) => {
        // Selection must not destroy the overview. Pan only when off screen.
        const p = centre.clone().project(this.camera);
        if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) {
          this.panTo(centre.x, centre.y);
        }
      },
      onActivate: (i) => this._activate(i),
      onEscape: () => this.collapse(),
      onGroupStep: (dir) => this._stepPile(dir),
      onTypeAhead: (prefix) => this._jumpPile(prefix),
    });

    const selectFirst = this.nav.selectFirstVisible.bind(this.nav);
    this.nav.selectFirstVisible = () => {
      if (this.mode !== 'piles' || !this.piles.piles.length) return selectFirst();
      const tops = this.piles.piles.filter(p => p.indices.length).map(p => p.indices.at(-1));
      tops.sort((a, b) => {
        const pa = this.field.worldCentre(a, new THREE.Vector3()).project(this.camera);
        const pb = this.field.worldCentre(b, new THREE.Vector3()).project(this.camera);
        return pa.x * pa.x + pa.y * pa.y - pb.x * pb.x - pb.y * pb.y;
      });
      if (tops.length) this.nav.select(tops[0]);
      return tops[0] ?? -1;
    };
    this.labelObjs = [];
    this._bindPointer();

    // Debug handle. Atlas load failures are invisible from the outside — a
    // tile that never loaded is a flat placeholder, which looks like a tile
    // whose image is simply dark — so the counts have to be reachable.
    window.__cwSpatial = this;

    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(100, now - last); last = now;
      if (!this.host.hidden) {
        this.camera.position.copy(this.basePos);
        this.camera.lookAt(this.lookTarget);
        this.camera.updateMatrixWorld();
        this.field.tick(dt);
        // Spend the near atlas on exposed covers / the open stack before
        // hidden members. Otherwise late-month covers get stuck at 64px.
        const readable = this.mode === 'piles'
          ? (this.piles.spreadPile >= 0 ? this.piles.piles[this.piles.spreadPile].indices
            : this.piles.piles.flatMap((_, i) => this.piles.faceOf(i))) : [];
        for (const i of readable) this.field.atlases.request(i, 'near', now);
        this.field.update(this.camera, now);
        this.hybrid.update(this.camera);
        this.hybrid.sort(this.camera);
        // Keep group names readable and steady at every zoom level.
        const focal = this.host.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
        for (const label of this.labelObjs) label.scale.setScalar(
          (this.camera.position.z - label.position.z) / focal * 0.55);

        this.webglRenderer.render(this.scene, this.camera);
        this.cssRenderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    this._observer = new ResizeObserver(() => {
      if (this.host.hidden || !this.fitted) return;
      if (this.mode === 'piles' && this._generatedPiles && this.piles.spreadPile < 0) this._packPiles();
      else if (this.mode !== 'piles') this._placeField();
      this.fit();
    });
    this._observer.observe(this.host);
  }

  /**
   * Numeric indices belong to one clip snapshot. The mesh, both atlases, DOM
   * pool, piles, and selection must retire together before those indices can
   * mean different clips. Keep the scene and its input/render lifecycle;
   * replace only the data-dependent resources, using their public disposers.
   */
  _replaceField() {
    this.hybrid?.dispose();
    this.field?.dispose();
    this.cardHost?.dispose();
    this.cardHost = null;
    this._lastFind = -1;
    this._lastFindKey = '';
    this._findArmed = false;
    this._unsubscribePaint?.();
    this._unsubscribePaint = null;

    const clips = this.clips;

    // Drawable cards: source near-tier tiles from live DOM instead of images,
    // so a tile keeps its text in find-in-page and Cmd+F can move the camera.
    // Chrome-only and off unless the API is present; when off, everything
    // below is skipped and the view is byte-for-byte its previous self.
    // `.sp-host[hidden]` is display:none, where a card has no layout box and
    // no paint record — so building the host then would fail every tile
    // permanently. The normal path is safe (wall.mjs unhides before calling
    // setClips) and this guard covers the constructor's first, empty build.
    const drawable = (window.__cwDrawable ?? drawableSupported()) && !this.host.hidden;
    if (drawable && clips.length) {
      this.cardHost = new CardHost({
        container: this.host,
        count: clips.length,
        width: 340,
        height: 255,
        // NOT `sp-card`: that class is the DOM-overlay pool, and both the
        // tests and the CSS3D layer select on it. A drawable card is never an
        // overlay. It shares the visual rules via a grouped selector instead.
        className: 'sp-dcard',
        // Same builder as the DOM pool, with the hero proxied: cross-origin
        // content inside a drawable renders blank, and 27% of harvested heroes
        // have no CORS headers.
        build: (i, el) => this._buildCard(i, el, { proxyHero: true }),
      });
      // `settled()` waits for the hero images, which is when the find
      // handler below can be armed: an <img> finishing load repaints its card
      // and is indistinguishable from a find match at the event level.
      const host = this.cardHost;
      host.settled().then(() => { if (this.cardHost === host) this._findArmed = true; });
    }

    this.field = new TileField({
      scene: this.scene,
      // The atlas requires nonzero backing dimensions. An empty filter still
      // has zero active instances, so it cannot render or navigate a phantom.
      count: Math.max(1, clips.length),
      nearDistance: 3200,
      nearSlots: 256,
      resolve: (i) => {
        const clip = clips[i];
        const src = clip?.cover || clip?.media?.[0]?.src || null;
        // Both tiers use the captured file until capture has a thumb ladder.
        return src ? proxied(src) : null;
      },
      // Near tier only. The far atlas is the whole corpus resident at once, and
      // there is no reason to pay a capture for a tile that is a few pixels of
      // colour. Returning null for 'far' falls through to the image path.
      // `_capturing` brackets our own drawElementImage calls: a capture
      // repaints the card, and a repaint is indistinguishable from a find at
      // the event level.
      resolveSource: this.cardHost
        ? (i, tier) => {
          if (tier !== 'near' || this.host.hidden) return null;
          this._capturing = true;
          try { return this.cardHost?.capture(i) ?? null; }
          finally { queueMicrotask(() => { this._capturing = false; }); }
        }
        : null,
    });
    this.field.count = clips.length;
    this.field.mesh.count = clips.length;
    this.field.setMotion(this.motion);

    this.piles = new PileLayout({
      field: this.field, surface: this.surface, maxVisibleInPile: 8,
      aspectOf: (i) => aspectOfClip(clips[i]),
    });
    this.hybrid = new HybridField({
      scene: this.scene, field: this.field,
      poolSize: 14, basePx: 340, promoteDistance: 0,
      eligible: (i) => this.mode !== 'piles' || (this.piles.spreadPile < 0 && this._pileTops?.has(i)),
      className: 'sp-card', idPrefix: 'sp-card',
      build: (i, el) => this._buildCard(i, el),
      onActivate: (i) => this._activate(i),
    });
    this._bindCardHover();
    if (this.nav) {
      this.nav.field = this.field;
      this.nav.hybrid = this.hybrid;
      this.nav.selection = -1;
      this.nav.container.removeAttribute('aria-activedescendant');
      this.nav.live.textContent = '';
    }
    // Find-in-page, measured against Chrome's real find bar (NOT window.find,
    // which takes a different path and gives opposite evidence):
    //
    //   * `changedElements` is exactly the set of cards matching the current
    //     query, narrowing as the user types. It is a precise signal.
    //   * The find bar leaves NO DOM selection, so there is nothing else to
    //     key on.
    //   * Opening or closing the bar repaints every card, as does our own
    //     capture pass — so a whole-corpus set is the one shape to ignore.
    //
    // A find therefore answers with a SET, and the camera fits the set rather
    // than flying to a guessed single match. Scope is untouched either way:
    // this moves the camera and the selection, never `state.filtered`.
    if (this.cardHost) {
      this._unsubscribePaint = this.cardHost.onPaint((indices) => {
        if (!this._findArmed || this._capturing) return;
        if (!indices.length || indices.length === this.clips.length) return;
        const key = indices.join(',');
        if (key === this._lastFindKey) return;
        this._lastFindKey = key;
        this._lastFind = indices[0];
        for (const i of indices.slice(0, 32)) this.field.atlases.request(i, 'near');
        this.hybrid?.setFocus(indices[0]);
        this.nav?.select(indices[0]);
        this.fit(indices);
      });
    }

    this._everPlaced = false;
  }



  /* ------------------------------------------------------------ cards --- */

  _buildCard(i, el, { proxyHero = false } = {}) {
    const clip = this.clips[i];
    if (!clip) return;

    const src = clip.cover || clip.media?.[0]?.src || '';
    if (src) {
      const img = document.createElement('img');
      img.className = 'sp-thumb';
      // The DOM pool renders a plain <img> and is fine cross-origin. A drawable
      // is not: cross-origin content inside one is dropped from the snapshot,
      // leaving the hero blank while the rest of the card draws.
      img.src = proxyHero ? proxied(src) : src;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => el.classList.add('broken'), { once: true });
      el.append(img);
    }

    const body = document.createElement('div');
    body.className = 'sp-body';

    const t = document.createElement('div');
    t.className = 'sp-t';
    t.textContent = clip.title || '(untitled)';          // untrusted

    const m = document.createElement('div');
    m.className = 'sp-m';
    m.textContent = [clip.source, clip.captured, (clip.tags || []).join(' · ')]
      .filter(Boolean).join('  ·  ');                     // untrusted

    body.append(t, m);

    // The deep link, on every promoted card. This is the whole division of
    // labour: the wall never edits, and a correction is one click into the
    // real editor. A card that reaches the DOM tier and drops it would make
    // the spatial view a dead end.
    if (clip.editUri) {
      const a = document.createElement('a');
      a.className = 'sp-edit';
      a.href = clip.editUri;
      a.textContent = 'edit in Obsidian';
      a.rel = 'noopener';
      a.addEventListener('click', (e) => e.stopPropagation());
      body.append(a);
    }

    el.append(body);
    el.setAttribute('aria-label', this._label(i));
  }

  _label(i) {
    const clip = this.clips[i];
    if (!clip) return `Item ${i}`;
    const pile = this.mode === 'piles' ? this.piles.pileOf(i) : -1;
    const where = pile >= 0 ? `, in ${this.piles.piles[pile].label}` : '';
    return `${clip.title || 'untitled'}, ${clip.source || 'unknown source'}${where}`;
  }

  /**
   * Hover for the DOM twins. The pool elements are persistent, so this runs
   * once per pool and reads entry.index at event time rather than closing over
   * it — a pool entry is a different item a second from now.
   */
  _bindCardHover() {
    for (const entry of this.hybrid.pool) {
      if (entry.el.dataset.hoverBound) continue;
      entry.el.dataset.hoverBound = '1';
      // pointermove, not pointerenter: enter fires only on crossing the border,
      // so a preview switched on while the pointer already rests on a card
      // would wait for the pointer to leave and come back.
      entry.el.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' || e.buttons !== 0 || !this.hoverEnabled()) return;
        if (entry.index < 0 || entry.index === this._hovered) return;
        const clip = this._hoverTarget(entry.index);
        if (!clip) return;
        if (this._hoverFrame) { cancelAnimationFrame(this._hoverFrame); this._hoverFrame = 0; }
        this._hovered = entry.index;
        this.onHover(clip);
      });
      entry.el.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'touch') return;
        if (entry.index >= 0 && entry.index === this._hovered) this._endHover();
      });
    }
  }

  /** Resolve the item under the pointer and report it, once per frame. */
  _pickHover(clientX, clientY) {
    if (!this.built || !this.hoverEnabled()) return this._endHover();
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const hit = this.field.pickAt(((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1, this.camera);
    if (hit === this._hovered) return;              // same item, nothing to say
    const clip = hit >= 0 ? this._hoverTarget(hit) : null;
    this._hovered = clip ? hit : -1;
    if (clip) this.onHover(clip); else this.onHoverEnd();
  }

  _endHover() {
    if (this._hoverFrame) { cancelAnimationFrame(this._hoverFrame); this._hoverFrame = 0; }
    if (this._hovered === -1) return;
    this._hovered = -1;
    this.onHoverEnd();
  }

  /**
   * The clip a hit would open, or null. A collapsed pile is not an item — a
   * click there spreads the stack — so hovering one must not preview anything.
   * Mirrors _activate()'s branch deliberately: the two must agree, or hover
   * shows one thing and the click that follows does another.
   */
  _hoverTarget(i) {
    if (this.mode === 'piles') {
      const pile = this.piles.pileOf(i);
      if (pile >= 0 && this.piles.spreadPile !== pile) return null;
    }
    return this.clips[i] || null;
  }

  _activate(i) {
    if (this.mode === 'piles') {
      const pile = this.piles.pileOf(i);
      if (pile >= 0 && this.piles.spreadPile !== pile) {
        this.hybrid.setFocus(-1);
        if (this.piles.spreadPile >= 0) this._collapsePile(this.piles.spreadPile);
        this.piles.spread(pile, { columns: Math.max(1, Math.round(Math.sqrt(
          this.piles.piles[pile].indices.length * this.camera.aspect / 1.5))) });
        // Browsing an open stack uses the existing justified layout so mixed
        // image proportions fill the pane without overlapping their neighbours.
        this._spread(pile);
        this._labels();
        this.fit(this.piles.piles[pile].indices);
        return;
      }
    }
    const clip = this.clips[i];
    if (clip) this.onOpen(clip);
  }

  /* ------------------------------------------------------------ data ---- */

  /**
   * Show a filtered set. Called with whatever the facet rail has narrowed to,
   * so the spatial view and the flat wall always agree about what is in scope.
   */
  setClips(clips, groupKey = 'none') {
    // Include content, not just ids: an editor may retitle a note or change
    // its cover without changing its id/URL, including by mutating an object
    // already supplied here. A stored value snapshot detects that too.
    const snapshot = JSON.stringify(clips);
    const replace = this.built && snapshot !== this._clipSnapshot;
    this.clips = clips;
    this.groupKey = groupKey;
    this._ensureScene();
    if (replace) this._replaceField();
    this._clipSnapshot = snapshot;

    this.hybrid.promoteDistance = 0;
    this.mode = 'mountain'; // retained version-1 view-state name for the field
    this._generatedPiles = false;
    this._placeField();
    this._labels();
    this.fit();
  }

  _composition(clips, gap = 14) {
    return layout(clips, 'none', { viewportAspect: this.camera.aspect, gap });
  }

  _placeField() {
    const result = this._composition(this.clips);
    result.tiles.forEach((t, i) => {
      this.field.place(i, t.x + t.w / 2, -t.y - t.h / 2, 0, t.w, t.h);
      this.field.setRow(i, 0);
    });
    this.field.layout();
  }

  _spread(index) {
    { const p = this.piles.piles[index]; if (p?.all) p.indices = p.all; } // a spread shows every member, shared ones included
    const pile = this.piles.piles[index];
    const result = this._composition(pile.indices.map(i => this.clips[i]));
    result.tiles.forEach((t, k) => {
      const i = pile.indices[k];
      this.field.moveTo(i, pile.u + t.x + t.w / 2 - result.width / 2,
        pile.v - t.y - t.h / 2 + result.height / 2, 140, t.w, t.h, new THREE.Quaternion());
      this.field.setRow(i, 0);
    });
    for (const i of pile.indices) this.field.settle(i);
    this.field.layout();
  }

  _packPiles() {
    const covers = this.piles.piles.map((p, i) => ({ id: String(i), props: {
      // A pile placed nothing (every member stands elsewhere) still needs a footprint.
      dims: [`${Math.round((p.indices.length ? aspectOfClip(this.clips[p.indices.at(-1)]) : 1) * 1000)}x1000`]
    }}));
    const result = this._composition(covers, 90);
    result.tiles.forEach((t, i) => {
      Object.assign(this.piles.piles[i], { u: t.x + t.w / 2, v: -t.y - t.h, w: t.w, h: t.h });
      this._collapsePile(i);
    });
    this._labels();
  }

  _collapsePile(index) {
    const pile = this.piles.piles[index];
    const borrowed = !!pile?.exclusive && pile.indices !== pile.exclusive;
    if (pile?.exclusive) pile.indices = pile.exclusive; // give shared members back to their own piles
    this.piles.collapse(index, true);
    // Shared members the spread borrowed were moved; their owning piles re-place them.
    if (borrowed) for (let i = 0; i < this.piles.piles.length; i++) if (i !== index) this.piles.collapse(i, true);
    // A stack has a stable cover footprint. Contain banners/portraits within
    // it, retaining proportions; expanding reveals each image at full size.
    // Face members are already contained in their cells by the layout.
    const face = new Set(this.piles.faceOf(index));
    for (const i of pile.indices) {
      if (face.has(i)) continue;
      const w = this.field.sizes[i * 2], h = this.field.sizes[i * 2 + 1];
      const scale = Math.min(pile.w / w, pile.h / h);
      const c = this.field.worldCentre(i, new THREE.Vector3());
      const q = this.field.worldOrientation(i, new THREE.Quaternion());
      this.field.moveTo(i, c.x, c.y, c.z, w * scale, h * scale, q);
      this.field.settle(i);
    }
    this.field.layout();
  }

  collapse() {
    if (this.piles.spreadPile >= 0) {
      this._collapsePile(this.piles.spreadPile);
      this._labels();
      this.fitView();
    }
    this.hybrid.setFocus(-1);
  }

  /** Fit actual card corners, including depth and pile labels, into the pane. */
  fit(indices = null) {
    if (!this.built) return;
    if (!indices && this.piles.spreadPile >= 0) indices = this.piles.piles[this.piles.spreadPile].indices;
    indices ||= Array.from({ length: this.field.count }, (_, i) => i);
    const corners = [];
    const q = new THREE.Quaternion();
    for (const i of indices) {
      const c = this.field.worldCentre(i, new THREE.Vector3());
      this.field.worldOrientation(i, q);
      for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
        corners.push(new THREE.Vector3(x * this.field.sizes[i * 2], y * this.field.sizes[i * 2 + 1], 0).applyQuaternion(q).add(c));
      }
    }
    if (!corners.length) return;
    if (this.mode === 'piles' && this.piles.spreadPile < 0) {
      this.labelObjs.forEach((label, i) => {
        if (!label.visible) return;
        const p = label.position, w = this.piles.piles[i].w;
        corners.push(new THREE.Vector3(p.x - w / 2, p.y + 18, p.z));
        corners.push(new THREE.Vector3(p.x + w / 2, p.y + 18, p.z));
      });
    }
    const box = new THREE.Box3().setFromPoints(corners);
    const centre = box.getCenter(new THREE.Vector3());
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const rect = this.host.getBoundingClientRect();
    const inset = Math.min(32, rect.width * 0.04, rect.height * 0.04);
    const fx = Math.max(0.1, 1 - 2 * inset / rect.width), fy = Math.max(0.1, 1 - 2 * inset / rect.height);
    let z = 150;
    for (const p of corners) z = Math.max(z, p.z + Math.abs(p.x - centre.x) / (tan * this.camera.aspect * fx),
      p.z + Math.abs(p.y - centre.y) / (tan * fy));
    this.lookTarget.set(centre.x, centre.y, 0);
    this.basePos.set(centre.x, centre.y, z);
    this.camera.position.copy(this.basePos);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
    this.fitted = true;
  }

  fitView() {
    if (this.mode === 'piles') {
      if (this.piles.spreadPile >= 0) this._spread(this.piles.spreadPile);
      else if (this._generatedPiles) this._packPiles();
    } else this._placeField();
    this.fit();
  }

  panTo(x, y) {
    this.basePos.x = this.lookTarget.x = x;
    this.basePos.y = this.lookTarget.y = y;
    this.fitted = false;
  }

  panBy(dx, dy) {
    const unit = 2 * this.basePos.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.host.clientHeight;
    this.panTo(this.basePos.x - dx * unit, this.basePos.y + dy * unit);
  }

  zoomBy(factor) {
    this.basePos.z = Math.min(12000, Math.max(250, this.basePos.z / factor));
    this.fitted = false;
  }

  /* ----------------------------------------------------------- piles ---- */

  /** Facet values become piles. Multi-valued facets put a clip in several. */
  showPiles(facetKey) {
    // Share date buckets and multi-valued membership with the flat layout.
    const indexOf = new Map(this.clips.map((clip, i) => [clip, i]));
    // One quad per clip: a clip in several groups (multi-valued facets) can
    // stand in only one pile. It is placed in the smallest group it belongs
    // to, so small piles keep their members and large piles lose few; every
    // pile keeps its true count and full membership, and a spread pile
    // temporarily borrows its shared members.
    const raw = groupBy(this.clips, facetKey).map(({ label, clips }) => ({ label, all: clips.map(clip => indexOf.get(clip)) }));
    const placed = new Set();
    for (const g of [...raw].sort((a, b) => a.all.length - b.all.length)) {
      g.indices = g.all.filter(i => !placed.has(i));
      for (const i of g.indices) placed.add(i);
    }
    const groups = raw.map(g => ({ label: g.label, indices: g.indices, all: g.all, count: g.all.length }));

    this.mode = 'piles';
    this.hybrid.promoteDistance = Infinity;
    this.hybrid.setFocus(-1);
    this.piles.arrange(groups);
    this.piles.piles.forEach((p, i) => { p.exclusive = groups[i].indices; p.all = groups[i].all; p.count = groups[i].count; });
    this._generatedPiles = true;
    this._packPiles();
    this.fit();
    return groups.length;
  }

  showMountain() {
    this.setClips(this.clips, this.groupKey);
  }

  _stepPile(dir) {
    if (this.mode !== 'piles' || !this.piles.piles.length) return;
    const cur = this.piles.pileOf(this.nav.selection);
    const next = ((cur < 0 ? 0 : cur + dir) + this.piles.piles.length) % this.piles.piles.length;
    const pile = this.piles.piles[next];
    if (!pile.indices.length) return;
    this.nav.select(pile.indices[pile.indices.length - 1]);
    this.nav.announce(`${pile.label}, ${pile.indices.length} clips`);
  }

  _jumpPile(prefix) {
    if (this.mode !== 'piles') return null;
    const hit = this.piles.piles.findIndex((p) => p.label.toLowerCase().startsWith(prefix));
    if (hit < 0 || !this.piles.piles[hit].indices.length) return null;
    const pile = this.piles.piles[hit];
    this.nav.select(pile.indices[pile.indices.length - 1]);
    this.nav.announce(`${pile.label}, ${pile.indices.length} clips`);
    return hit;
  }

  /** One CSS3D label per pile. Nodes only — labels are facet values, which are
   *  scraped strings like any other. */
  _labels() {
    // Exposed covers: every member on a pile's contact-sheet face may be promoted to DOM.
    this._pileTops = new Set(this.piles.piles.flatMap((_, i) => this.piles.faceOf(i)));
    for (const o of this.labelObjs) o.visible = false;
    this.backButton.hidden = this.mode !== 'piles' || this.piles.spreadPile < 0;
    if (!this.backButton.hidden) {
      const pile = this.piles.piles[this.piles.spreadPile];
      this.backButton.textContent = `← All stacks · ${pile.label} · ${pile.indices.length} items`;
    }
    if (this.mode !== 'piles') return;
    this.piles.labelAnchors().forEach((a, i) => {
      let obj = this.labelObjs[i];
      if (!obj) {
        const n = document.createElement('span'); n.className = 'n';
        const c = document.createElement('span'); c.className = 'c';
        obj = makePlane([n, c], { className: 'sp-pile-label' });
        obj.userData.parts = { n, c };
        this.scene.add(obj);
        this.labelObjs[i] = obj;
      }
      obj.userData.parts.n.textContent = a.label;         // untrusted
      obj.userData.parts.c.textContent = String(this.piles.piles[i].count ?? a.count);
      const members = this.piles.piles[i].indices;
      let top = -Infinity, front = a.z;
      for (const j of members) {
        top = Math.max(top, this.field.centres[j * 3 + 1] + this.field.sizes[j * 2 + 1] * 0.53);
        front = Math.max(front, this.field.centres[j * 3 + 2]);
      }
      obj.position.set(a.x, (Number.isFinite(top) ? top : a.y) + 10, front + 5);
      obj.scale.setScalar(Math.max(0.9, a.width / 440));
      obj.visible = this.piles.spreadPile < 0;
    });
  }

  /* ------------------------------------------------------ view state ---- */

  captureView() {
    if (!this.built) return null;
    return {
      mode: this.mode,
      arrangement: { version: 1, piles: this.piles.piles.map(p => ({
        label: p.label, u: p.u, v: p.v, w: p.w, h: p.h,
        keys: p.indices.map(i => keyOfClip(this.clips[i])),
      })) },
      spread: this.piles.spreadPile,
      position: this.basePos.toArray(), target: this.lookTarget.toArray(),
      fitted: this.fitted, aspect: this.camera.aspect,
      selection: this.clips[this.nav.selection] ? keyOfClip(this.clips[this.nav.selection]) : null,
    };
  }

  restoreView(view) {
    if (view.mode === 'piles') {
      this.restore(view.arrangement);
      view.arrangement.piles.forEach((saved, i) => {
        Object.assign(this.piles.piles[i], { u: saved.u, v: saved.v, w: saved.w || 220, h: saved.h || 150 });
        this._collapsePile(i);
      });
      if (view.spread >= 0 && this.piles.piles[view.spread]?.indices.length) {
        this.piles.spread(view.spread);
        this._spread(view.spread);
      }
      this._labels();
    } else this.showMountain();
    const selected = this.clips.findIndex(c => keyOfClip(c) === view.selection);
    if (selected >= 0) this.nav.select(selected);
    if (view.fitted) this.fit();
    else {
      this.basePos.fromArray(view.position); this.lookTarget.fromArray(view.target);
      // A narrower screen needs proportionally more camera distance.
      if (Math.abs(this.camera.aspect - view.aspect) > .001)
        this.basePos.z = this.lookTarget.z + (this.basePos.z - this.lookTarget.z) * Math.max(1, view.aspect / this.camera.aspect);
      this.fitted = false;
      this.camera.position.copy(this.basePos); this.camera.lookAt(this.lookTarget); this.camera.updateMatrixWorld();
    }
  }

  /** Capture piles as portable, URL-keyed view state. */
  serialize() {
    return this.piles.serialize((i) => {
      const clip = this.clips[i];
      return clip ? keyOfClip(clip) : null;
    });
  }

  /** @returns {{restored:number, orphaned:string[]}} */
  restore(state) {
    const byKey = new Map();
    this.clips.forEach((clip, i) => byKey.set(keyOfClip(clip), i));
    const result = this.piles.restore(state, (k) => (byKey.has(k) ? byKey.get(k) : -1));
    // Saved piles may share members too: place each clip in its smallest pile,
    // keep the full membership for spreading and the true count for the label.
    { const placed = new Set();
      for (const p of [...this.piles.piles].sort((a, b) => a.indices.length - b.indices.length)) {
        p.all = p.indices; p.count = p.indices.length;
        p.exclusive = p.all.filter(i => !placed.has(i)); for (const i of p.exclusive) placed.add(i);
        p.indices = p.exclusive;
      } }
    this.mode = 'piles';
    this.hybrid.promoteDistance = Infinity;
    this._generatedPiles = false;
    for (let p = 0; p < this.piles.piles.length; p++) this._collapsePile(p);
    this._labels();
    this.fit();
    return result;
  }

  /* --------------------------------------------------------- pointer ---- */

  _bindPointer() {
    const el = this.host;
    let down = null;
    el.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.008));
      else this.panBy(-e.deltaX, -e.deltaY);
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('a, button')) return;
      e.stopPropagation();
      down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      e.stopPropagation();
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      if (down.moved) {
        this.panBy(e.clientX - down.lastX, e.clientY - down.lastY);
        el.setPointerCapture(e.pointerId);
      }
      down.lastX = e.clientX; down.lastY = e.clientY;
    });
    // Hover picks its own target rather than riding the drag handler above,
    // which returns early unless a button is down. pickAt measured 0.28 ms mean
    // / 0.4 ms p95 over 1793 instances (~1.6% of a 60fps frame), so the cost is
    // affordable — but pointermove fires several times per frame, so coalesce
    // to one pick per frame, and ask hoverEnabled() first so a field nobody is
    // previewing pays nothing at all.
    el.addEventListener('pointermove', (e) => {
      if (down || e.pointerType === 'touch' || e.buttons !== 0) return;
      // A promoted card owns its own hover, the same way pickAt() already skips
      // suppressed instances so the DOM twin takes the click. Without this the
      // field would pick -1 under every near card and cancel the preview the
      // card just started.
      if (e.target.closest?.('.sp-card')) return;
      if (!this.hoverEnabled()) { this._endHover(); return; }
      if (this._hoverFrame) return;
      const { clientX, clientY } = e;
      this._hoverFrame = requestAnimationFrame(() => {
        this._hoverFrame = 0;
        this._pickHover(clientX, clientY);
      });
    });
    el.addEventListener('pointerleave', () => this._endHover());
    el.addEventListener('pointercancel', () => { down = null; this._endHover(); });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      e.stopPropagation();
      const moved = down.moved; down = null;
      this._dragged = moved;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (moved || e.target.closest('.sp-card, a, button')) return;
      const r = el.getBoundingClientRect();
      const hit = this.field.pickAt(((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1, this.camera);
      if (hit >= 0) { this.nav.select(hit); this._activate(hit); }
    });
    el.addEventListener('click', (e) => {
      if (this._dragged) { e.preventDefault(); e.stopPropagation(); this._dragged = false; }
    }, true);
  }
}
