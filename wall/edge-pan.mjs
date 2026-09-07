// Screen-space pan constraint and a gesture-local zoom conversion. The
// Viewport remains the camera owner; this object returns candidate transforms.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const DEAD_ZONE = 32;
const ZOOM_DISTANCE = 320;

export function boundPan(view, area, bounds) {
  const margin = Math.min(24, area.w * 0.04, area.h * 0.04);
  const axis = (position, lo, hi, length) => {
    const a = margin - lo * view.scale;
    const b = length - margin - hi * view.scale;
    return clamp(position, Math.min(a, b), Math.max(a, b));
  };
  return { x: axis(view.x, bounds.x, bounds.x + bounds.w, area.w),
    y: axis(view.y, bounds.y, bounds.y + bounds.h, area.h), scale: view.scale };
}

export class EdgePan {
  constructor() { this.latch = null; }
  reset() { this.latch = null; }

  move(view, dx, dy, { area, bounds, items, point, zoom, maxScale }) {
    if (!bounds) return { ...view, x: view.x + dx, y: view.y + dy, phase: '' };
    if (!zoom) {
      this.reset();
      const next = boundPan({ ...view, x: view.x + dx, y: view.y + dy }, area, bounds);
      return { ...next, phase: next.x !== view.x + dx || next.y !== view.y + dy ? 'limit' : '' };
    }
    if (!this.latch) {
      const proposed = { ...view, x: view.x + dx, y: view.y + dy };
      const base = boundPan(proposed, area, bounds);
      const ox = proposed.x - base.x, oy = proposed.y - base.y;
      const length = Math.hypot(ox, oy);
      if (length < 0.01) return { ...base, phase: '' };
      const normal = { x: ox / length, y: oy / length };
      // Pick real content at the approached edge, not an empty pointer anchor.
      const query = {
        x: Math.abs(normal.x) > 0.1 ? (normal.x > 0 ? bounds.x : bounds.x + bounds.w) : (point.x - base.x) / base.scale,
        y: Math.abs(normal.y) > 0.1 ? (normal.y > 0 ? bounds.y : bounds.y + bounds.h) : (point.y - base.y) / base.scale,
      };
      let anchor = query, nearest = Infinity;
      for (const item of items) {
        const x = clamp(query.x, item.x, item.x + item.w);
        const y = clamp(query.y, item.y, item.y + item.h);
        const distance = Math.hypot(x - query.x, y - query.y);
        if (distance < nearest) { anchor = { x, y }; nearest = distance; }
      }
      this.latch = { base, normal, anchor, pressure: 0 };
      // Only the blocked portion of this event contributes to edge pressure.
      dx = ox; dy = oy;
    }

    const l = this.latch;
    const normalDelta = dx * l.normal.x + dy * l.normal.y;
    const pressure = l.pressure + normalDelta;
    const corner = Math.abs(l.normal.x) > 0.001 && Math.abs(l.normal.y) > 0.001;
    // Tangential motion still travels along the boundary. Clamp against the
    // latched scale so changing scale cannot alternate pan/zoom every frame.
    l.base = boundPan({ ...l.base,
      x: l.base.x + (corner ? 0 : dx - normalDelta * l.normal.x),
      y: l.base.y + (corner ? 0 : dy - normalDelta * l.normal.y) }, area, bounds);
    if (pressure < 0) {
      const next = boundPan({ ...l.base,
        x: l.base.x + l.normal.x * pressure,
        y: l.base.y + l.normal.y * pressure }, area, bounds);
      this.reset();
      return { ...next, phase: '' };
    }
    const limit = Math.max(1, Math.min(2, maxScale / l.base.scale));
    // Discard excess pressure at the cap: reversing should respond at once.
    l.pressure = Math.min(pressure, DEAD_ZONE + ZOOM_DISTANCE * Math.log(limit));
    const factor = Math.exp(Math.max(0, l.pressure - DEAD_ZONE) / ZOOM_DISTANCE);
    const scale = l.base.scale * factor;
    return { x: l.base.x + l.anchor.x * (l.base.scale - scale),
      y: l.base.y + l.anchor.y * (l.base.scale - scale), scale,
      phase: factor > 1 ? 'zoom' : limit === 1 ? 'limit' : 'edge' };
  }
}
