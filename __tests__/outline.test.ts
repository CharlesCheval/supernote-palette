let mockRect: any = null;
jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {getLassoRect: jest.fn(async () => ({success: !!mockRect, result: mockRect}))},
  PluginFileAPI: {},
  // Stand-in conversion: EMR / 10.
  PointUtils: {emrPoint2Android: (p: {x: number; y: number}) => ({x: p.x / 10, y: p.y / 10})},
}));
import {calibrate, emrToPage, inPagePixels, outlineOf, overflow, screenToPage} from '../src/outline';

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

test('landscape Manta note: a circle read at 3/4 of its place is scaled to the lasso (measured)', async () => {
  // Read back in portrait page pixels: centre (1051, 1195), radius 100 (fields hold twice).
  const circle: any = {
    type: 700,
    geometry: {type: 'GEO_circle', ellipseCenterPoint: {x: 1051, y: 1195}, ellipseMajorAxisRadius: 200, ellipseMinorAxisRadius: 200, ellipseAngle: 0, penWidth: 300, penColor: 0, penType: 10},
  };
  const size = {width: 2560, height: 3414};
  // The lasso around it where it shows: 4/3 of the read place.
  mockRect = {left: ((1051 - 100) * 4) / 3 - 10, top: ((1195 - 100) * 4) / 3 - 10, right: ((1051 + 100) * 4) / 3 + 10, bottom: ((1195 + 100) * 4) / 3 + 10};
  await calibrate([circle], size);
  const o = await outlineOf(circle, size);
  const xs = o!.points.map(p => p.x);
  expect(Math.min(...xs)).toBeCloseTo(((1051 - 100) * 4) / 3, 0);
  // Back to a selection where read and lasso agree: no scaling.
  mockRect = {left: 941, top: 1085, right: 1161, bottom: 1305};
  await calibrate([circle], size);
  const o2 = await outlineOf(circle, size);
  expect(Math.min(...o2!.points.map(p => p.x))).toBeCloseTo(951, 0);
});
