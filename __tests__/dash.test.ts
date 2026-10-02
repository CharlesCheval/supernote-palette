const mockCalls: string[] = [];
let mockLasso = true;
jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoRect: jest.fn(async () => ({success: true, result: {left: 0, top: 0, right: 10, bottom: 10}})),
    generateLassoPreview: jest.fn(async () => ({success: true, result: {imagePath: '', rect: {left: 0, top: 0, right: 10, bottom: 10}, rotateDegree: 0}})),
    getLassoElements: jest.fn(async () =>
      mockLasso
        ? {
            success: true,
            result: [
              {
                type: 700,
                uuid: 'g',
                numInPage: 5,
                pageNum: 0,
                thickness: 300,
                geometry: {type: 'GEO_polygon', penWidth: 300, penColor: 0, penType: 10, points: [{x: 0, y: 0}, {x: 400, y: 0}, {x: 400, y: 300}, {x: 0, y: 300}, {x: 0, y: 0}]},
              },
            ],
          }
        : {success: false, error: {message: 'No lasso', code: 904}},
    ),
    getPageDisplaySize: jest.fn(async () => ({success: true, result: {width: 1920, height: 2560}})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 0})),
    clearElementCache: jest.fn(),
    setLassoBoxState: jest.fn(async () => {
      mockCalls.push('let go');
      mockLasso = false;
      return {success: true, result: true};
    }),
    deletePageElements: jest.fn(async (nums: number[]) => {
      mockCalls.push(`delete ${nums.join(',')}`);
      return {success: true, result: true};
    }),
    createElement: jest.fn(async () => ({success: true, result: {}})),
    insertPageElements: jest.fn(async () => {
      mockCalls.push('insert');
      return {success: true, result: true};
    }),
    insertGeometry: jest.fn(async () => ({success: true, result: true})),
  },
  PluginNoteAPI: {saveCurrentNote: jest.fn()},
  PluginManager: {getPluginDirPath: jest.fn(async () => '/plugin'), hasPermission: jest.fn(async () => 1)},
  FileUtils: {},
  PointUtils: {},
}));
import {applyDashes} from '../src/effects';
import {startAction} from '../src/session';

test('dashing a shape: the lasso is let go BEFORE the shape is deleted, then the dashes inserted', async () => {
  startAction();
  const res = await applyDashes('dashed');
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['let go', 'delete 5', 'insert']);
});
