const mockCalls: string[] = [];
jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoRect: jest.fn(),
    generateLassoPreview: jest.fn(),
    getLassoElements: jest.fn(),
    getPenInfo: jest.fn(async () => ({success: true, result: {width: 300}})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 0})),
    getCurrentFilePath: jest.fn(async () => ({
      success: true,
      result: '/Note/a.note',
    })),
    getPageDisplaySize: jest.fn(async () => ({success: true, result: {width: 1920, height: 2560}})),
    clearElementCache: jest.fn(),
    setLassoBoxState: jest.fn(),
    lassoElements: jest.fn(),
    modifyPageElements: jest.fn(),
  },
  PluginNoteAPI: {saveCurrentNote: jest.fn()},
  PluginManager: {getPluginDirPath: jest.fn(async () => '/plugin'), hasPermission: jest.fn(async () => 1)},
  PointUtils: {},
}));
import {PluginCommAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {applyStyle, forPageWrite} from '../src/selection';
import {startAction} from '../src/session';

const api = PluginCommAPI as any;
const note = PluginNoteAPI as any;
const shape = (n: number, at: number, size: number, type = 'GEO_polygon') => ({
  type: 700,
  uuid: `g${n}`,
  numInPage: n,
  pageNum: 0,
  thickness: 300,
  geometry: {type, penWidth: 300, penColor: 0, penType: 10, points: [{x: at, y: at}, {x: at + size, y: at + size}]},
});
const OLD = {left: 82, top: 82, right: 718, bottom: 718};
const NEW = {left: 992, top: 992, right: 1308, bottom: 1308};
let selection: any[] = [];
let lassoed = true;
let caught: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  selection = [shape(3, 100, 600), shape(4, 150, 500)];
  lassoed = true;
  api.getLassoRect.mockImplementation(async () => ({success: true, result: lassoed && selection === caught ? NEW : OLD}));
  api.generateLassoPreview.mockImplementation(async () => ({success: true, result: {imagePath: '', rect: NEW, rotateDegree: 0}}));
  api.getLassoElements.mockImplementation(async () =>
    lassoed ? {success: true, result: selection} : {success: false, error: {message: 'No lasso', code: 904}},
  );
  note.saveCurrentNote.mockImplementation(async () => {
    mockCalls.push('save');
    lassoed = false; // measured: saving applies the move and lets the lasso go
    return {success: true, result: true};
  });
  api.lassoElements.mockImplementation(async (r: any) => {
    mockCalls.push('lasso');
    expect(r).toEqual(NEW);
    lassoed = true;
    selection = caught;
    return {success: true, result: true};
  });
  api.setLassoBoxState.mockImplementation(async (st: number) => {
    mockCalls.push(`state ${st}`);
    lassoed = false;
    return {success: true, result: true};
  });
  api.modifyPageElements.mockImplementation(async (els: any[]) => {
    mockCalls.push(`modify ${els.map(e => e.numInPage).join(',')}`);
    return {success: true, result: els.map(e => e.numInPage)};
  });
  startAction();
});

test('moved alone: move applied, same elements (recreated) changed, still selected', async () => {
  caught = [shape(7, 1000, 300), shape(8, 1025, 250)];
  const res = await applyStyle({width: 600});
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['save', 'lasso', 'modify 7,8']);
});

test('moved over other writing: only the moved elements change, then the lasso is let go', async () => {
  caught = [
    shape(20, 995, 310), // neighbour, same kind and points, but not where a moved element must be
    shape(7, 1000, 300),
    shape(21, 1100, 60),
    shape(8, 1025, 250),
  ];
  const res = await applyStyle({width: 600});
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['save', 'lasso', 'modify 7,8', 'state 2']);
});

test('a moved element not found for sure: nothing changed, lasso let go', async () => {
  // One moved element is missing; a neighbour of another kind does not stand in for it.
  const tri = {...shape(21, 1100, 60), geometry: {...shape(21, 1100, 60).geometry, points: [{x: 1100, y: 1100}, {x: 1150, y: 1100}, {x: 1120, y: 1160}]}};
  caught = [shape(7, 1000, 300), tri];
  const res = await applyStyle({width: 600});
  expect(res.ok).toBe(false);
  expect(mockCalls).toEqual(['save', 'lasso', 'state 2']);
});

test('the note cannot be saved: the lasso is not touched, nothing changed', async () => {
  note.saveCurrentNote.mockImplementation(async () => ({success: false, error: {message: 'busy', code: 1}}));
  const res = await applyStyle({width: 600});
  expect(res.ok).toBe(false);
  expect(api.lassoElements).not.toHaveBeenCalled();
  expect(api.modifyPageElements).not.toHaveBeenCalled();
});

test('circles: the doubled radius read from the page is halved before writing', () => {
  const c: any = {geometry: {type: 'GEO_circle', ellipseMajorAxisRadius: 200, ellipseMinorAxisRadius: 200}};
  forPageWrite(c);
  expect(c.geometry.ellipseMajorAxisRadius).toBe(100);
  const poly: any = {geometry: {type: 'GEO_polygon', ellipseMajorAxisRadius: 0}};
  forPageWrite(poly);
  expect(poly.geometry.ellipseMajorAxisRadius).toBe(0);
});

test('a lone shape of its kind is recognised without its position (shapes read from a lasso give none reliable)', async () => {
  selection = [shape(3, 5000, 600)]; // position read wrong, as measured with a circle
  caught = [shape(9, 1000, 300)];
  api.getLassoGeometries = jest.fn(async () => ({success: true, result: [caught[0].geometry]}));
  api.modifyLassoGeometry = jest.fn(async () => {
    mockCalls.push('modify lasso shape');
    return {success: true, result: true};
  });
  const res = await applyStyle({width: 600});
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['save', 'lasso', 'modify lasso shape']);
});

test('a plugin-made lasso not let go by state 2 is let go by a save', async () => {
  caught = [shape(20, 995, 310), shape(7, 1000, 300), shape(21, 1100, 60), shape(8, 1025, 250)];
  api.setLassoBoxState.mockImplementation(async (st: number) => {
    mockCalls.push(`state ${st}`);
    return {success: true, result: true}; // but the lasso stays
  });
  const res = await applyStyle({width: 600});
  expect(res.ok).toBe(true);
  expect(mockCalls).toEqual(['save', 'lasso', 'modify 7,8', 'state 2', 'save']);
});
