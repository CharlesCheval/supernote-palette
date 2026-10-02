/**
 * Solid fill that meets the REAL ink of its outline. Pure logic, unit-tested.
 *
 * The fill is made of lines (the SDK has no filled shape). Stopping them at the
 * outline's nominal width failed both ways: a pressure stroke is thinner than
 * its pen setting in places, so the fill either spilled over the outline or
 * left a white rim. Here the outline is taken as drawn (its ink contour when the
 * SDK gives it), and the fill is:
 * - ONE ring, following the inner edge of the ink at half a line width, so its
 *   outer edge touches the ink: a smooth edge, no scallops;
 * - straight rows inside, ending on the ring, which hides their round ends.
 * Rows cost two points whatever their length, so the whole fill stays light
 * (concentric rings down to the centre would cost dozens of times more).
 *
 * Method, on a grid of `cell` px: draw the ink, find what is enclosed, measure
 * every inside cell's distance to the ink, then trace the ring as the line at
 * distance w/2 (marching squares) and cut the rows where the distance is ≥ w/2.
 */

import {range} from './patterns';

export type P = {x: number; y: number};

/** The outline as drawn: ink contour loops, or a centre line and its width. */
export type Ink = {loops: P[][]; centre: P[]} | {points: P[]; width: number};

type Grid = {x0: number; y0: number; cols: number; rows: number; cell: number};

const SQRT2 = Math.SQRT2;

/** Marks the cells within `radius` px of a polyline. */
function stampLine(
  mask: Uint8Array,
  g: Grid,
  points: P[],
  radius: number,
  closed = false,
) {
  const r = Math.max(radius, g.cell * 0.75) / g.cell;
  const ri = Math.ceil(r);
  const put = (x: number, y: number) => {
    const cx = (x - g.x0) / g.cell;
    const cy = (y - g.y0) / g.cell;
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const gx = ix + dx;
        const gy = iy + dy;
        if (
          gx >= 0 &&
          gy >= 0 &&
          gx < g.cols &&
          gy < g.rows &&
          (gx - cx) * (gx - cx) + (gy - cy) * (gy - cy) <= r * r
        ) {
          mask[gy * g.cols + gx] = 1;
        }
      }
    }
  };
  const pts = closed ? [...points, points[0]] : points;
  put(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell / 2)),
    );
    for (let k = 1; k <= steps; k++) {
      put(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps);
    }
  }
}

/** Breadth-first flood through cells where `open` holds (4-neighbours). */
function flood(
  g: Grid,
  open: (i: number) => boolean,
  seeds: Iterable<number>,
  maxSteps = Infinity,
  diagonals = false,
): Int32Array {
  const n = g.cols * g.rows;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const s of seeds) {
    if (dist[s] < 0 && open(s)) {
      dist[s] = 0;
      queue[tail++] = s;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= maxSteps) {
      continue;
    }
    const x = i % g.cols;
    if (x > 0 && dist[i - 1] < 0 && open(i - 1)) {
      dist[i - 1] = dist[i] + 1;
      queue[tail++] = i - 1;
    }
    if (x < g.cols - 1 && dist[i + 1] < 0 && open(i + 1)) {
      dist[i + 1] = dist[i] + 1;
      queue[tail++] = i + 1;
    }
    if (i >= g.cols && dist[i - g.cols] < 0 && open(i - g.cols)) {
      dist[i - g.cols] = dist[i] + 1;
      queue[tail++] = i - g.cols;
    }
    if (i + g.cols < n && dist[i + g.cols] < 0 && open(i + g.cols)) {
      dist[i + g.cols] = dist[i] + 1;
      queue[tail++] = i + g.cols;
    }
    if (diagonals) {
      const y = (i - x) / g.cols;
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        const j = ny * g.cols + nx;
        if (
          nx >= 0 &&
          ny >= 0 &&
          nx < g.cols &&
          ny < g.rows &&
          dist[j] < 0 &&
          open(j)
        ) {
          dist[j] = dist[i] + 1;
          queue[tail++] = j;
        }
      }
    }
  }
  return dist;
}

/** The ink drawn on the grid: contour loops filled where the centre line runs. */
function drawInk(g: Grid, inks: Ink[]): Uint8Array {
  const n = g.cols * g.rows;
  const ink = new Uint8Array(n);
  for (const k of inks) {
    if ('points' in k) {
      stampLine(ink, g, k.points, k.width / 2);
      continue;
    }
    // Contour loops as thin walls; the regions they bound that hold the centre
    // line are ink, the others (the inside of a closed stroke) are not.
    const walls = new Uint8Array(n);
    for (const loop of k.loops) {
      stampLine(walls, g, loop, g.cell * 0.75, true);
    }
    const seeds: number[] = [];
    for (const p of k.centre) {
      const gx = Math.round((p.x - g.x0) / g.cell);
      const gy = Math.round((p.y - g.y0) / g.cell);
      if (gx >= 0 && gy >= 0 && gx < g.cols && gy < g.rows) {
        seeds.push(gy * g.cols + gx);
      }
    }
    const body = flood(g, i => !walls[i], seeds);
    for (let i = 0; i < n; i++) {
      if (walls[i] || body[i] >= 0) {
        ink[i] = 1;
      }
    }
  }
  return ink;
}

