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
import {applyDashes, applyStyleEverywhere} from '../src/effects';
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

test('in a PDF, a shape read outside its lasso (the lasso Snap leaves) is refused, nothing touched', async () => {
  mockCalls.length = 0;
  mockLasso = true;
  pdf(); // lasso rect 0–10, the shape read at 0–400
  startAction();
  const res = await applyDashes('dashed');
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/select the shape again/);
  expect(mockCalls).toEqual([]);
});

test('in a PDF, a shape lassoed by hand: deleted through the lasso FIRST (inserting lets it go), then dashed', async () => {
  mockCalls.length = 0;
  mockLasso = true;
  pdf();
  const r = {left: -5, top: -5, right: 405, bottom: 305};
  (PluginCommAPI.getLassoRect as jest.Mock).mockImplementation(async () => ({success: true, result: r}));
  (PluginCommAPI.generateLassoPreview as jest.Mock).mockImplementation(async () => ({
    success: true,
    result: {imagePath: '', rect: r, rotateDegree: 0},
  }));
  startAction();
  const res = await applyDashes('dashed');
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['lasso delete', 'insert']);
});

test('in a PDF, a restyle deletes through the lasso first, then draws FRESH geometries (never the read elements)', async () => {
  mockCalls.length = 0;
  mockLasso = true;
  pdf();
  const inserted: any[] = [];
  (PluginCommAPI as any).getLassoGeometries = jest.fn(async () => ({success: false, error: {message: 'none', code: 905}}));
  (PluginCommAPI as any).getPenInfo = jest.fn(async () => ({success: true, result: {width: 300}}));
  (PluginCommAPI.createElement as jest.Mock).mockImplementation(async () => ({success: true, result: {uuid: 'new'}}));
  (PluginCommAPI.insertPageElements as jest.Mock).mockImplementation(async (els: any[]) => {
    mockCalls.push('insert');
    inserted.push(...els);
    return {success: true, result: true};
  });
  (PluginCommAPI.insertGeometry as jest.Mock).mockImplementation(async (g: any) => {
    mockCalls.push('line');
    inserted.push({geometry: g, uuid: 'new'});
    return {success: true, result: true};
  });
  startAction();
  const res = await applyStyleEverywhere({width: 500});
  expect(res.ok).toBe(true);
  expect(mockCalls[0]).toBe('lasso delete');
  expect(inserted.length).toBe(1);
  expect(inserted[0].uuid).toBe('new');
  expect(inserted[0].geometry.penWidth).toBe(500);
  expect(inserted[0].geometry.points.length).toBe(5);
});
