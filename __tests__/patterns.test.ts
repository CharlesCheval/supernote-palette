import {
  P,
  closedOutline,
  dashPattern,
  dashPolyline,
  ellipsePoints,
  fillPolylines,
  hatchSegments,
} from '../src/patterns';

const len = (pts: P[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
const square: P[] = [
  {x: 0, y: 0},
  {x: 100, y: 0},
  {x: 100, y: 100},
  {x: 0, y: 100},
  {x: 0, y: 0},
];

describe('dashes', () => {
  test('a straight line is cut on / off along its length', () => {
    const dashes = dashPolyline([{x: 0, y: 0}, {x: 100, y: 0}], [10, 5]);
    expect(dashes).toHaveLength(7); // 0-10, 15-25, … 90-100
    expect(dashes[1][0].x).toBeCloseTo(15, 9);
    for (const d of dashes) {
      expect(len(d)).toBeCloseTo(10, 9);
    }
  });
  test('dashes follow corners', () => {
    const dashes = dashPolyline(square, [30, 10]);
    expect(dashes.some(d => d.length > 2)).toBe(true); // a dash bent around a corner
    const on = dashes.reduce((s, d) => s + len(d), 0);
    expect(on).toBeCloseTo(300, 6); // 400 px: 10 × (30 on + 10 off)
  });
  test('centre line alternates long dashes and dots', () => {
    const pattern = dashPattern('dashdot', 6);
    const dashes = dashPolyline([{x: 0, y: 0}, {x: 1000, y: 0}], pattern);
    expect(len(dashes[0])).toBeCloseTo(pattern[0], 9);
    expect(len(dashes[1])).toBeCloseTo(1, 9);
    expect(len(dashes[2])).toBeCloseTo(pattern[0], 9);
  });
  test('patterns grow with the line width', () => {
    expect(dashPattern('dashed', 20)[0]).toBeGreaterThan(dashPattern('dashed', 3)[0]);
  });
});

describe('hatching and fill', () => {
  test('horizontal hatching of a square: evenly spaced full-width lines', () => {
    const segs = hatchSegments(square, 0, 10);
    expect(segs).toHaveLength(10);
    for (const [a, b] of segs) {
      expect(Math.abs(b.x - a.x)).toBeCloseTo(100, 6);
    }
  });
  test('diagonal hatching stays inside', () => {
    for (const [a, b] of hatchSegments(square, 45, 12)) {
      for (const p of [a, b]) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(100 + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeLessThanOrEqual(100 + 1e-6);
      }
    }
  });
  test('concave shape: a line crossing it twice gives two segments', () => {
    const u: P[] = [
      {x: 0, y: 0},
      {x: 30, y: 0},
      {x: 30, y: 70},
      {x: 70, y: 70},
      {x: 70, y: 0},
      {x: 100, y: 0},
      {x: 100, y: 100},
      {x: 0, y: 100},
    ];
    const segs = hatchSegments(u, 0, 10);
    expect(segs.filter(s => s[0].y < 70)).toHaveLength(2 * 7);
  });
  test('fill of a convex shape is a single zigzag', () => {
    const chains = fillPolylines(square, 4);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toHaveLength(2 * 25);
  });
  test('circle fill', () => {
    const chains = fillPolylines(ellipsePoints({x: 200, y: 200}, 80, 80, 0), 5);
    expect(chains).toHaveLength(1);
  });
  test('open strokes cannot be filled', () => {
    expect(closedOutline([{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}])).toBeNull();
    expect(closedOutline([...square.slice(0, 4), {x: 5, y: 10}])).not.toBeNull();
  });
});

test('inset keeps the fill off the outline', () => {
  const segs = hatchSegments(square, 0, 4, 6);
  expect(Math.min(...segs.map(s => s[0].y))).toBeGreaterThanOrEqual(6);
  expect(Math.max(...segs.map(s => s[0].y))).toBeLessThanOrEqual(94);
  for (const [a, b] of segs) {
    expect(Math.min(a.x, b.x)).toBeCloseTo(6, 6);
    expect(Math.max(a.x, b.x)).toBeCloseTo(94, 6);
  }
});
