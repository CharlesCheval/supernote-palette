/**
 * Dashes, hatching and fills computed from an element's outline, in page pixels.
 * Pure logic, unit-tested. Supernote has no dashed or filled style, so each
 * result is a set of polylines inserted as plain geometries.
 */

export type P = {x: number; y: number};

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: P, b: P, t: number): P => ({x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y)});

export type DashStyle = 'dashed' | 'dotted' | 'dashdot' | 'long';

export const DASH_STYLES: DashStyle[] = ['dashed', 'long', 'dotted', 'dashdot'];

/**
 * On / off lengths (px) for a line `w` px wide: [on, off, on, off, …].
 * A dot is a 1 px dash: the line width makes it round.
 */
export function dashPattern(style: DashStyle, w: number): number[] {
  const u = Math.max(3, w);
  switch (style) {
    case 'dashed':
      return [Math.max(16, 4 * u), Math.max(12, 3 * u)];
    case 'long':
      return [Math.max(36, 9 * u), Math.max(14, 3.5 * u)];
    case 'dotted':
      return [1, Math.max(10, 3 * u)];
    case 'dashdot':
      // Centre line (trait d'axe): long, gap, dot, gap.
      return [Math.max(36, 9 * u), Math.max(10, 2.5 * u), 1, Math.max(10, 2.5 * u)];
  }
}

/** Cuts a polyline into dashes that follow it, curves included. */
export function dashPolyline(points: P[], pattern: number[]): P[][] {
  const dashes: P[][] = [];
  let k = 0; // pattern index
  let left = pattern[0]; // length left in the current on / off piece
  let current: P[] | null = [points[0]];
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1];
    const b = points[i];
    let seg = dist(a, b);
    while (seg > 0) {
      const step = Math.min(seg, left);
      const p = lerp(a, b, step / seg);
      if (current) {
        current.push(p);
      }
      seg -= step;
      left -= step;
      a = p;
      if (left <= 1e-9) {
        if (current) {
          dashes.push(current);
          current = null;
        } else {
          current = [p];
        }
        k = (k + 1) % pattern.length;
        left = pattern[k];
      }
    }
  }
  if (current && current.length > 1) {
    dashes.push(current);
  }
  return dashes;
}

/**
 * Segments of parallel lines, `spacing` px apart at `angleDeg`, that lie inside
 * the polygon (even-odd rule, so holes and concave shapes work), kept `inset` px
 * away from the outline along each line and at both extremes.
 */
export function hatchSegments(polygon: P[], angleDeg: number, spacing: number, inset = 0): [P, P][] {
  const a = (angleDeg * Math.PI) / 180;
  const u = {x: Math.cos(a), y: Math.sin(a)}; // along the lines
  const n = {x: -u.y, y: u.x}; // across them
  const across = polygon.map(p => p.x * n.x + p.y * n.y);
  const lo = Math.min(...across);
  const hi = Math.max(...across);
  const out: [P, P][] = [];
  const first = lo + Math.max(inset, spacing / 2);
  for (let c = first; c <= hi - inset + 1e-9; c += spacing) {
    const hits: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i];
      const q = polygon[(i + 1) % polygon.length];
      const cp = across[i];
      const cq = across[(i + 1) % polygon.length];
      if ((cp <= c && cq > c) || (cq <= c && cp > c)) {
        const t = (c - cp) / (cq - cp);
        const x = lerp(p, q, t);
        hits.push(x.x * u.x + x.y * u.y);
      }
    }
    hits.sort((x, y) => x - y);
    for (let j = 0; j + 1 < hits.length; j += 2) {
      const from = hits[j] + inset;
      const to = hits[j + 1] - inset;
      if (to - from < 1) {
        continue;
      }
      const at = (s: number): P => ({x: s * u.x + c * n.x, y: s * u.y + c * n.y});
      out.push([at(from), at(to)]);
    }
  }
  return out;
}

/**
 * Solid fill: horizontal lines `spacing` px apart, closer than the line width so
 * they merge. Consecutive lines with a single segment are chained into one
 * zigzag polyline (few elements); a line crossing the shape more than once
 * (concave part, hole) starts new chains.
 */
export function fillPolylines(polygon: P[], spacing: number, inset = 0): P[][] {
  const rows = new Map<number, [P, P][]>();
  for (const s of hatchSegments(polygon, 0, spacing, inset)) {
    const key = Math.round(s[0].y * 1000);
    rows.set(key, [...(rows.get(key) ?? []), s]);
  }
  const chains: P[][] = [];
  let chain: P[] | null = null;
  let flip = false;
  for (const segs of [...rows.keys()].sort((x, y) => x - y).map(k => rows.get(k)!)) {
    if (segs.length !== 1) {
      if (chain) {
        chains.push(chain);
      }
      chain = null;
      chains.push(...segs.map(([p, q]) => [p, q]));
      continue;
    }
    const [p, q] = segs[0];
    const ordered = flip ? [q, p] : [p, q];
    flip = !flip;
    chain = chain ? [...chain, ...ordered] : ordered;
  }
  if (chain) {
    chains.push(chain);
  }
  return chains;
}

/**
 * Outline as a closed polygon, or null when it is too open to fill: the gap
 * between both ends must be under 20% of the outline size.
 */
export function closedOutline(points: P[]): P[] | null {
  if (points.length < 3) {
    return null;
  }
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (size <= 0 || dist(points[0], points[points.length - 1]) > 0.2 * size) {
    return null;
  }
  return points;
}

/** Points along an ellipse (geometry in pixels, angle in degrees). */
export function ellipsePoints(c: P, rx: number, ry: number, angleDeg: number, n = 96): P[] {
  const a = (angleDeg * Math.PI) / 180;
  return Array.from({length: n + 1}, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return {x: c.x + x * Math.cos(a) - y * Math.sin(a), y: c.y + x * Math.sin(a) + y * Math.cos(a)};
  });
}

/**
 * Dashes as per-point draw flags, for a stroke that stays ONE element: point i
 * is drawn when its distance along the stroke falls in an "on" piece of the
 * pattern. On pieces shorter than the point spacing (dots) are widened to
 * `minOn` so that they cover at least two points.
 */
export function dashFlags(points: P[], pattern: number[], minOn: number): boolean[] {
  const piece = pattern.map((l, i) => (i % 2 === 0 ? Math.max(l, minOn) : l));
  const period = piece.reduce((a, b) => a + b, 0);
  let s = 0;
  return points.map((p, i) => {
    if (i > 0) {
      s += dist(points[i - 1], p);
    }
    let r = s % period;
    for (let k = 0; k < piece.length; k++) {
      if (r < piece[k]) {
        return k % 2 === 0;
      }
      r -= piece[k];
    }
    return true;
  });
}

/** Mean distance between consecutive points. */
export function meanSpacing(points: P[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += dist(points[i - 1], points[i]);
  }
  return points.length > 1 ? total / (points.length - 1) : 0;
}
