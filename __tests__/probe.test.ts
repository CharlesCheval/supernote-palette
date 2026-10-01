jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getPageDisplaySize: jest.fn(async () => ({success: true, result: {width: 1920, height: 2560}})),
    getLassoRect: jest.fn(async () => ({success: true, result: {left: 10, top: 20, right: 300, bottom: 400}})),
    generateLassoPreview: jest.fn(async (p: string) => ({success: true, result: {imagePath: p, rect: {left: 1, top: 2, right: 3, bottom: 4}, rotateDegree: 0}})),
    getLassoElementTypeCounts: jest.fn(async () => ({success: true, result: {geometryNum: 1, titleNum: 0}})),
    getLassoElements: jest.fn(async () => ({success: true, result: []})),
    getLassoGeometries: jest.fn(async () => ({success: true, result: []})),
    clearElementCache: jest.fn(),
    // Anything that changes the page or the lasso must never be called.
    setLassoBoxState: jest.fn(),
    lassoElements: jest.fn(),
    modifyPageElements: jest.fn(),
    deleteLassoElements: jest.fn(),
    resizeLassoRect: jest.fn(),
  },
  PluginFileAPI: {getLastElement: jest.fn(async () => ({success: false, error: {message: 'no', code: 1}}))},
  PluginManager: {getPluginDirPath: jest.fn(async () => '/plugin')},
  PointUtils: {},
}));
import {PluginCommAPI} from 'sn-plugin-lib';
import {feedMotion, getSnapshots, probe} from '../src/probe';

test('the probe only reads: rect, preview, types, gestures', async () => {
  feedMotion({action: 0, x: 100, y: 200, toolType: 1, pointerCount: 1, eventTime: 1000});
  feedMotion({action: 2, x: 150, y: 260, toolType: 1, pointerCount: 1, eventTime: 1100});
  feedMotion({action: 1, x: 180, y: 300, toolType: 1, pointerCount: 1, eventTime: 1400});
  await probe();
  const text = getSnapshots()[0].lines.join('\n');
  expect(text).toMatch(/lasso rect 10,20–300,400/);
  expect(text).toMatch(/preview rect 1,2–3,4 · rotate 0/);
  expect(text).toMatch(/types: geometry 1/);
  expect(text).toMatch(/finger 100,200→180,300 400ms/);
  const api = PluginCommAPI as any;
  for (const write of ['setLassoBoxState', 'lassoElements', 'modifyPageElements', 'deleteLassoElements', 'resizeLassoRect']) {
    expect(api[write]).not.toHaveBeenCalled();
  }
});
