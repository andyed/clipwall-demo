/** A bounded picture of the flat wall. Geometry, focus and hit targets remain
 * owned by the real tiles; this surface replaces only successfully drawn images.
 * Feed setViewport the visible pose, not the destination of a CSS transition. */

const DEFAULTS = { enterPx: 72, exitPx: 96, motionPx: 160, maxDpr: 2,
  maxCanvasPixels: 4_194_304, maxImagePixels: 16_777_216, maxImages: 4096,
  maxImageEdge: 96, concurrency: 3, frameBudgetMs: 4 };

export function overviewEligible(wasActive, projectedSize, moving = false, options = {}) {
  const o = { ...DEFAULTS, ...options };
  return Number.isFinite(projectedSize) && projectedSize > 0 &&
    projectedSize <= (moving ? o.motionPx : wasActive ? o.exitPx : o.enterPx);
}

export function backingSize(width, height, dpr = 1, maxPixels = DEFAULTS.maxCanvasPixels, maxDpr = 2) {
  if (!(width > 0 && height > 0)) return { width: 1, height: 1, dpr: 1 };
  const ratio = Math.min(Math.max(1, dpr), maxDpr, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), dpr: ratio };
}

/** A cached viewport is safe only while its transformed rectangle covers the
 * whole current viewport. Newly exposed edges always require a fresh picture. */
export function pictureTransform(picture, pose, area) {
  const transform = picturePoseTransform(picture, pose, area);
  if (!transform || transform.scale < 1) return null;
  const { x, y, scale } = transform;
  if (x > 0 || y > 0 || x + picture.width * scale < area.width || y + picture.height * scale < area.height) return null;
  return transform;
}

function picturePoseTransform(picture, pose, area) {
  if (!picture || picture.width !== area.width || picture.height !== area.height || picture.dpr !== area.dpr) return null;
  const scale = pose.scale / picture.pose.scale;
  if (!(scale > 0 && Number.isFinite(scale))) return null;
  const x = pose.x - picture.pose.x * scale, y = pose.y - picture.pose.y * scale;
  return { x, y, scale };
}