/** Distance (px) from each inside cell to the nearest cell that is not inside. */
function distanceInside(g: Grid, inside: Uint8Array): Float32Array {
  const {cols, rows} = g;
  const d = new Float32Array(cols * rows);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) {
    d[i] = inside[i] ? BIG : 0;
  }
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= cols || y >= rows ? 0 : d[y * cols + x];
  // Two-pass chamfer (1, √2): within a few percent of the true distance.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (d[i]) {
        d[i] = Math.min(
          d[i],
          at(x - 1, y) + 1,
          at(x, y - 1) + 1,
          at(x - 1, y - 1) + SQRT2,
          at(x + 1, y - 1) + SQRT2,
        );
      }
    }
  }
  for (let y = rows - 1; y >= 0; y--) {
    for (let x = cols - 1; x >= 0; x--) {
      const i = y * cols + x;
      if (d[i]) {
        d[i] = Math.min(
          d[i],
          at(x + 1, y) + 1,
          at(x, y + 1) + 1,
          at(x + 1, y + 1) + SQRT2,
          at(x - 1, y + 1) + SQRT2,
        );
      }
    }
  }
  // Cell distances to cell centres; the edge lies half a cell beyond.
  for (let i = 0; i < d.length; i++) {
    d[i] = d[i] ? (d[i] - 0.5) * g.cell : 0;
  }
  return d;
}

/** Closed lines where the field crosses `level` (marching squares), in px. */
function isolines(g: Grid, f: Float32Array, level: number): P[][] {
  const {cols, rows, cell, x0, y0} = g;
  const v = (x: number, y: number) => f[y * cols + x] - level;
  const key = (p: P) => `${Math.round(p.x * 8)},${Math.round(p.y * 8)}`;
  const point = (xa: number, ya: number, xb: number, yb: number): P => {
    const a = v(xa, ya);
    const b = v(xb, yb);
    const t = a === b ? 0.5 : a / (a - b);
    return {
      x: x0 + (xa + t * (xb - xa)) * cell,
      y: y0 + (ya + t * (yb - ya)) * cell,
    };
  };
  // Segments of every grid square, then chained into loops.
  const next = new Map<string, P[]>();
  const add = (a: P, b: P) => {
    const ka = key(a);
    const kb = key(b);
    next.set(ka, [...(next.get(ka) ?? []), b]);
    next.set(kb, [...(next.get(kb) ?? []), a]);
  };
  for (let y = 0; y + 1 < rows; y++) {
    for (let x = 0; x + 1 < cols; x++) {
      const tl = v(x, y) > 0;
      const tr = v(x + 1, y) > 0;
      const br = v(x + 1, y + 1) > 0;
      const bl = v(x, y + 1) > 0;
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0); // eslint-disable-line no-bitwise
      if (c === 0 || c === 15) {
        continue;
      }
      const top = () => point(x, y, x + 1, y);
      const right = () => point(x + 1, y, x + 1, y + 1);
      const bottom = () => point(x, y + 1, x + 1, y + 1);
      const left = () => point(x, y, x, y + 1);
      switch (c) {
        case 1:
        case 14:
          add(left(), bottom());
          break;
        case 2:
        case 13:
          add(bottom(), right());
          break;
        case 3:
        case 12:
          add(left(), right());
          break;
        case 4:
        case 11:
          add(top(), right());
          break;
        case 6:
        case 9:
          add(top(), bottom());
          break;
        case 7:
        case 8:
          add(left(), top());
          break;
        case 5:
          add(left(), top());
          add(bottom(), right());
          break;
        case 10:
          add(top(), right());
          add(left(), bottom());
          break;
      }
    }
  }
  const points = new Map<string, P>();
  for (const ns of next.values()) {
    for (const p of ns) {
      points.set(key(p), p);
    }
  }
  const used = new Set<string>();
  const loops: P[][] = [];
  for (const start of next.keys()) {
    if (used.has(start)) {
      continue;
    }
    const loop: P[] = [];
    let cur: string | undefined = start;
    let prev: string | undefined;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(points.get(cur)!);
      const options: string[] = (next.get(cur) ?? []).map(key);
      const nxt: string | undefined = options.find(
        o => o !== prev && !used.has(o),
      );
      prev = cur;
      cur = nxt;
    }
    if (loop.length >= 4) {
      loops.push([...loop, loop[0]]);
    }
  }
  return loops;
}

