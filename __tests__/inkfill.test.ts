import {P, hatchFill, simplify, solidFill} from '../src/inkfill';
import {ellipsePoints} from '../src/patterns';

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const C = {x: 400, y: 400};

test('ink contour of a closed stroke (outer and inner loops): the ring touches the inner edge, rows stay inside', () => {
  // A round stroke 20 px wide: ink from r = 80 to r = 100, centre line at 90.
  const outer = ellipsePoints(C, 100, 100, 0, 180);
  const inner = ellipsePoints(C, 80, 80, 0, 180);
  const centre = ellipsePoints(C, 90, 90, 0, 90);
  const w = 8;
  const fill = solidFill([{loops: [outer, inner], centre}], w, 5)!;
  expect(fill).not.toBeNull();
  expect(fill.rings).toHaveLength(1);
  // Ring centre line at 80 - w/2 = 76 from the centre (grid of 2 px: ±1.5 px).
  for (const p of fill.rings[0]) {
    expect(Math.abs(dist(p, C) - 76)).toBeLessThan(1.6);
  }
  // Rows end inside the ring's centre line, so their round ends hide in it.
  expect(fill.rows.length).toBeGreaterThan(20);
  for (const [a, b] of fill.rows) {
    expect(dist(a, C)).toBeLessThan(77.5);
    expect(dist(b, C)).toBeLessThan(77.5);
  }
});

test('a shape given by its centre line and width (geometries)', () => {
  const square = [{x: 100, y: 100}, {x: 500, y: 100}, {x: 500, y: 400}, {x: 100, y: 400}, {x: 100, y: 100}];
  const fill = solidFill([{points: square, width: 12}], 8, 5)!;
  // Inner edge of the ink at 106..494 × 106..394; ring centre line 4 px inside.
  const xs = fill.rings[0].map(p => p.x);
  expect(Math.min(...xs)).toBeGreaterThan(108);
  expect(Math.min(...xs)).toBeLessThan(112);
  expect(Math.max(...xs)).toBeGreaterThan(488);
  // A square ring simplifies to a handful of points.
  expect(fill.rings[0].length).toBeLessThan(40);
});

test('an open outline encloses nothing', () => {
  expect(solidFill([{points: [{x: 0, y: 0}, {x: 300, y: 0}, {x: 300, y: 300}], width: 6}], 8, 5)).toBeNull();
});

test('two strokes whose ends almost meet are joined by the gap', () => {
  const a = [{x: 100, y: 100}, {x: 400, y: 100}, {x: 400, y: 400}];
  const b = [{x: 396, y: 404}, {x: 100, y: 404}, {x: 100, y: 106}];
  expect(solidFill([{points: a, width: 6}, {points: b, width: 6}], 8, 5, 12)).not.toBeNull();
});

test('large organic shape: computed quickly, few points to insert', () => {
  const blob = Array.from({length: 1500}, (_, i) => {
    const t = (2 * Math.PI * i) / 1500;
    const r = 450 + 60 * Math.sin(3 * t) + 25 * Math.cos(7 * t);
    return {x: 960 + r * Math.cos(t), y: 1200 + 1.3 * r * Math.sin(t)};
  });
  const t0 = Date.now();
  const fill = solidFill([{points: [...blob, blob[0]], width: 30}], 8, 5)!;
  const ms = Date.now() - t0;
  const points = fill.rings.reduce((s, r) => s + r.length, 0) + 2 * fill.rows.length;
  expect(ms).toBeLessThan(3000);
  expect(fill.rings).toHaveLength(1);
  expect(points).toBeLessThan(2000);
});

test('simplify keeps the corners of a straight-sided line', () => {
  const line = [...Array.from({length: 50}, (_, i) => ({x: i, y: 0})), ...Array.from({length: 50}, (_, i) => ({x: 49, y: i + 1}))];
  expect(simplify(line, 0.5)).toEqual([{x: 0, y: 0}, {x: 49, y: 0}, {x: 49, y: 50}]);
});

