const mockCalls: string[] = [];
let mockLasso = true;
jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoRect: jest.fn(async () => ({
      success: true,
      result: {left: 0, top: 0, right: 10, bottom: 10},
    })),
    generateLassoPreview: jest.fn(async () => ({
      success: true,
      result: {
        imagePath: '',
        rect: {left: 0, top: 0, right: 10, bottom: 10},
        rotateDegree: 0,
      },
    })),
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
                geometry: {
                  type: 'GEO_polygon',
                  penWidth: 300,
                  penColor: 0,
                  penType: 10,
                  points: [
                    {x: 0, y: 0},
                    {x: 400, y: 0},
                    {x: 400, y: 300},
                    {x: 0, y: 300},
                    {x: 0, y: 0},
                  ],
                },
              },
            ],
          }
        : {success: false, error: {message: 'No lasso', code: 904}},
    ),
    getPageDisplaySize: jest.fn(async () => ({
      success: true,
      result: {width: 1920, height: 2560},
    })),
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
    getLassoGeometries: jest.fn(async () => ({
      success: true,
      result: [
        {
          type: 'GEO_polygon',
          penWidth: 300,
          penColor: 0,
          penType: 10,
          points: [
            {x: 0, y: 0},
            {x: 400, y: 0},
            {x: 400, y: 300},
            {x: 0, y: 300},
            {x: 0, y: 0},
          ],
        },
      ],
    })),
    modifyLassoGeometry: jest.fn(async (g: any) => {
      mockCalls.push(`lasso restyle ${g.penWidth} ${g.penColor}`);
      return {success: true, result: true};
    }),
    insertGeometry: jest.fn(async () => {
      mockCalls.push('line');
      return {success: true, result: true};
    }),
  },
  PluginNoteAPI: {saveCurrentNote: jest.fn()},
  PluginManager: {
    getPluginDirPath: jest.fn(async () => '/plugin'),
    hasPermission: jest.fn(async () => 1),
  },
  FileUtils: {},
  PointUtils: {},
}));
import {applyPlan} from '../src/effects';
import {startAction} from '../src/session';
import {PluginCommAPI} from 'sn-plugin-lib';

beforeEach(() => {
  mockCalls.length = 0;
  mockLasso = true;
  startAction();
});

test('width + colour + dashes on a lone shape: ONE reading, the dashes carry the new style', async () => {
  const res = await applyPlan({width: 900, color: 0x9d, dash: 'dashed'}, 50);
  expect(res).toEqual({ok: true, message: 'Done.'});
  // No restyle write (the original is replaced), so no lasso lost in between.
  expect(mockCalls).toEqual(['insert', 'lasso delete']);
  const inserted = (PluginCommAPI.insertPageElements as jest.Mock).mock
    .calls[0][0];
  expect(
    inserted.every(
      (e: any) => e.geometry.penWidth === 900 && e.geometry.penColor === 0x9d,
    ),
  ).toBe(true);
});

test('width + colour + fill on a lone shape: one lasso restyle with both, then the fill', async () => {
  const {FILLS} = require('../src/effects');
  const res = await applyPlan({width: 900, color: 0x9d, fill: FILLS[1]}, 50);
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['lasso restyle 900 157', 'line']);
});

test('fill + dashes: dashes through the lasso first (never let go by the plugin), then the fill', async () => {
  const {FILLS} = require('../src/effects');
  const res = await applyPlan({fill: FILLS[1], dash: 'dashed'}, 50);
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['insert', 'lasso delete', 'line']);
});
