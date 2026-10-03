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
  open: Uint8Array,
  seeds: ArrayLike<number>,
  maxSteps = Infinity,
  diagonals = false,
): Int32Array {
  // Plain loops over typed arrays, no callbacks: this runs over up to a
  // million cells on the device's interpreter (no JIT).
  const {cols, rows} = g;
  const n = cols * rows;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < seeds.length; k++) {
    const s0 = seeds[k];
    if (dist[s0] < 0 && open[s0]) {
      dist[s0] = 0;
      queue[tail++] = s0;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const next = dist[i] + 1;
    if (next > maxSteps) {
      continue;
    }
    const x = i % cols;
    const up = i >= cols;
    const down = i + cols < n;
    const left = x > 0;
    const right = x < cols - 1;
    if (left && dist[i - 1] < 0 && open[i - 1]) {
      dist[i - 1] = next;
      queue[tail++] = i - 1;
    }
    if (right && dist[i + 1] < 0 && open[i + 1]) {
      dist[i + 1] = next;
      queue[tail++] = i + 1;
    }
    if (up && dist[i - cols] < 0 && open[i - cols]) {
      dist[i - cols] = next;
      queue[tail++] = i - cols;
    }
    if (down && dist[i + cols] < 0 && open[i + cols]) {
      dist[i + cols] = next;
      queue[tail++] = i + cols;
    }
    if (diagonals) {
      if (up && left && dist[i - cols - 1] < 0 && open[i - cols - 1]) {
        dist[i - cols - 1] = next;
        queue[tail++] = i - cols - 1;
      }
      if (up && right && dist[i - cols + 1] < 0 && open[i - cols + 1]) {
        dist[i - cols + 1] = next;
        queue[tail++] = i - cols + 1;
      }
      if (down && left && dist[i + cols - 1] < 0 && open[i + cols - 1]) {
        dist[i + cols - 1] = next;
        queue[tail++] = i + cols - 1;
      }
      if (down && right && dist[i + cols + 1] < 0 && open[i + cols + 1]) {
        dist[i + cols + 1] = next;
        queue[tail++] = i + cols + 1;
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
    const open = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      open[i] = walls[i] ? 0 : 1;
    }
    const body = flood(g, open, seeds);
    for (let i = 0; i < n; i++) {
      if (walls[i] || body[i] >= 0) {
        ink[i] = 1;
      }
    }
  }
  return ink;
}

/**
 * Chamfer distance (1, √2), in cells, from the cells where `seed` is set, for
 * the cells where `within` is set (others stay far). Two passes of plain loops;
 * the grid's padding keeps every cell considered off its border.
 */
function chamfer(g: Grid, seed: Uint8Array, within: Uint8Array): Float32Array {
  const {cols, rows} = g;
  const BIG = 1e9;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) {
    d[i] = seed[i] ? 0 : BIG;
  }
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1, i = y * cols + 1; x < cols - 1; x++, i++) {
      if (!within[i] || d[i] === 0) {
        continue;
      }
      let v = d[i];
      let c = d[i - 1] + 1;
      if (c < v) {
        v = c;
      }
      c = d[i - cols] + 1;
      if (c < v) {
        v = c;
      }
      c = d[i - cols - 1] + SQRT2;
      if (c < v) {
        v = c;
      }
      c = d[i - cols + 1] + SQRT2;
      if (c < v) {
        v = c;
      }
      d[i] = v;
    }
  }
  for (let y = rows - 2; y >= 1; y--) {
    for (let x = cols - 2, i = y * cols + cols - 2; x >= 1; x--, i--) {
      if (!within[i] || d[i] === 0) {
        continue;
      }
      let v = d[i];
      let c = d[i + 1] + 1;
      if (c < v) {
        v = c;
      }
      c = d[i + cols] + 1;
      if (c < v) {
        v = c;
      }
      c = d[i + cols + 1] + SQRT2;
      if (c < v) {
        v = c;
      }
      c = d[i + cols - 1] + SQRT2;
      if (c < v) {
        v = c;
      }
      d[i] = v;
    }
  }
  return d;
}

