const mockCalls: string[] = [];
jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoRect: jest.fn(),
    generateLassoPreview: jest.fn(),
    getLassoElements: jest.fn(),
    getPageDisplaySize: jest.fn(async () => ({success: true, result: {width: 1920, height: 2560}})),
    clearElementCache: jest.fn(),
    setLassoBoxState: jest.fn(async (s: number) => {
      mockCalls.push(`state ${s}`);
      return {success: true, result: true};
    }),
    lassoElements: jest.fn(),
    modifyPageElements: jest.fn(),
  },
  PluginNoteAPI: {saveCurrentNote: jest.fn()},
  PluginManager: {getPluginDirPath: jest.fn(async () => '/plugin'), hasPermission: jest.fn(async () => 1)},
  PointUtils: {},
}));
import {PluginCommAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {commitMove} from '../src/selection';
import {startAction} from '../src/session';

const api = PluginCommAPI as any;
const note = PluginNoteAPI as any;
const shape = (n: number, at: number, size: number) => ({
  type: 700,
  uuid: `g${n}`,
  numInPage: n,
  pageNum: 0,
  thickness: 300,
  geometry: {type: 'GEO_polygon', penWidth: 300, penColor: 0, penType: 10, points: [{x: at, y: at}, {x: at + size, y: at + size}]},
});
const OLD = {left: 82, top: 82, right: 718, bottom: 718};
const NEW = {left: 992, top: 992, right: 1308, bottom: 1308};
let selection: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  selection = [shape(3, 100, 600), shape(4, 150, 500)];
  api.getLassoRect.mockImplementation(async () => ({success: true, result: OLD}));
  api.generateLassoPreview.mockImplementation(async () => ({success: true, result: {imagePath: '', rect: NEW, rotateDegree: 0}}));
  api.getLassoElements.mockImplementation(async () => ({success: true, result: selection}));
  note.saveCurrentNote.mockImplementation(async () => {
    mockCalls.push('save');
    return {success: true, result: true};
  });
  startAction();
});

test('saves, lets the lasso go, lassoes the preview rect, checks the same selection', async () => {
  api.lassoElements.mockImplementation(async (r: any) => {
    mockCalls.push('lasso');
    expect(r).toEqual(NEW);
    selection = [shape(7, 1000, 300), shape(8, 1025, 250)]; // recreated: new numbers, same kinds
    return {success: true, result: true};
  });
  const res = await commitMove();
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['save', 'state 2', 'lasso']);
  expect(api.modifyPageElements).not.toHaveBeenCalled();
});

test('a different selection (a neighbour caught): let go, nothing else', async () => {
  api.lassoElements.mockImplementation(async () => {
    selection = [shape(7, 1000, 300), shape(8, 1025, 250), shape(9, 1100, 50)];
    return {success: true, result: true};
  });
  const res = await commitMove();
  expect(res.ok).toBe(false);
  expect(mockCalls).toEqual(['save', 'state 2', 'state 2']);
  expect(api.modifyPageElements).not.toHaveBeenCalled();
});

test('the note cannot be saved: the lasso is not touched', async () => {
  note.saveCurrentNote.mockImplementation(async () => ({success: false, error: {message: 'busy', code: 1}}));
  const res = await commitMove();
  expect(res.ok).toBe(false);
  expect(api.setLassoBoxState).not.toHaveBeenCalled();
  expect(api.lassoElements).not.toHaveBeenCalled();
});

test('the save already let the lasso go (measured): no second let-go, straight to the reselect', async () => {
  let gone = false;
  note.saveCurrentNote.mockImplementation(async () => {
    mockCalls.push('save');
    gone = true;
    return {success: true, result: true};
  });
  api.getLassoElements.mockImplementation(async () =>
    gone ? {success: false, error: {message: 'No lasso action has been performed', code: 904}} : {success: true, result: selection},
  );
  api.lassoElements.mockImplementation(async () => {
    mockCalls.push('lasso');
    gone = false;
    selection = [shape(7, 1000, 300), shape(8, 1025, 250)];
    return {success: true, result: true};
  });
  const res = await commitMove();
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['save', 'lasso']);
});
