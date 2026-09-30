/**
 * Closed areas formed by SEVERAL strokes (a triangle drawn in three strokes, a
 * square whose sides cross at the corners…), found on a grid. Pure logic,
 * unit-tested.
 *
 * 1. The strokes are drawn on a grid of `cell` px, thickened by `gap` px so that
 *    ends that almost meet do meet.
 * 2. Everything reachable from the border without crossing ink is outside; the
 *    rest that is not ink is enclosed.
 * 3. The enclosed area is grown back by `gap` (without entering the real strokes),
 *    so hatching reaches the lines as it does inside a single closed stroke.
 * 4. Parallel lines are cut into the segments that run inside.
 */

export type P = {x: number; y: number};
export type Outline = {points: P[]; width: number};

type Grid = {x0: number; y0: number; cols: number; rows: number; cell: number};

function stamp(mask: Uint8Array, g: Grid, outline: Outline, radius: number) {
  const r = Math.ceil(radius / g.cell);
  const put = (x: number, y: number) => {
    const cx = Math.round((x - g.x0) / g.cell);
    const cy = Math.round((y - g.y0) / g.cell);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (
          dx * dx + dy * dy <= r * r &&
          gx >= 0 &&
          gy >= 0 &&
          gx < g.cols &&
          gy < g.rows
        ) {
          mask[gy * g.cols + gx] = 1;
        }
      }
    }
  };
  const pts = outline.points;
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

/** Cells reachable from `seeds` through cells where `open` is true (4-neighbours). */
function flood(
  g: Grid,
  open: (i: number) => boolean,
  seeds: number[],
  maxSteps = Infinity,
): Int32Array {
  const dist = new Int32Array(g.cols * g.rows).fill(-1);
  const queue = new Int32Array(g.cols * g.rows);
  let head = 0;
  let tail = 0;
  for (const s of seeds) {
    if (dist[s] < 0) {
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
    const y = (i - x) / g.cols;
    const next = [
      x > 0 ? i - 1 : -1,
      x < g.cols - 1 ? i + 1 : -1,
      y > 0 ? i - g.cols : -1,
      y < g.rows - 1 ? i + g.cols : -1,
    ];
    for (const n of next) {
      if (n >= 0 && dist[n] < 0 && open(n)) {
        dist[n] = dist[i] + 1;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}

/** Enclosed area as a grid mask (1 = inside), or null when nothing is enclosed. */
export function enclosedArea(
  outlines: Outline[],
  gap: number,
  cell = 2,
): {grid: Grid; inside: Uint8Array} | null {
  const all = outlines.flatMap(o => o.points);
  if (!all.length) {
    return null;
  }
  const maxWidth = Math.max(...outlines.map(o => o.width));
  const pad = gap + maxWidth + 4 * cell;
  const x0 = Math.min(...all.map(p => p.x)) - pad;
  const y0 = Math.min(...all.map(p => p.y)) - pad;
  const grid: Grid = {
    x0,
    y0,
    cell,
    cols: Math.ceil((Math.max(...all.map(p => p.x)) + pad - x0) / cell) + 1,
    rows: Math.ceil((Math.max(...all.map(p => p.y)) + pad - y0) / cell) + 1,
  };
  const n = grid.cols * grid.rows;
  const ink = new Uint8Array(n); // the strokes as drawn
  const thick = new Uint8Array(n); // thickened to close small gaps
  for (const o of outlines) {
    stamp(ink, grid, o, o.width / 2);
    stamp(thick, grid, o, o.width / 2 + gap);
  }
  const border: number[] = [];
  for (let x = 0; x < grid.cols; x++) {
    border.push(x, (grid.rows - 1) * grid.cols + x);
  }
  for (let y = 0; y < grid.rows; y++) {
    border.push(y * grid.cols, y * grid.cols + grid.cols - 1);
  }
  const outside = flood(grid, i => !thick[i], border);
  const core: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!thick[i] && outside[i] < 0) {
      core.push(i);
    }
  }
  if (!core.length) {
    return null;
  }
  // Grow the enclosed core back by the gap, stopping at the real strokes and
  // never leaking outside (cells reached from the border stay outside).
  const grown = flood(
    grid,
    i => !ink[i] && outside[i] < 0,
    core,
    Math.ceil(gap / cell),
  );
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    inside[i] = grown[i] >= 0 ? 1 : 0;
  }
  return {grid, inside};
}

/**
 * Segments of parallel lines, `spacing` px apart at `angleDeg`, running inside
 * the enclosed area, kept `inset` px off its edge. With `edgeToEdge`, the first
 * and last lines sit at the edges (solid fills).
 */
export function areaSegments(
  area: {grid: Grid; inside: Uint8Array},
  angleDeg: number,
  spacing: number,
  inset = 0,
  edgeToEdge = false,
): [P, P][] {
  const {grid: g, inside} = area;
  const a = (angleDeg * Math.PI) / 180;
  const u = {x: Math.cos(a), y: Math.sin(a)};
  const nrm = {x: -u.y, y: u.x};
  const isIn = (x: number, y: number) => {
    const gx = Math.round((x - g.x0) / g.cell);
    const gy = Math.round((y - g.y0) / g.cell);
    return (
      gx >= 0 &&
      gy >= 0 &&
      gx < g.cols &&
      gy < g.rows &&
      inside[gy * g.cols + gx] === 1
    );
  };
  // Extent of the inside cells, across and along the lines.
  let lo = Infinity;
  let hi = -Infinity;
  let sLo = Infinity;
  let sHi = -Infinity;
  for (let i = 0; i < inside.length; i++) {
    if (inside[i]) {
      const x = g.x0 + (i % g.cols) * g.cell;
      const y = g.y0 + Math.floor(i / g.cols) * g.cell;
      const c = x * nrm.x + y * nrm.y;
      const s = x * u.x + y * u.y;
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
      sLo = Math.min(sLo, s);
      sHi = Math.max(sHi, s);
    }
  }
  if (lo > hi) {
    return [];
  }
  const first = lo + (edgeToEdge ? inset : Math.max(inset, spacing / 2));
  const last = hi - inset;
  const range = last - first;
  const step =
    edgeToEdge && range > 0
      ? range / Math.max(1, Math.ceil(range / spacing))
      : spacing;
  const ds = g.cell / 2;
  const out: [P, P][] = [];
  for (let c = first; c <= last + 1e-9; c += step) {
    let runStart: number | null = null;
    for (let s = sLo - g.cell; s <= sHi + g.cell; s += ds) {
      const inNow = isIn(s * u.x + c * nrm.x, s * u.y + c * nrm.y);
      if (inNow && runStart === null) {
        runStart = s;
      } else if (!inNow && runStart !== null) {
        const from = runStart + inset;
        const to = s - ds - inset;
        if (to - from >= 2 * g.cell) {
          const at = (t: number): P => ({
            x: t * u.x + c * nrm.x,
            y: t * u.y + c * nrm.y,
          });
          out.push([at(from), at(to)]);
        }
        runStart = null;
      }
    }
  }
  return out;
}