/** Distance (px) from each inside cell to the nearest cell that is not inside. */
function distanceInside(g: Grid, inside: Uint8Array): Float32Array {
  const n = g.cols * g.rows;
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    outside[i] = inside[i] ? 0 : 1;
  }
  const d = chamfer(g, outside, inside);
  // Cell distances to cell centres; the edge lies half a cell beyond.
  for (let i = 0; i < n; i++) {
    d[i] = inside[i] ? (d[i] - 0.5) * g.cell : 0;
  }
  return d;
}

/** Closed lines where the field crosses `level` (marching squares), in px. */
function isolines(g: Grid, f: Float32Array, level: number): P[][] {
  const {cols, rows, cell, x0, y0} = g;
  const v = (x: number, y: number) => f[y * cols + x] - level;
  // Numeric keys (1/8 px), cheaper than strings on the device.
  const key = (p: P) =>
    Math.round((p.x - x0) * 8) * 1048576 + Math.round((p.y - y0) * 8);
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
  const next = new Map<number, P[]>();
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
  const points = new Map<number, P>();
  for (const ns of next.values()) {
    for (const p of ns) {
      points.set(key(p), p);
    }
  }
  const used = new Set<number>();
  const loops: P[][] = [];
  for (const start of next.keys()) {
    if (used.has(start)) {
      continue;
    }
    const loop: P[] = [];
    let cur: number | undefined = start;
    let prev: number | undefined;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(points.get(cur)!);
      const options: number[] = (next.get(cur) ?? []).map(key);
      const nxt: number | undefined = options.find(
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

export type SolidFill = {
  rings: P[][];
  rows: [P, P][];
  /** Rows of the fine pass, in the parts too narrow for the main lines. */
  fineRows: [P, P][];
  /** What is inserted: few continuous paths, each with its line width. */
  paths: {points: P[]; width: number}[];
};

/** Fine pass: lines this wide (px), as far apart as the grid. */
const FINE_WIDTH = 3;

/**
 * Ring and rows of a solid fill, for lines `width` px wide, rows `spacing` px
 * apart, then a fine pass in the parts too narrow for them (sharp tips), and
 * the whole chained into as few continuous paths as possible. `gap`: outline
 * ends closer than this are taken as joined (shapes made of several strokes).
 * Null when the ink encloses nothing.
 */
/** What the ink encloses on a grid, and each inside cell's distance to it. */
type Field = {g: Grid; inside: Uint8Array; d: Float32Array};

function field(inks: Ink[], gap: number, cellSize?: number): Field | null {
  const all = inks.flatMap(k => ('points' in k ? k.points : k.loops.flat()));
  if (!all.length) {
    return null;
  }
  const xs = range(all.map(p => p.x));
  const ys = range(all.map(p => p.y));
  // Cells of 2 px for small shapes, up to 3 px for a whole page: the work
  // grows with the number of cells. 4 px was faster but left the edge of a
  // large fill visibly rough.
  const cell =
    cellSize ??
    Math.max(
      2,
      Math.min(3, Math.sqrt(((xs.max - xs.min) * (ys.max - ys.min)) / 250000)),
    );
  const pad = gap + 4 * cell + 2;
  const g: Grid = {
    x0: xs.min - pad,
    y0: ys.min - pad,
    cell,
    cols: Math.ceil((xs.max - xs.min + 2 * pad) / cell) + 1,
    rows: Math.ceil((ys.max - ys.min + 2 * pad) / cell) + 1,
  };
  const ink = drawInk(g, inks);
  // A closed outline encloses its inside as drawn (exact, corners included).
  // Only when it does not (ends of several strokes not quite meeting) are the
  // ends joined by `gap`.
  const inside = enclose(g, ink, 0) ?? (gap > 0 ? enclose(g, ink, gap) : null);
  return inside ? {g, inside, d: distanceInside(g, inside)} : null;
}

/**
 * Hatching: parallel lines `spacing` px apart at `angleDeg`, kept at least
 * `clearance` px from the ink, measured square to it. The former hatching kept
 * its distance along each line only, so where the outline ran nearly parallel
 * to the lines their ends ran onto a thick outline.
 */
export function hatchFill(
  inks: Ink[],
  angleDeg: number,
  spacing: number,
  clearance: number,
  gap = 0,
): {segments: [P, P][]; paths: P[][]} | null {
  const f = field(inks, gap);
  if (!f) {
    return null;
  }
  const {g, d} = f;
  const a = (angleDeg * Math.PI) / 180;
  const u = {x: Math.cos(a), y: Math.sin(a)};
  const nrm = {x: -u.y, y: u.x};
  const ok = (x: number, y: number) => {
    const gx = Math.round((x - g.x0) / g.cell);
    const gy = Math.round((y - g.y0) / g.cell);
    return (
      gx >= 0 &&
      gy >= 0 &&
      gx < g.cols &&
      gy < g.rows &&
      d[gy * g.cols + gx] >= clearance
    );
  };
  // Extent across and along the lines, from the grid's corners.
  const corners = [
    {x: g.x0, y: g.y0},
    {x: g.x0 + g.cols * g.cell, y: g.y0},
    {x: g.x0, y: g.y0 + g.rows * g.cell},
    {x: g.x0 + g.cols * g.cell, y: g.y0 + g.rows * g.cell},
  ];
  const across = range(corners.map(p => p.x * nrm.x + p.y * nrm.y));
  const along = range(corners.map(p => p.x * u.x + p.y * u.y));
  const ds = g.cell;
  const out: [P, P][] = [];
  const at = (t: number, c: number): P => ({
    x: t * u.x + c * nrm.x,
    y: t * u.y + c * nrm.y,
  });
  // Lines on a fixed lattice (multiples of the spacing), centred as before.
  for (
    let c = Math.ceil(across.min / spacing) * spacing + spacing / 2;
    c <= across.max;
    c += spacing
  ) {
    let start: number | null = null;
    for (let t = along.min; t <= along.max + ds; t += ds) {
      const p = at(t, c);
      const on = t <= along.max && ok(p.x, p.y);
      if (on && start === null) {
        start = t;
      } else if (!on && start !== null) {
        const end = t - ds;
        if (end - start >= 2 * g.cell) {
          out.push([at(start, c), at(end, c)]);
        }
        start = null;
      }
    }
  }
  // The same lines chained into few paths, each join running along the edge,
  // in the band between the ink's centre and the line ends: under a stroke
  // drawn above it, so unseen. (Each hatch line as its own element made a
  // hatched shape heavy to move with the lasso.)
  const way = new Uint8Array(g.cols * g.rows);
  for (let i = 0; i < way.length; i++) {
    way[i] = f.inside[i] && d[i] <= clearance + g.cell / 2 ? 1 : 0;
  }
  return {segments: out, paths: chain(g, way, [], out)};
}

export function solidFill(
  inks: Ink[],
  width: number,
  spacing: number,
  gap = 0,
  cellSize?: number,
  overlap = 0,
): SolidFill | null {
  const f = field(inks, gap, cellSize);
  if (!f) {
    return null;
  }
  const {g, inside, d} = f;
  const cell = g.cell;
  const n = g.cols * g.rows;
  // Contour loops are drawn as walls about 1.5 cells thick, centred on the real
  // edge: the inside starts that much short of it, which is made up here.
  const wall = inks.some(k => 'loops' in k) ? 0.75 * cell : 0;
  // `overlap`: the ring's outer edge goes that far under the ink, so the grid
  // (cells of 2–3 px) and the host's rendering leave no white sliver along it.
  const r = Math.max(1, width / 2 - wall - overlap);
  const rings = isolines(g, d, r)
    .map(l => simplify(l, 0.6))
    .filter(l => l.length >= 4);

  // Main rows: where the distance to the ink is at least r (inside the ring).
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    core[i] = d[i] >= r ? 1 : 0;
  }
  const rows = rowsIn(g, core, spacing);

  // Fine pass: inside cells the main lines do not reach — farther than r (plus
  // the overlap, which the ring also covers, and a cell) from the core, along whose edge the ring runs — i.e. tips narrower
  // than a main line. Not the band along the edge, which the ring covers.
  const reach = chamfer(g, core, inside);
  const left = new Uint8Array(n);
  let leftCount = 0;
  for (let i = 0; i < n; i++) {
    if (inside[i] && !core[i] && reach[i] * cell > r + overlap + cell) {
      left[i] = 1;
      leftCount++;
    }
  }
  const fineRows = leftCount ? rowsIn(g, left, cell) : [];

  // Chained paths: main lines move through the core (their connections run
  // inside the filled area, unseen); fine lines anywhere inside, half their
  // width off the edge (under the main fill, unseen). An isolated part gets
  // its own path.
  const fineWay = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    fineWay[i] = left[i] || d[i] >= FINE_WIDTH / 2 ? 1 : 0;
  }
  const paths = [
    ...chain(g, core, rings, rows).map(points => ({points, width})),
    ...chain(g, fineWay, [], fineRows).map(points => ({
      points,
      width: FINE_WIDTH,
    })),
  ];
  return paths.length ? {rings, rows, fineRows, paths} : null;
}

/** Horizontal segments `spacing` px apart through the cells of a mask. */
function rowsIn(g: Grid, mask: Uint8Array, spacing: number): [P, P][] {
  const {cols, rows: nRows, cell} = g;
  let first = -1;
  let last = -1;
  for (let gy = 0; gy < nRows; gy++) {
    for (let i = gy * cols, end = i + cols; i < end; i++) {
      if (mask[i]) {
        if (first < 0) {
          first = gy;
        }
        last = gy;
        break;
      }
    }
  }
  const rows: [P, P][] = [];
  if (first < 0) {
    return rows;
  }
  const top = g.y0 + first * cell;
  const span = (last - first) * cell;
  const step =
    span > 0 ? span / Math.max(1, Math.ceil(span / spacing)) : spacing;
  for (let y = top; y <= top + span + 1e-9; y += step) {
    const gy = Math.round((y - g.y0) / cell);
    const base = gy * cols;
    let start = -1;
    for (let gx = 0; gx <= cols; gx++) {
      const on = gx < cols && mask[base + gx] === 1;
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
  return rows;
}

/** Longest single path inserted; longer ones are cut (to stay light for the host). */
const MAX_PATH_POINTS = 3000;

/**
 * Chains loops (gone round in full) and segments into continuous paths. From
 * the end of each piece, the nearest piece still to draw is joined, straight
 * when the straight line stays on `way` cells, otherwise along the shortest
 * way through them; a piece that cannot be reached starts a new path.
 */
function chain(
  g: Grid,
  way: Uint8Array,
  loops: P[][],
  segments: [P, P][],
): P[][] {
  type Piece = {pts: P[]; loop: boolean};
  const pieces: Piece[] = [
    ...loops.map(l => ({pts: l.slice(0, -1), loop: true})),
    ...segments.map(([a, b]) => ({pts: [a, b], loop: false})),
  ];
  const cellOf = (p: P) => {
    const gx = Math.min(
      g.cols - 1,
      Math.max(0, Math.round((p.x - g.x0) / g.cell)),
    );
    const gy = Math.min(
      g.rows - 1,
      Math.max(0, Math.round((p.y - g.y0) / g.cell)),
    );
    return gy * g.cols + gx;
  };
  // The nearest `way` cell to a point (pieces may end a hair off it).
  const snap = (p: P): number => {
    const c = cellOf(p);
    if (way[c]) {
      return c;
    }
    const cx = c % g.cols;
    const cy = (c - cx) / g.cols;
    for (let rad = 1; rad <= 3; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (
            x >= 0 &&
            y >= 0 &&
            x < g.cols &&
            y < g.rows &&
            way[y * g.cols + x]
          ) {
            return y * g.cols + x;
          }
        }
      }
    }
    return -1;
  };
  const straight = (a: P, b: P) => {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell / 2)),
    );
    for (let k = 0; k <= steps; k++) {
      const c = cellOf({
        x: a.x + ((b.x - a.x) * k) / steps,
        y: a.y + ((b.y - a.y) * k) / steps,
      });
      if (!way[c]) {
        return false;
      }
    }
    return true;
  };
  // Shortest way through `way` cells (8-neighbours), as points, or null.
  // Searched first in a window around both ends (cheap), then everywhere.
  const routeIn = (from: number, to: number, margin: number): P[] | null => {
    const fx = from % g.cols;
    const fy = (from - fx) / g.cols;
    const tx = to % g.cols;
    const ty = (to - tx) / g.cols;
    const x0 = Math.max(0, Math.min(fx, tx) - margin);
    const y0 = Math.max(0, Math.min(fy, ty) - margin);
    const x1 = Math.min(g.cols - 1, Math.max(fx, tx) + margin);
    const y1 = Math.min(g.rows - 1, Math.max(fy, ty) + margin);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const prev = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    const local = (c: number) =>
      ((c - (c % g.cols)) / g.cols - y0) * w + ((c % g.cols) - x0);
    const lf = local(from);
    const lt = local(to);
    let head = 0;
    let tail = 0;
    prev[lf] = lf;
    queue[tail++] = lf;
    while (head < tail && prev[lt] < 0) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
            const j = ny * w + nx;
            if (prev[j] < 0 && way[(ny + y0) * g.cols + nx + x0]) {
              prev[j] = i;
              queue[tail++] = j;
            }
          }
        }
      }
    }
    if (prev[lt] < 0) {
      return null;
    }
    const cells: number[] = [];
    for (let c = lt; c !== lf; c = prev[c]) {
      cells.push(c);
    }
    cells.push(lf);
    const pts = cells.reverse().map(c => ({
      x: g.x0 + ((c % w) + x0) * g.cell,
      y: g.y0 + (Math.floor(c / w) + y0) * g.cell,
    }));
    return simplify(pts, 0.5);
  };
  const route = (a: P, b: P): P[] | null => {
    const from = snap(a);
    const to = snap(b);
    if (from < 0 || to < 0) {
      return null;
    }
    return routeIn(from, to, 30) ?? routeIn(from, to, Math.max(g.cols, g.rows));
  };

  const paths: P[][] = [];
  const done = new Uint8Array(pieces.length);
  let current: P[] | null = null;
  const dist2 = (a: P, b: P) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  for (let count = 0; count < pieces.length; count++) {
    const here: P | null = current ? current[current.length - 1] : null;
    // Nearest piece to draw, and from which end (or point, for a loop).
    let best = -1;
    let bestAt = 0;
    let bestD = Infinity;
    for (let k = 0; k < pieces.length; k++) {
      if (done[k]) {
        continue;
      }
      if (!here) {
        best = k;
        bestAt = 0;
        break;
      }
      const pts = pieces[k].pts;
      const ends = pieces[k].loop ? pts.map((_, i) => i) : [0, pts.length - 1];
      for (const i of ends) {
        const dd = dist2(here, pts[i]);
        if (dd < bestD) {
          bestD = dd;
          best = k;
          bestAt = i;
        }
      }
    }
    done[best] = 1;
    const piece = pieces[best];
    const pts = piece.loop
      ? [
          ...piece.pts.slice(bestAt),
          ...piece.pts.slice(0, bestAt),
          piece.pts[bestAt],
        ]
      : bestAt === 0
      ? piece.pts
      : [...piece.pts].reverse();
    let joined = false;
    if (current && here) {
      if (straight(here, pts[0])) {
        joined = true;
      } else {
        const way_ = route(here, pts[0]);
        if (way_) {
          current.push(...way_);
          joined = true;
        }
      }
    }
    if (joined && current && current.length + pts.length <= MAX_PATH_POINTS) {
      current.push(...pts);
    } else {
      current = [...pts];
      paths.push(current);
    }
  }
  return paths;
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
  const blocked = new Uint8Array(n);
  if (gap > 0) {
    const near = flood(
      g,
      new Uint8Array(n).fill(1),
      inkCells(ink),
      Math.ceil(gap / g.cell),
    );
    for (let i = 0; i < n; i++) {
      blocked[i] = ink[i] || near[i] >= 0 ? 1 : 0;
    }
  } else {
    blocked.set(ink);
  }
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    open[i] = blocked[i] ? 0 : 1;
  }
  const border: number[] = [];
  for (let x = 0; x < g.cols; x++) {
    border.push(x, (g.rows - 1) * g.cols + x);
  }
  for (let y = 0; y < g.rows; y++) {
    border.push(y * g.cols, y * g.cols + g.cols - 1);
  }
  const outside = flood(g, open, border);
  const inside = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (open[i] && outside[i] < 0) {
      inside[i] = 1;
      any = true;
    }
  }
  if (!any) {
    return null;
  }
  if (gap === 0) {
    return inside;
  }
  // Grow the enclosed core back to the real ink, diagonals included (or it
  // could not reach into corners), no further than the gap: never out
  // through an opening.
  const way = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    way[i] = !ink[i] && outside[i] < 0 ? 1 : 0;
  }
  const core = inkCells(inside);
  const grown = flood(g, way, core, Math.ceil(gap / g.cell) + 1, true);
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
