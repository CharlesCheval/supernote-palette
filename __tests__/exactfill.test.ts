import {contourWidth, convexClosed, exactFill} from '../src/exactfill';

const rect = (l: number, t: number, r: number, b: number) => [
  {x: l, y: t},
  {x: r, y: t},
  {x: r, y: b},
  {x: l, y: b},
  {x: l, y: t},
];

test("rectangle: the ring's outer edge lies exactly on the outline's inner edge", () => {
  for (const W of [3, 8, 20]) {
    for (const pts of [
      rect(100, 100, 700, 400),
      [...rect(100, 100, 700, 400)].reverse(),
    ]) {
      const poly = convexClosed(pts)!;
      const path = exactFill({kind: 'polygon', points: poly}, W, 8, 5)!;
      const xs = path.map(p => p.x);
      const ys = path.map(p => p.y);
      // Line width 8: its outer edge is 4 px beyond its centre line.
      expect(Math.min(...xs) - 4).toBeCloseTo(100 + W / 2, 6);
      expect(Math.max(...xs) + 4).toBeCloseTo(700 - W / 2, 6);
      expect(Math.min(...ys) - 4).toBeCloseTo(100 + W / 2, 6);
      expect(Math.max(...ys) + 4).toBeCloseTo(400 - W / 2, 6);
    }
  }
});

test('rows at most `spacing` apart, all inside the ring', () => {
  const path = exactFill(
    {kind: 'polygon', points: convexClosed(rect(0, 0, 300, 200))!},
    10,
    8,
    5,
  )!;
  const rowYs = [...new Set(path.map(p => p.y))].sort((a, b) => a - b);
  for (let i = 1; i < rowYs.length; i++) {
    expect(rowYs[i] - rowYs[i - 1]).toBeLessThanOrEqual(5 + 1e-9);
  }
  for (const p of path) {
    expect(p.x).toBeGreaterThanOrEqual(9 - 1e-9);
    expect(p.x).toBeLessThanOrEqual(291 + 1e-9);
  }
});

test('circle: the ring hugs the outline within a tenth of a pixel', () => {
  for (const [R, W] of [
    [60, 3],
    [200, 20],
    [800, 8],
  ]) {
    const path = exactFill(
      {kind: 'ellipse', c: {x: 1000, y: 1000}, rx: R, ry: R, angle: 0},
      W,
      8,
      5,
    )!;
    const radii = path.map(p => Math.hypot(p.x - 1000, p.y - 1000));
    const ringOuter = Math.max(...radii) + 4;
    expect(ringOuter).toBeCloseTo(R - W / 2, 6);
    // Chords sag at most 0.1 px inward.
    const ring = path.slice(-20);
    for (let i = 1; i < ring.length; i++) {
      const m = {
        x: (ring[i].x + ring[i - 1].x) / 2,
        y: (ring[i].y + ring[i - 1].y) / 2,
      };
      expect(R - W / 2 - 4 - Math.hypot(m.x - 1000, m.y - 1000)).toBeLessThan(
        0.1,
      );
    }
  }
});

test('not a perfect shape: open, or concave', () => {
  expect(
    convexClosed([
      {x: 0, y: 0},
      {x: 100, y: 0},
      {x: 100, y: 100},
      {x: 0, y: 100},
    ]),
  ).toBeNull();
  expect(
    convexClosed([
      {x: 0, y: 0},
      {x: 100, y: 0},
      {x: 50, y: 20},
      {x: 100, y: 100},
      {x: 0, y: 100},
      {x: 0, y: 0},
    ]),
  ).toBeNull();
});

test('a shape too small for its outline gets no exact fill', () => {
  expect(
    exactFill(
      {kind: 'polygon', points: convexClosed(rect(0, 0, 20, 20))!},
      20,
      8,
      5,
    ),
  ).toBeNull();
  expect(
    exactFill(
      {kind: 'ellipse', c: {x: 0, y: 0}, rx: 10, ry: 10, angle: 0},
      20,
      8,
      5,
    ),
  ).toBeNull();
});

test('contour width: a band 12 px wide around its centre line reads as 12 px', () => {
  const centre = Array.from({length: 101}, (_, i) => ({x: i * 5, y: 100}));
  const loop = [
    ...centre.map(p => ({x: p.x, y: p.y - 6})),
    ...[...centre].reverse().map(p => ({x: p.x, y: p.y + 6})),
  ];
  expect(contourWidth([loop], centre)).toBeCloseTo(12, 6);
  expect(contourWidth([], centre)).toBe(0);
});