/** Fewer points, same line within `tol` px (Douglas-Peucker). */
export function simplify(points: P[], tol: number): P[] {
  if (points.length < 3) {
    return points;
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a];
    const pb = points[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let far = 0;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const dist = len
        ? Math.abs(dy * (p.x - pa.x) - dx * (p.y - pa.y)) / len
        : Math.hypot(p.x - pa.x, p.y - pa.y);
      if (dist > far) {
        far = dist;
        best = i;
      }
    }
    if (best > 0 && far > tol) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export type SolidFill = {rings: P[][]; rows: [P, P][]};

/**
 * Ring and rows of a solid fill, for lines `width` px wide, rows `spacing` px
 * apart. `gap`: outline ends closer than this are taken as joined (shapes made
 * of several strokes). Null when the ink encloses nothing.
 */
export function solidFill(
  inks: Ink[],
  width: number,
  spacing: number,
  gap = 0,
  cell = 2,
): SolidFill | null {
  const all = inks.flatMap(k => ('points' in k ? k.points : k.loops.flat()));
  if (!all.length) {
    return null;
  }
  const xs = range(all.map(p => p.x));
  const ys = range(all.map(p => p.y));
  const pad = gap + 4 * cell + 2;
  const g: Grid = {
    x0: xs.min - pad,
    y0: ys.min - pad,
    cell,
    cols: Math.ceil((xs.max - xs.min + 2 * pad) / cell) + 1,
    rows: Math.ceil((ys.max - ys.min + 2 * pad) / cell) + 1,
  };
  const n = g.cols * g.rows;
  const ink = drawInk(g, inks);

  // A closed outline encloses its inside as drawn (exact, corners included).
  // Only when it does not (ends of several strokes not quite meeting) are the
  // ends joined by `gap`.
  const inside = enclose(g, ink, 0) ?? (gap > 0 ? enclose(g, ink, gap) : null);
  if (!inside) {
    return null;
  }
  const d = distanceInside(g, inside);
  // Contour loops are drawn as walls about 1.5 cells thick, centred on the real
  // edge: the inside starts that much short of it, which is made up here.
  const wall = inks.some(k => 'loops' in k) ? 0.75 * cell : 0;
  const r = width / 2 - wall;
  const rings = isolines(g, d, r)
    .map(l => simplify(l, 0.6))
    .filter(l => l.length >= 4);

  // Rows: where the distance to the ink is at least r (inside the ring's line).
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < n; i++) {
    if (d[i] >= r) {
      const y = g.y0 + Math.floor(i / g.cols) * cell;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const rows: [P, P][] = [];
  if (top <= bottom) {
    const span = bottom - top;
    const step =
      span > 0 ? span / Math.max(1, Math.ceil(span / spacing)) : spacing;
    for (let y = top; y <= bottom + 1e-9; y += step) {
      const gy = Math.round((y - g.y0) / cell);
      let start = -1;
      for (let gx = 0; gx <= g.cols; gx++) {
        const on = gx < g.cols && d[gy * g.cols + gx] >= r;
        if (on && start < 0) {
          start = gx;
        } else if (!on && start >= 0) {
          const xa = g.x0 + start * cell;
          const xb = g.x0 + (gx - 1) * cell;
          rows.push([
            {x: xa, y},
            {x: Math.max(xa + 0.5, xb), y},
          ]);
          start = -1;
        }
      }
    }
  }
  return rings.length || rows.length ? {rings, rows} : null;
}

/**
 * Inside cells (1) of what the ink encloses, or null. With a `gap`, the ink is
 * first thickened by it so that nearly meeting ends meet, then the enclosed
 * part grows back to the real ink — diagonals included, or it could not reach
 * into corners — but no further than the gap, so it never leaks out through
 * an opening.
 */
function enclose(g: Grid, ink: Uint8Array, gap: number): Uint8Array | null {
  const n = g.cols * g.rows;
  const nearInk =
    gap > 0
      ? flood(g, () => true, inkCells(ink), Math.ceil(gap / g.cell))
      : null;
  const blocked = (i: number) =>
    ink[i] === 1 || (nearInk !== null && nearInk[i] >= 0);
  const border: number[] = [];
  for (let x = 0; x < g.cols; x++) {
    border.push(x, (g.rows - 1) * g.cols + x);
  }
  for (let y = 0; y < g.rows; y++) {
    border.push(y * g.cols, y * g.cols + g.cols - 1);
  }
  const outside = flood(g, i => !blocked(i), border);
  const core: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!blocked(i) && outside[i] < 0) {
      core.push(i);
    }
  }
  if (!core.length) {
    return null;
  }
  const inside = new Uint8Array(n);
  if (gap === 0) {
    for (const i of core) {
      inside[i] = 1;
    }
    return inside;
  }
  const grown = flood(
    g,
    i => !ink[i] && outside[i] < 0,
    core,
    Math.ceil(gap / g.cell) + 1,
    true,
  );
  for (let i = 0; i < n; i++) {
    inside[i] = grown[i] >= 0 ? 1 : 0;
  }
  return inside;
}

function inkCells(ink: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    if (ink[i]) {
      out.push(i);
    }
  }
  return out;
}