test('two strokes joined by the gap: the fill still reaches into the corners', () => {
  // A rectangle in two strokes whose ends miss each other by 8 px at two corners.
  const a = [{x: 100, y: 100}, {x: 400, y: 100}, {x: 400, y: 292}];
  const b = [{x: 400, y: 300}, {x: 100, y: 300}, {x: 100, y: 108}];
  const fill = solidFill([{points: a, width: 6}, {points: b, width: 6}], 8, 5, 16)!;
  // Inner edge of the ink at 103 / 397 / 297; ring centre line 4 px inside it.
  const near = (x: number, y: number) => Math.min(...fill.rings.flat().map(p => Math.hypot(p.x - x, p.y - y)));
  expect(near(107, 107)).toBeLessThan(3); // corner far from the gaps
  expect(near(393, 293)).toBeLessThan(3);
});

const star = (spikes: number, r1: number, r2: number) =>
  Array.from({length: spikes * 2}, (_, i) => {
    const t = (Math.PI * i) / spikes;
    const r = i % 2 ? r2 : r1;
    return {x: 600 + r * Math.cos(t), y: 600 + r * Math.sin(t)};
  });

test('sharp tips too narrow for the main lines get the fine pass', () => {
  const s = star(8, 260, 110);
  const fill = solidFill([{points: [...s, s[0]], width: 2}], 8, 5)!;
  expect(fill.fineRows.length).toBeGreaterThan(8);
  // Fine rows reach further out into the tips than the main rows do.
  const reachOf = (rows: [P, P][]) => Math.max(...rows.flat().map(p => dist(p, {x: 600, y: 600})));
  expect(reachOf(fill.fineRows)).toBeGreaterThan(reachOf(fill.rows) + 10);
  expect(reachOf(fill.fineRows)).toBeGreaterThan(250); // tips end at 260
  expect(fill.paths.some(p => p.width === 3)).toBe(true);
});

test('the main fill of one enclosed part is ONE continuous path, its joins inside the filled area', () => {
  const blob = Array.from({length: 400}, (_, i) => {
    const t = (2 * Math.PI * i) / 400;
    const r = 200 + 50 * Math.sin(3 * t);
    return {x: 600 + r * Math.cos(t), y: 600 + r * Math.sin(t)};
  });
  const fill = solidFill([{points: [...blob, blob[0]], width: 2}], 8, 5)!;
  const main = fill.paths.filter(p => p.width === 8);
  expect(main).toHaveLength(1);
  // Every point of the path is inside the outline, at least half a line from it.
  const inside = (p: P) => {
    const t = Math.atan2(p.y - 600, p.x - 600);
    return dist(p, {x: 600, y: 600}) <= 200 + 50 * Math.sin(3 * t) - 4;
  };
  expect(main[0].points.every(inside)).toBe(true);
});

test('hatching stays clear of a thick outline, square to it, at any angle', () => {
  const blob = Array.from({length: 600}, (_, i) => {
    const t = (2 * Math.PI * i) / 600;
    const r = 300 + 80 * Math.sin(3 * t);
    return {x: 600 + r * Math.cos(t), y: 600 + r * Math.sin(t)};
  });
  const outline = [...blob, blob[0]];
  const inkWidth = 24; // pen 2.0
  const hatchHalf = 2.5;
  const hatch = hatchFill([{points: outline, width: inkWidth}], 45, 20, hatchHalf + 1)!;
  const segs = hatch.segments;
  expect(hatch.paths.length).toBeLessThan(segs.length / 4); // chained into few paths
  expect(segs.length).toBeGreaterThan(20);
  const toOutline = (p: P) => {
    let best = Infinity;
    for (let i = 1; i < outline.length; i++) {
      const a = outline[i - 1];
      const b = outline[i];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy)));
      best = Math.min(best, Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy));
    }
    return best;
  };
  // Each end: the line's round end (half its width) stays off the ink (half of 24 px).
  for (const [a, b] of segs) {
    expect(toOutline(a)).toBeGreaterThanOrEqual(inkWidth / 2 + hatchHalf - 1.5);
    expect(toOutline(b)).toBeGreaterThanOrEqual(inkWidth / 2 + hatchHalf - 1.5);
  }
});
