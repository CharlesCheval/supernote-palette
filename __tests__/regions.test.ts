import {P, areaSegments, enclosedArea} from '../src/regions';

const stroke = (pts: P[], width = 3) => ({points: pts, width});
const line = (a: P, b: P, n = 40) =>
  Array.from({length: n + 1}, (_, i) => ({x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n}));

/** Point-in-triangle (barycentric), with a small tolerance. */
function inTriangle(p: P, a: P, b: P, c: P, tol = 4) {
  const area = (p1: P, p2: P, p3: P) => (p2.x - p1.x) * (p3.y - p1.y) - (p3.x - p1.x) * (p2.y - p1.y);
  const s = area(a, b, c);
  const d1 = area(p, b, c) / s;
  const d2 = area(a, p, c) / s;
  const d3 = area(a, b, p) / s;
  const e = tol / Math.sqrt(Math.abs(s));
  return d1 >= -e && d2 >= -e && d3 >= -e;
}

describe('areas closed by several strokes', () => {
  const A = {x: 100, y: 400};
  const B = {x: 400, y: 400};
  const C = {x: 250, y: 100};

  test('triangle drawn in three strokes, ends not quite meeting', () => {
    const area = enclosedArea(
      [stroke(line(A, {x: 390, y: 402})), stroke(line({x: 404, y: 390}, {x: 255, y: 108})), stroke(line({x: 244, y: 106}, {x: 108, y: 392}))],
      16,
    );
    expect(area).not.toBeNull();
    const segs = areaSegments(area!, -45, 14, 2);
    expect(segs.length).toBeGreaterThan(10);
    for (const [p, q] of segs) {
      expect(inTriangle(p, A, B, C)).toBe(true);
      expect(inTriangle(q, A, B, C)).toBe(true);
    }
  });

  test('square whose sides cross at the corners', () => {
    const sides = [
      line({x: 80, y: 100}, {x: 420, y: 100}),
      line({x: 400, y: 80}, {x: 400, y: 420}),
      line({x: 420, y: 400}, {x: 80, y: 400}),
      line({x: 100, y: 420}, {x: 100, y: 80}),
    ].map(p => stroke(p));
    const segs = areaSegments(enclosedArea(sides, 16)!, 0, 20, 2);
    expect(segs.length).toBeGreaterThan(10);
    for (const [p, q] of segs) {
      expect(Math.min(p.x, q.x)).toBeGreaterThan(95);
      expect(Math.max(p.x, q.x)).toBeLessThan(405);
      expect(p.y).toBeGreaterThan(95);
      expect(p.y).toBeLessThan(405);
    }
    // Lines reach close to the sides (grown back by the gap).
    expect(Math.min(...segs.map(([p, q]) => Math.min(p.x, q.x)))).toBeLessThan(115);
  });

  test('two circles, each partly erased, joined into one closed shape', () => {
    // Left circle keeps its left 3/4, right circle its right 3/4: joined, they
    // outline a figure-eight-like closed shape with an opening between them.
    const arc = (cx: number, from: number, to: number) =>
      Array.from({length: 60}, (_, i) => {
        const a = from + ((to - from) * i) / 59;
        return {x: cx + 100 * Math.cos(a), y: 300 + 100 * Math.sin(a)};
      });
    const left = arc(200, Math.PI / 4, (7 * Math.PI) / 4);
    const right = arc(340, (5 * Math.PI) / 4, Math.PI * 2.75);
    const area = enclosedArea([stroke(left), stroke(right)], 16);
    expect(area).not.toBeNull();
    const segs = areaSegments(area!, 0, 14, 2);
    // One continuous region spanning both circles.
    expect(segs.some(([p, q]) => Math.min(p.x, q.x) < 150 && Math.max(p.x, q.x) > 390)).toBe(true);
  });

  test('a triangle with a 60 px gap is not closed', () => {
    const t = [line(A, B), line(B, C), line(C, {x: 145, y: 330})];
    expect(enclosedArea(t.map(p => stroke(p)), 16)).toBeNull();
  });

  test('an open "U" (wide gap) encloses nothing', () => {
    const u = [line({x: 100, y: 100}, {x: 100, y: 400}), line({x: 100, y: 400}, {x: 400, y: 400}), line({x: 400, y: 400}, {x: 400, y: 100})];
    expect(enclosedArea(u.map(p => stroke(p)), 16)).toBeNull();
  });

  test('solid fill rows go edge to edge', () => {
    const sides = [
      line({x: 100, y: 100}, {x: 300, y: 100}),
      line({x: 300, y: 100}, {x: 300, y: 300}),
      line({x: 300, y: 300}, {x: 100, y: 300}),
      line({x: 100, y: 300}, {x: 100, y: 100}),
    ].map(p => stroke(p));
    const segs = areaSegments(enclosedArea(sides, 16)!, 0, 8, 6, true);
    const ys = segs.map(s => s[0].y);
    expect(Math.min(...ys)).toBeLessThan(115);
    expect(Math.max(...ys)).toBeGreaterThan(285);
  });
});
