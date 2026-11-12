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

test('EMR to page pixels: display conversion, scaled to a page of another size (as Snap)', () => {
  expect(emrToPage({x: 5670, y: 7680}, {width: 1920, height: 2560})).toEqual({x: 567, y: 768});
  const q = emrToPage({x: 5670, y: 7680}, {width: 1920, height: 2560, page: {width: 1404, height: 1872}});
  expect(q.x).toBeCloseTo(414.6, 1);
  // A page size in the other orientation is ignored.
  expect(emrToPage({x: 5670, y: 7680}, {width: 1920, height: 2560, page: {width: 2560, height: 1920}})).toEqual({
    x: 567,
    y: 768,
  });
});

test('calibration score: how far a box sticks out of the lasso rect', () => {
  const lasso = {left: 100, top: 100, right: 500, bottom: 400};
  expect(overflow({left: 120, top: 110, right: 480, bottom: 390}, lasso)).toBe(0);
  expect(overflow({left: 50, top: 110, right: 560, bottom: 390}, lasso)).toBe(110);
});

const circle: any = {
  type: 700,
  geometry: {type: 'GEO_circle', ellipseCenterPoint: {x: 1051, y: 1195}, ellipseMajorAxisRadius: 200, ellipseMinorAxisRadius: 200, ellipseAngle: 0, penWidth: 300, penColor: 0, penType: 10},
};
const landscape = {width: 2560, height: 3414};

test('landscape Manta note, a circle alone: scaled by 4/3 (measured: dashes at 3/4)', async () => {
  mockRect = {left: 941, top: 1085, right: 1161, bottom: 1305};
  await calibrate([circle], landscape);
  const o = await outlineOf(circle, landscape);
  expect(Math.min(...o!.points.map(p => p.x))).toBeCloseTo((951 * 4) / 3, 0);
});

test('a circle alone on a portrait page: unchanged', async () => {
  const portrait = {width: 1920, height: 2560};
  await calibrate([circle], portrait);
  const o = await outlineOf(circle, portrait);
  expect(Math.min(...o!.points.map(p => p.x))).toBeCloseTo(951, 0);
});

test('landscape Manta note, a stroke: left as converted, shapes scaled by the lasso (measured)', async () => {
  // Measured: the stroke converted with the display size at x 282–769, y 1279–1650,
  // the lasso rect at 206,954–584,1244 (3/4 of it).
  const pts = [{x: 282, y: 1279}, {x: 769, y: 1650}];
  const stroke: any = {
    type: 0,
    stroke: {points: {size: async () => 2, getRange: async () => pts.map(p => ({x: p.x * 10, y: p.y * 10}))}},
  };
  // A small circle inside the lasso, read like the lasso rect: centre (400, 1100), radius 50.
  const small: any = {
    type: 700,
    geometry: {...circle.geometry, ellipseCenterPoint: {x: 400, y: 1100}, ellipseMajorAxisRadius: 100, ellipseMinorAxisRadius: 100},
  };
  mockRect = {left: 206, top: 954, right: 584, bottom: 1244};
  await calibrate([stroke, small], landscape);
  const so = await outlineOf(stroke, landscape);
  expect(so!.points[0]).toEqual({x: 282, y: 1279});
  const co = await outlineOf(small, landscape);
  expect(Math.min(...co!.points.map(p => p.x))).toBeCloseTo((350 * 4) / 3, 0);
  // The same stroke on a portrait page, the lasso where it is: nothing scaled.
  mockRect = {left: 275, top: 1270, right: 776, bottom: 1660};
  const portrait = {width: 1920, height: 2560};
  await calibrate([stroke], portrait);
  expect((await outlineOf(stroke, portrait))!.points[0]).toEqual({x: 282, y: 1279});
});
