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
    getCurrentFilePath: jest.fn(async () => ({
      success: true,
      result: '/Note/a.note',
    })),
    clearElementCache: jest.fn(),
    setLassoBoxState: jest.fn(async () => {
      mockCalls.push('let go');
      mockLasso = false;
      return {success: true, result: true};
    }),
    deleteLassoElements: jest.fn(async () => {
      mockCalls.push('lasso delete');
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
    insertGeometry: jest.fn(async () => {
      mockCalls.push('line');
      return {success: true, result: true};
    }),
  },
  PluginNoteAPI: {saveCurrentNote: jest.fn()},
  PluginManager: {getPluginDirPath: jest.fn(async () => '/plugin'), hasPermission: jest.fn(async () => 1)},
  FileUtils: {},
  PointUtils: {},
}));
import {applyDashes} from '../src/effects';
import {startAction} from '../src/session';
import {PluginCommAPI} from 'sn-plugin-lib';

test('a lone selected shape: dashes inserted FIRST, then the original deleted through the lasso', async () => {
  startAction();
  const res = await applyDashes('dashed');
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['insert', 'lasso delete']);
});

test('a solid fill never re-inserts or deletes the outline: only the fill lines are added', async () => {
  const {applyFill, FILLS} = require('../src/effects');
  mockCalls.length = 0;
  mockLasso = true;
  startAction();
  const res = await applyFill(FILLS[1], () => {}, 50);
  expect(res.ok).toBe(true);
  // The whole fill is ONE continuous path (one geometry); the outline is not touched.
  expect(mockCalls).toEqual(['line']);
});

const pdf = () =>
  (PluginCommAPI.getCurrentFilePath as jest.Mock).mockImplementation(async () => ({
    success: true,
    result: '/Document/a.PDF',
  }));

test('in a PDF, a shape still in the lasso made when it was drawn is refused, nothing touched', async () => {
  mockCalls.length = 0;
  mockLasso = true;
  pdf();
  (PluginCommAPI as any).getLassoGeometries = jest.fn(async () => ({success: false, error: {message: 'none', code: 909}}));
  startAction();
  const res = await applyDashes('dashed');
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/select the shape again/);
  expect(mockCalls).toEqual([]);
});

test('in a PDF, a shape lassoed by hand is dashed through the lasso', async () => {
  mockCalls.length = 0;
  mockLasso = true;
  pdf();
  (PluginCommAPI as any).getLassoGeometries = jest.fn(async () => ({success: true, result: [{}]}));
  startAction();
  const res = await applyDashes('dashed');
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['insert', 'lasso delete']);
});
