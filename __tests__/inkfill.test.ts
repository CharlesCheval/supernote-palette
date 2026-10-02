import {P, simplify, solidFill} from '../src/inkfill';
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
