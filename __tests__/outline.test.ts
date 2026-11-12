jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {},
  PluginFileAPI: {},
  // Stand-in conversion: EMR / 10.
  PointUtils: {emrPoint2Android: (p: {x: number; y: number}) => ({x: p.x / 10, y: p.y / 10})},
}));
import {emrToPage, inPagePixels, overflow, screenToPage} from '../src/outline';

const size = {width: 1920, height: 2560};
const half = (p: {x: number; y: number}) => ({x: p.x / 10, y: p.y / 10});

test('contours already in page pixels are kept as they are', () => {
  const pts = [{x: 100, y: 200}, {x: 1800, y: 2400}];
  expect(inPagePixels(pts, size, half)).toEqual(pts);
});

test('contours in pen (EMR) coordinates, far beyond the page, are converted', () => {
  const pts = [{x: 1000, y: 2000}, {x: 15000, y: 20000}];
  expect(inPagePixels(pts, size, half)).toEqual([{x: 100, y: 200}, {x: 1500, y: 2000}]);
});

test('an A6X page on a Manta: screen pixels scaled to the page (measured with Snap)', () => {
  const manta = {width: 1920, height: 2560};
  const a6x = {width: 1404, height: 1872};
  const q = screenToPage({x: 567, y: 768}, manta, a6x);
  expect(q.x).toBeCloseTo(414.6, 1);
  expect(q.y).toBeCloseTo(561.6, 1);
});

test('EMR to page pixels: without a calibration, exactly as Palette 0.6.2 (display size)', () => {
  expect(emrToPage({x: 5670, y: 7680}, {width: 1920, height: 2560})).toEqual({x: 567, y: 768});
  expect(emrToPage({x: 5670, y: 7680}, {width: 1920, height: 2560, page: {width: 1404, height: 1872}})).toEqual({
    x: 567,
    y: 768,
  });
});

test('calibration score: how far a box sticks out of the lasso rect', () => {
  const lasso = {left: 100, top: 100, right: 500, bottom: 400};
  expect(overflow({left: 120, top: 110, right: 480, bottom: 390}, lasso)).toBe(0);
  expect(overflow({left: 50, top: 110, right: 560, bottom: 390}, lasso)).toBe(110);
});