/** Source/destination rectangles matching CSS object-fit, including portraits. */
export function imageRect(iw, ih, x, y, w, h, fit = 'cover') {
  if (!(iw > 0 && ih > 0 && w > 0 && h > 0)) return null;
  if (fit === 'contain') {
    const s = Math.min(w / iw, h / ih);
    return [0, 0, iw, ih, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s];
  }
  const s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
  return [(iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h];
}

export function overviewSource(clip = {}) {
  const variants = (clip.coverVariants || []).filter(v => v?.src && Number.isFinite(v.width) && v.width > 0);
  let smallest = null;
  for (const v of variants) if (!smallest || v.width < smallest.width) smallest = v;
  return smallest?.src || clip.cover || clip.media?.[0]?.src || '';
}

/** Each worker owns at most one decoder. Completed large images become bounded
 * bitmaps; original Image resources are released after that handoff. */
export function loadOverviewImage(src, { signal, maxEdge = 96 } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    let finished = false;
    const clean = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => {
      if (finished) return;
      finished = true; clean(); image.removeAttribute('src');
      reject(new DOMException('Image request cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    image.onerror = () => { if (finished) return; finished = true; clean(); reject(new Error('Overview image unavailable')); };
    image.onload = async () => {
      try {
        await image.decode();
        if (finished) return;
        const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        let resource = image;
        if (typeof createImageBitmap === 'function' && ratio < 1) {
          resource = await createImageBitmap(image, { resizeWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
            resizeHeight: Math.max(1, Math.round(image.naturalHeight * ratio)), resizeQuality: 'low' });
        }
        if (finished) { if (resource !== image) resource.close(); return; }
        finished = true; clean();
        const width = resource.width || image.naturalWidth, height = resource.height || image.naturalHeight;
        if (resource !== image) image.removeAttribute('src');
        resolve({ image: resource, width, height, close: () => resource === image ? image.removeAttribute('src') : resource.close() });
      } catch (error) { if (!finished) { finished = true; clean(); image.removeAttribute('src'); reject(error); } }
    };
    image.src = src;
  });
}

export class OverviewSurface {
  constructor(stage, options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.stage = stage;
    this.canvas = options.canvas || document.createElement('canvas');
    this.canvas.className = 'overview-surface';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    this.context = this.canvas.getContext('2d', { alpha: true });
    this.background = options.background || (typeof getComputedStyle === 'function' && getComputedStyle(stage).getPropertyValue('--panel-2').trim()) || '#14141f';
    stage.prepend(this.canvas);
    this._raf = options.requestFrame || (fn => requestAnimationFrame(fn));
    this._cancel = options.cancelFrame || (id => cancelAnimationFrame(id));
    this._now = options.now || (() => performance.now());
    this._load = options.loadImage || loadOverviewImage;
    this.tiles = []; this.cache = new Map(); this.pending = new Map(); this.failed = new Set();
    this.painted = new Set(); this.active = false; this.enabled = true; this.disposed = false;
    this.pose = { x: 0, y: 0, scale: 1 }; this.area = { width: 0, height: 0 };
    this.frame = 0; this.epoch = 0; this.draws = 0; this.pixelCount = 0;
    this._dirty = true; this._work = []; this._cursor = 0; this._wanted = new Set();
    this._handoff = false; this._imageWatches = new Map(); this._imageErrors = new WeakSet();
    this._picture = null; this._compositing = false;
    this._domFallback = false;
    this._drawnTiles = new Set();
    this._sourceTiles = new Map(); this._nodeTiles = new Map(); this._imageSources = new WeakMap(); this._visibleTiles = new Set(); this._queued = new Set();
    this._onImageLoad = event => {
      const source = this._imageSources.get(event.target);
      if (source) { this._enqueueSource(source); this._schedule(); }
    };
    stage.addEventListener?.('load', this._onImageLoad, true);
  }

  setTiles(tiles = []) {
    this.epoch++;
    this._picture = null; this._compositing = false;
    for (const clean of [...this._imageWatches.values()]) clean();
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this.failed.clear(); this._clearPainted();
    this.tiles = tiles.filter(t => [t.x, t.y, t.w, t.h].every(Number.isFinite) && t.w > 0 && t.h > 0)
      .map(t => ({ ...t, source: t.source || overviewSource(t.clip), image: t.node?.querySelector('img') }));
    this._sourceTiles = new Map(); this._nodeTiles = new Map(); this._imageSources = new WeakMap();
    for (const tile of this.tiles) {
      if (!this._sourceTiles.has(tile.source)) this._sourceTiles.set(tile.source, []);
      this._sourceTiles.get(tile.source).push(tile);
      if (tile.node) this._nodeTiles.set(tile.node, tile);
      if (tile.image) this._imageSources.set(tile.image, tile.source);
    }
    this._visibleTiles.clear(); this._queued.clear();
    const sources = new Set(this.tiles.map(t => t.source));
    for (const [source, entry] of this.cache) if (!sources.has(source)) this._evict(source, entry);
    // The median limits a single poster or tiny outlier's influence on switching.
    const sizes = this.tiles.map(t => Math.max(t.w, t.h)).sort((a, b) => a - b);
    this.typicalSize = sizes[Math.floor(sizes.length / 2)] || 0;
    this._dirty = true;
    this.setViewport(this.pose, this.area);
  }

  /** The host atomically replaces an already decoded image inside the same
   * semantic tile. Refresh only that occurrence; its cached pixels remain valid. */
  replaceImage(node, image) {
    const tile = this._nodeTiles.get(node);
    if (!tile || !image?.complete || !(image.naturalWidth > 0)) return false;
    const previous = tile.image;
    if (previous) { this._imageWatches.get(previous)?.(); this._imageSources.delete(previous); }
    tile.image = image; this._imageSources.set(image, tile.source);
    if (this._visibleTiles.has(tile) && !this.painted.has(node) && !this._queued.has(tile)) {
      this._work.push(tile); this._queued.add(tile); this._schedule();
    }
    if (this._handoff && !this._imageWatches.size) this.setViewport(this.pose, this.area);
    return true;
  }

  setViewport(pose, { width, height, moving = false, dpr = globalThis.devicePixelRatio || 1 } = {}) {
    if (this.disposed || ![pose.x, pose.y, pose.scale].every(Number.isFinite) || pose.scale <= 0) return;
    const changed = pose.x !== this.pose.x || pose.y !== this.pose.y || pose.scale !== this.pose.scale ||
      width !== this.area.width || height !== this.area.height || dpr !== this.area.dpr;
    this.pose = { x: pose.x, y: pose.y, scale: pose.scale };
    this.area = { width, height, moving, dpr };
    const eligible = this.enabled && !!this.context && width > 0 && height > 0 &&
      overviewEligible(this.active, this.typicalSize * pose.scale, moving, this.options);
    // Reading images may still be decoding when the camera crosses the exit
    // threshold. Keep their already-visible pixels until the DOM can take over.
    let handoff = false;
    if (this.enabled && !eligible && width > 0 && height > 0) {
      for (const node of this.painted) {
        const img = node.querySelector('img');
        if (img && !this._domReady(img)) { handoff = true; this._watchImage(img); }
      }
    }
    if (handoff !== this._handoff) this._dirty = true;
    this._handoff = handoff;
    const active = eligible || handoff;
    if (active !== this.active) {
      this.active = active; this._dirty = true;
      this.canvas.hidden = !active;
      if (!active) this._clearPainted();
      this.options.onState?.({ active });
    }
    if (!active) {
      if (this.frame) this._cancel(this.frame);
      // Visibility/representation changed, but these pixels still represent the
      // same layout. Retain their complete snapshot for a cheap zoom-out return;
      // setTiles and actual raster changes remain the invalidation boundaries.
      this.frame = 0; this._compositing = false; this._domFallback = false;
      this.canvas.style.transform = 'none';
      return;
    }
    if (changed) this._dirty = true;
    this._domFallback = false;
    const transform = moving && !handoff && picturePoseTransform(this._picture, this.pose, this.area);
    if (transform && this._motionCoverage()) {
      if (this.frame) this._cancel(this.frame);
      this.frame = 0; this._compositing = true; this._dirty = true;
      this.canvas.hidden = false;
      this.canvas.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
      return;
    }
    this._compositing = false;
    if (moving && !handoff && this._visibleDomReady()) {
      // A moving camera must not keep restarting a partial raster. The real
      // images already provide a complete picture here, so let their existing
      // compositor layer carry the gesture and build our bitmap only at rest.
      if (this.frame) this._cancel(this.frame);
      this.frame = 0; this._domFallback = true; this._dirty = true;
      this._clearPainted(); this.canvas.hidden = true;
      return;
    }
    this.canvas.hidden = false;
    if (this._dirty && moving) {
      // The host already sampled the visible pose in this animation frame.
      // Deferring its picture to the next rAF leaves pixels one frame behind
      // the unchanged DOM hit targets. Spend only our bounded slice now.
      if (this.frame) this._cancel(this.frame);
      this.frame = 0; this._render();
    } else if (this._dirty) this._schedule();
  }

  _visibleDomReady() {
    const p = this.pose, { width, height } = this.area;
    for (const tile of this.tiles) {
      if (!tile.source || tile.x * p.scale + p.x >= width || (tile.x + tile.w) * p.scale + p.x <= 0 ||
        tile.y * p.scale + p.y >= height || (tile.y + tile.h) * p.scale + p.y <= 0) continue;
      if (!(tile.image?.complete && tile.image.naturalWidth > 0)) return false;
    }
    return true;
  }

  _motionCoverage() {
    const picture = this._picture, p = this.pose, area = this.area, q = picture.pose;
    const oldLeft = -q.x / q.scale, oldTop = -q.y / q.scale;
    const oldRight = (picture.width - q.x) / q.scale, oldBottom = (picture.height - q.y) / q.scale;
    const left = -p.x / p.scale, top = -p.y / p.scale;
    const right = (area.width - p.x) / p.scale, bottom = (area.height - p.y) / p.scale;
    const changes = [];
    for (const tile of this.tiles) {
      const l = Math.max(tile.x, left), r = Math.min(tile.x + tile.w, right);
      const t = Math.max(tile.y, top), b = Math.min(tile.y + tile.h, bottom);
      if (r <= l || b <= t || !tile.source) continue;
      const covered = l >= oldLeft && r <= oldRight && t >= oldTop && b <= oldBottom && picture.tiles.has(tile);
      // Newly exposed imagery stays on its already decoded DOM image. If that
      // fallback is unavailable, use the ordinary bounded paint/load path.
      if (!covered && !(tile.image?.complete && tile.image.naturalWidth > 0)) return false;
      if (tile.node && covered !== this.painted.has(tile.node)) changes.push([tile.node, covered]);
    }
    // Validate every fallback before changing any marker. Most frames cross no
    // tile boundary, so they perform no style writes and no image draws.
    for (const [node, covered] of changes) {
      if (covered) { this.painted.add(node); node.classList.add('overview-painted'); }
      else { this.painted.delete(node); node.classList.remove('overview-painted'); }
    }
    return true;
  }

  setEnabled(enabled) {
    enabled = !!enabled;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.setViewport(this.pose, this.area);
    if (!this.enabled) {
      this.epoch++;
      for (const controller of this.pending.values()) controller.abort();
      this.pending.clear();
    }
  }

  _schedule() {
    if (this.frame || !this.active || this.disposed || this._compositing || this._domFallback) return;
    this.frame = this._raf(() => { this.frame = 0; this._render(); });
  }

  _render() {
    if (!this.active || this.disposed) return;
    const ctx = this.context, { width, height, dpr } = this.area, p = this.pose;
    const start = this._now();
    if (this._dirty) {
      this._picture = null;
      this.canvas.style.transform = 'none';
      const size = backingSize(width, height, dpr, this.options.maxCanvasPixels, this.options.maxDpr);
      if (this.canvas.width !== size.width) this.canvas.width = size.width;
      if (this.canvas.height !== size.height) this.canvas.height = size.height;
      this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const visible = this.tiles.filter(t => t.x * p.scale + p.x < width && (t.x + t.w) * p.scale + p.x > 0 &&
        t.y * p.scale + p.y < height && (t.y + t.h) * p.scale + p.y > 0);
      this._visibleTiles = new Set(visible); this._queued = new Set(visible); this._work = visible;
      this._wanted = new Set(visible.map(t => t.source));
      // Decode center-first, but retain layout order for drawing.
      this._queue = visible.filter(t => t.source).map(t => ({ source: t.source,
        distance: Math.hypot((t.x + t.w / 2) * p.scale + p.x - width / 2, (t.y + t.h / 2) * p.scale + p.y - height / 2) }))
        .sort((a, b) => a.distance - b.distance);
      this._cursor = 0; this._loadCursor = 0; this._dirty = false;
      this._resetPainted = this.painted; this.painted = new Set();
      this._drawnTiles = new Set();
    }
    const added = new Set();
    while (this._cursor < this._work.length) {
      const tile = this._work[this._cursor++];
      this._queued.delete(tile);
      const dom = tile.image;
      if (this._handoff && this._domReady(dom)) continue;
      const entry = this.cache.get(tile.source);
      const image = dom?.complete && dom.naturalWidth > 0 ? dom : entry?.image;
      if (image) {
        const iw = image.naturalWidth || entry?.width || image.width;
        const ih = image.naturalHeight || entry?.height || image.height;
        const border = tile.border ?? 1, s = p.scale;
        const x = (tile.x + border) * s + p.x, y = (tile.y + border) * s + p.y;
        const w = Math.max(0, tile.w - border * 2) * s, h = Math.max(0, tile.h - border * 2) * s;
        const rect = imageRect(iw, ih, x, y, w, h, tile.fit || 'cover');
        if (rect) {
          const clip = 4 * s >= 1 && typeof ctx.roundRect === 'function';
          try {
            if (clip) { ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(4 * s, w / 2, h / 2)); ctx.clip(); }
            ctx.fillStyle = this.background; ctx.fillRect(x, y, w, h);
            ctx.drawImage(image, ...rect); this.draws++;
            this._drawnTiles.add(tile);
            if (entry) { this.cache.delete(tile.source); this.cache.set(tile.source, entry); }
            if (tile.node && !this.painted.has(tile.node)) { this.painted.add(tile.node); added.add(tile.node); }
          } catch { /* Keep the existing DOM image if its decoder was released. */ }
          finally { if (clip) ctx.restore(); }
        }
      }
      if (this._now() - start >= this.options.frameBudgetMs) break;
    }
    // A tile's DOM image disappears only after pixels exist at this exact pose.
    if (this._resetPainted) for (const node of this._resetPainted) if (!this.painted.has(node)) node.classList.remove('overview-painted');
    for (const node of added) if (!this._resetPainted?.has(node)) node.classList.add('overview-painted');
    this._resetPainted = null;
    if (!this._handoff) this._pump();
    if (this._cursor < this._work.length) this._schedule();
    else {
      this._picture = { pose: { ...p }, width, height, dpr, tiles: this._drawnTiles };
      this._work = []; this._cursor = 0;
      if (this._handoff && !this.painted.size) this.setViewport(this.pose, this.area);
    }
  }

  _enqueueSource(source) {
    for (const tile of this._sourceTiles.get(source) || []) {
      if (!this._visibleTiles.has(tile) || this._queued.has(tile) || this.painted.has(tile.node)) continue;
      this._work.push(tile); this._queued.add(tile);
    }
  }

  _domReady(img) { return !img || (img.complete && img.naturalWidth > 0) || this._imageErrors.has(img); }

  _watchImage(img) {
    if (this._imageWatches.has(img) || !img.addEventListener) return;
    const done = event => {
      clean();
      if (event.type === 'error') this._imageErrors.add(img);
      this._dirty = true;
      this.setViewport(this.pose, this.area);
    };
    const clean = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); this._imageWatches.delete(img); };
    this._imageWatches.set(img, clean);
    img.addEventListener('load', done); img.addEventListener('error', done);
    // The wall normally requests this in its visible reading neighborhood;
    // initiate it here only if crossing the threshold got there first.
    if (!img.getAttribute('src') && img.dataset?.src) img.src = img.dataset.src;
  }

  _pump() {
    while (this._loadCursor < (this._queue?.length || 0) && this.pending.size < this.options.concurrency) {
      const { source } = this._queue[this._loadCursor++];
      if (this.cache.has(source) || this.pending.has(source) || this.failed.has(source)) continue;
      const images = this._sourceTiles.get(source) || [];
      // Native load capture will queue only these occurrences. Do not issue a
      // second Image/decode for a source the wall has already requested.
      if (images.some(t => t.image?.naturalWidth > 0 || (!t.image?.complete && (t.image?.currentSrc || t.image?.getAttribute?.('src'))))) continue;
      const controller = new AbortController(), epoch = this.epoch;
      this.pending.set(source, controller);
      Promise.resolve().then(() => this._load(source, { signal: controller.signal, maxEdge: this.options.maxImageEdge }))
        .then(entry => {
          if (this.disposed || controller.signal.aborted || epoch !== this.epoch) { entry.close?.(); return; }
          const pixels = entry.width * entry.height;
          if (!(pixels > 0) || pixels > this.options.maxImagePixels) { entry.close?.(); this.failed.add(source); return; }
          this.cache.set(source, { ...entry, close: entry.close?.bind(entry), pixels }); this.pixelCount += pixels;
          this._trim(); this._enqueueSource(source);
        }, error => { if (!controller.signal.aborted && epoch === this.epoch) this.failed.add(source); })
        .finally(() => {
          if (this.pending.get(source) === controller) this.pending.delete(source);
          if (!this.disposed && epoch === this.epoch) this._schedule();
        });
    }
  }

  _trim() {
    const over = () => this.cache.size > this.options.maxImages || this.pixelCount > this.options.maxImagePixels;
    if (!over()) return;
    for (const [source, entry] of this.cache) if (over() && !this._wanted.has(source)) this._evict(source, entry);
    for (const [source, entry] of this.cache) {
      if (!over()) break;
      this._evict(source, entry);
      // An oversubscribed overview must settle, not evict/reload forever. The
      // original DOM image remains the fallback until the next layout changes.
      this.failed.add(source);
    }
  }

  _evict(source, entry) { this.cache.delete(source); this.pixelCount -= entry.pixels; entry.close?.(); }
  _clearPainted() { for (const node of this.painted) node.classList.remove('overview-painted'); this.painted.clear(); }
  get stats() { return { active: this.active, images: this.cache.size, pending: this.pending.size,
    decodedPixels: this.pixelCount, canvasPixels: this.canvas.width * this.canvas.height,
    painted: this.painted.size, draws: this.draws, scheduled: !!this.frame, compositing: this._compositing, domFallback: this._domFallback }; }

  dispose() {
    this.disposed = true; this.epoch++;
    if (this.frame) this._cancel(this.frame);
    this.frame = 0;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this._clearPainted();
    this.stage.removeEventListener?.('load', this._onImageLoad, true);
    for (const clean of [...this._imageWatches.values()]) clean();
    for (const [source, entry] of this.cache) this._evict(source, entry);
    this.canvas.remove();
  }
}
