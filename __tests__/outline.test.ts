jest.mock('sn-plugin-lib', () => ({Element: {TYPE_STROKE: 0, TYPE_GEO: 700}, PluginCommAPI: {}, PointUtils: {}}));
import {inPagePixels} from '../src/outline';

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
