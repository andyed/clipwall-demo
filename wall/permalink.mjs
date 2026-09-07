/** Portable view contract, shared by the browser and immutable snapshot endpoint. */
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;
export function canonical(value) {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export function validateView(v) {
  const fail = () => { throw new Error('Invalid or unsupported view link'); };
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  const str = x => typeof x === 'string' && x.length <= 20000;
  const num = x => Number.isFinite(x) && Math.abs(x) <= 1e9;
  const vec = x => Array.isArray(x) && x.length === 3 && x.every(num);
  if (!obj(v) || v.v !== 1 || v.layoutVersion !== 1 || !obj(v.corpus) || !str(v.corpus.id) || !str(v.corpus.revision)
      || !obj(v.scope) || !str(v.scope.query) || !Array.isArray(v.scope.facets)
      || !v.scope.facets.every(f => Array.isArray(f) && f.length === 2 && str(f[0]) && Array.isArray(f[1]) && f[1].every(str))
      || !(v.scope.branches === null || Array.isArray(v.scope.branches) && v.scope.branches.every(b => obj(b) && str(b.label) && Array.isArray(b.keys) && b.keys.every(str)))
      || !obj(v.presentation) || !['flat', '3d'].includes(v.presentation.mode) || !str(v.presentation.group)
      || !['free', 'bounded', 'edge'].includes(v.presentation.pan)
      || !(v.presentation.sort === undefined || obj(v.presentation.sort) && str(v.presentation.sort.key) && ['asc', 'desc'].includes(v.presentation.sort.direction))
      || !obj(v.flat) || !obj(v.flat.view) || !['x', 'y', 'scale'].every(k => num(v.flat.view[k]))
      || v.flat.view.scale < .015 || v.flat.view.scale > 6 || typeof v.flat.view.fitted !== 'boolean'
      || !num(v.flat.aspect) || v.flat.aspect <= 0 || !obj(v.flat.stage) || !['w', 'h'].every(k => num(v.flat.stage[k]) && v.flat.stage[k] > 0)
      || !obj(v.ui) || typeof v.ui.rail !== 'boolean' || typeof v.ui.context !== 'boolean'
      || !(v.ui.lens === undefined || v.ui.lens === null || str(v.ui.lens))
      || !(v.ui.mediaSource === undefined || v.ui.mediaSource === null || str(v.ui.mediaSource))
      || !(v.ui.scopeBar === undefined || typeof v.ui.scopeBar === 'boolean')
      || !(v.ui.focus === null || str(v.ui.focus)) || !(v.ui.detailWidth === null || num(v.ui.detailWidth) && v.ui.detailWidth > 0 && v.ui.detailWidth <= 1)) fail();
  if (v.spatial !== null) {
    const s = v.spatial;
    if (!obj(s) || !['mountain', 'piles'].includes(s.mode) || !obj(s.arrangement) || s.arrangement.version !== 1
        || !Array.isArray(s.arrangement.piles) || !s.arrangement.piles.every(p => obj(p) && str(p.label) && num(p.u) && num(p.v)
          && Array.isArray(p.keys) && p.keys.every(str) && (p.w === undefined || num(p.w) && p.w > 0) && (p.h === undefined || num(p.h) && p.h > 0))
        || !Number.isInteger(s.spread) || s.spread < -1 || s.spread >= s.arrangement.piles.length
        || !vec(s.position) || !vec(s.target) || typeof s.fitted !== 'boolean'
        || !num(s.aspect) || s.aspect <= 0 || !(s.selection === null || str(s.selection))) fail();
  }
  if (v.presentation.mode === '3d' && !v.spatial) fail();
  if (new TextEncoder().encode(canonical(v)).length > MAX_VIEW_BYTES) throw new Error('View exceeds the 4 MiB limit');
  return v;
}
export function encodeView(v) {
  const bytes = new TextEncoder().encode(canonical(validateView(v)));
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeView(encoded) {
  if (encoded.length > Math.ceil(MAX_VIEW_BYTES * 4 / 3) + 4 || !/^[\w-]+$/.test(encoded)) throw new Error('Invalid or oversized view link');
  const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return validateView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export async function viewDigest(v) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(validateView(v))));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** URL updates share one serialized pipeline. Inline fallback is immediately
 * current; reference URLs are advertised only after durable server readback. */
export function createPermalinks({ capture, restore, notice, onHistory }) {
  let ready = false, blocked = false, restoring = false, last = '', lastSemantic = '', generation = 0;
  let pointerActive = false;
  window.addEventListener('pointerdown', () => { pointerActive = true; }, true);
  for (const event of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(event, () => { pointerActive = false; }, true);
  let candidate = '', since = 0, queuedRestore = Promise.resolve(), pending = Promise.resolve();
  const cache = new Map();
  const semantic = v => canonical({ scope: v.scope, presentation: v.presentation, focus: v.ui.focus, lens: v.ui.lens ?? null });
  const read = async () => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.has('s') && !p.has('ref')) return null;
    if (p.get('v') !== '1' || p.has('s') === p.has('ref')) throw new Error('Unsupported view link format');
    if (p.has('s')) return decodeView(p.get('s'));
    const id = p.get('ref'); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid snapshot identifier');
    const res = await fetch(`/api/permalinks/${id}`);
    if (!res.ok) throw new Error(`View snapshot unavailable (HTTP ${res.status})`);
    const view = validateView(await res.json());
    if (await viewDigest(view) !== id) throw new Error('View snapshot integrity check failed');
    cache.set(canonical(view), id); return view;
  };
  const urlFor = fragment => { const u = new URL(location.href); u.hash = fragment; return u.href; };
  const flush = async (force = false) => {
    if (!ready || restoring || blocked) return pending;
    const v = validateView(capture()), text = canonical(v);
    if (text === last && !force) return pending;
    const sem = semantic(v), push = last && sem !== lastSemantic;
    last = text; lastSemantic = sem; candidate = text;
    const stamp = ++generation;
    const encoded = encodeView(v), inline = `v=1&s=${encoded}`;
    const method = push ? 'pushState' : 'replaceState';
    const depth = (history.state?.cwDepth || 0) + (push ? 1 : 0);
    let inlineFailed = false;
    try { history[method]({ cwDepth: depth }, '', urlFor(cache.has(text) ? `v=1&ref=${cache.get(text)}` : inline)); }
    catch (err) {
      if (encoded.length <= 6000 || cache.has(text)) throw err;
      inlineFailed = true;
    }
    onHistory();
    if (encoded.length <= 6000 || cache.has(text)) { notice(''); return; }
    notice(inlineFailed ? 'Saving large view… the address bar is not current yet.' : 'Saving compact link… full view is already in the address bar.');
    pending = (async () => {
      try {
        const res = await fetch('/api/permalinks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { id } = await res.json();
        if (id !== await viewDigest(v)) throw new Error('snapshot identifier mismatch');
        const verify = await fetch(`/api/permalinks/${id}`);
        if (!verify.ok || await viewDigest(await verify.json()) !== id) throw new Error('snapshot readback failed');
        cache.set(text, id);
        if (generation === stamp && !restoring) {
          history[inlineFailed ? method : 'replaceState']({ cwDepth: depth }, '', urlFor(`v=1&ref=${id}`)); onHistory(); notice('');
        }
      } catch (err) {
        if (generation === stamp) notice(inlineFailed ? `View link could not be saved (${err.message}); the address bar is not current. Try Copy link again.` : `Compact link unavailable (${err.message}). The address bar retains the full, longer view link.`);
      }
    })();
    return pending;
  };
  const load = async () => {
    restoring = true; generation++;
    try {
      const view = await read();
      if (view) await restore(view);
      blocked = false;
      last = canonical(capture()); lastSemantic = semantic(capture()); candidate = last;
      if (!view) last = '';
    } catch (err) { blocked = true; notice(`Could not restore link: ${err.message}. Use “New view” to leave this link.`); }
    finally { restoring = false; onHistory(); }
  };
  window.addEventListener('popstate', () => {
    // Suppress capture immediately, even while an older restoration is pending.
    restoring = true;
    queuedRestore = queuedRestore.then(load);
  });
  // Poll the settled canonical state, including spatial gestures and detail
  // resizing, rather than depending on a second collection of control values.
  setInterval(() => {
    if (!ready || restoring || blocked || pointerActive || document.querySelector('.dragging, .detail-resizing')) return;
    try {
      const now = canonical(capture());
      if (now !== candidate) { candidate = now; since = performance.now(); }
      else if (now !== last && performance.now() - since > 180) void flush().catch(err => notice(err.message));
    } catch (err) { notice(err.message); }
  }, 120);
  return {
    get ready() { return ready; }, get restoring() { return restoring; },
    get canBack() { return (history.state?.cwDepth || 0) > 0; },
    async start() { await load(); ready = true; if (!blocked) await flush(); },
    flush,
    async copy() { await flush(true); if (blocked) throw new Error('Restore the link or choose New view first'); if (canonical(await read()) !== canonical(capture())) throw new Error('The view changed or could not be saved. Try Copy link again.'); await navigator.clipboard.writeText(location.href); notice('View link copied'); },
    back() { if (this.canBack) history.back(); },
    newView() { blocked = false; last = ''; generation++; history.replaceState({ cwDepth: 0 }, '', location.pathname); void flush(); },
  };
}
