jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoElements: jest.fn(),
    getPenInfo: jest.fn(async () => ({success: true, result: {width: 300}})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 0})),
    modifyPageElements: jest.fn(),
    recycleElement: jest.fn(),
    clearElementCache: jest.fn(),
  },
  PluginFileAPI: {getElement: jest.fn(), getElementNumList: jest.fn(), getElements: jest.fn()},
  PluginManager: {hasPermission: jest.fn(async () => 1)},
}));
import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {applyStyle} from '../src/selection';
import {newOpening, startAction} from '../src/session';

const api = PluginCommAPI as any;
const file = PluginFileAPI as any;
/** A fresh copy of the selection on every read, as the host returns it. */
let stored = 2400;
const stroke = () => ({type: 0, uuid: 'u', numInPage: 3, pageNum: 0, thickness: stored, stroke: {penColor: 0, penType: 10}});

beforeEach(() => {
  jest.clearAllMocks();
  stored = 2400;
  api.getLassoElements.mockImplementation(async () => ({success: true, result: [stroke(), stroke()]}));
});

test('one attempt: the change is applied once, on fresh copies', async () => {
  api.modifyPageElements.mockImplementation(async (els: any[]) => {
    stored = els[0].thickness;
    return {success: true, result: [3, 4]};
  });
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.modifyPageElements).toHaveBeenCalledTimes(1);
  expect(stored).toBe(300);
  // The native element cache is cleared before every read of the lasso.
  expect(api.clearElementCache.mock.calls.length).toBe(api.getLassoElements.mock.calls.length);
});

test('a refusal is reported at once, never retried', async () => {
  api.modifyPageElements.mockImplementation(async () => ({success: false, error: {message: 'nope', code: 9}}));
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/nope/);
  expect(api.modifyPageElements).toHaveBeenCalledTimes(1);
});

test('panel opened again during an action: the page is not touched', async () => {
  api.modifyPageElements.mockImplementation(async () => ({success: true, result: [3, 4]}));
  startAction();
  api.getCurrentPageNum.mockImplementationOnce(async () => {
    newOpening(); // the user reopens the panel while the action waits on the host
    return {success: true, result: 0};
  });
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(false);
  expect(api.modifyPageElements).not.toHaveBeenCalled();
});

const shape = (n: number, box: number, uuid = `g${n}`, at = 0) => ({
  type: 700,
  uuid,
  numInPage: n,
  pageNum: 0,
  thickness: stored,
  geometry: {type: 'GEO_polygon', penWidth: stored, penColor: 0, penType: 10, points: [{x: at, y: at}, {x: at + box, y: at + box}]},
});

/** The page after the lasso is let go: element number → element. */
let page: Record<number, any> = {};

function lassoMocks(rect: {left: number; top: number; right: number; bottom: number}) {
  api.getPageDisplaySize = jest.fn(async () => ({success: true, result: {width: 1920, height: 2560}}));
  api.getLassoRect = jest.fn(async () => ({success: true, result: rect}));
  api.setLassoBoxState = jest.fn(async () => ({success: true, result: true}));
  api.getCurrentFilePath = jest.fn(async () => ({success: true, result: '/note.note'}));
  file.getElement.mockImplementation(async (_p: string, _pg: number, n: number) =>
    page[n] ? {success: true, result: page[n]} : {success: false},
  );
  file.getElementNumList.mockImplementation(async () => ({success: true, result: Object.keys(page).map(Number)}));
  api.modifyPageElements.mockImplementation(async (els: any[]) => {
    stored = els[0].thickness;
    return {success: true, result: els.map(e => e.numInPage)};
  });
}

test('moved selection: lasso let go, elements found again, lasso made around their new place', async () => {
  let lassoed: any[] = [shape(3, 600), shape(4, 600)];
  api.getLassoElements.mockImplementation(async () => ({success: true, result: lassoed}));
  lassoMocks({left: -18, top: -18, right: 618, bottom: 618}); // the box BEFORE the move
  page = {3: shape(3, 300, 'g3', 1000), 4: shape(4, 300, 'g4', 1000), 7: shape(7, 50, 'n7', 1100)};
  api.lassoElements = jest.fn(async () => {
    lassoed = [page[3], page[4], page[7]]; // the rectangle also catches a neighbour
    return {success: true, result: true};
  });
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.setLassoBoxState).toHaveBeenCalledWith(2);
  const rect = api.lassoElements.mock.calls[0][0];
  expect(rect.left).toBeGreaterThan(900); // the new place, not the old box
  const modified = api.modifyPageElements.mock.calls[0][0].map((e: any) => e.numInPage);
  expect(modified).toEqual([3, 4]); // not the neighbour
});

test('renumbered by the commit: found among the newest elements by uuid', async () => {
  let lassoed: any[] = [shape(3, 600), shape(4, 600)];
  api.getLassoElements.mockImplementation(async () => ({success: true, result: lassoed}));
  lassoMocks({left: -18, top: -18, right: 618, bottom: 618});
  page = {1: shape(1, 80, 'x1'), 3: shape(3, 90, 'x3'), 4: shape(4, 90, 'x4'), 9: shape(9, 300, 'g3', 1000), 10: shape(10, 300, 'g4', 1000)};
  api.lassoElements = jest.fn(async () => {
    lassoed = [page[9], page[10]];
    return {success: true, result: true};
  });
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.modifyPageElements.mock.calls[0][0].map((e: any) => e.numInPage)).toEqual([9, 10]);
});

test('lasso cannot be made again: the page elements are changed directly', async () => {
  let lassoed: any[] = [shape(3, 600), shape(4, 600)];
  api.getLassoElements.mockImplementation(async () =>
    lassoed.length ? {success: true, result: lassoed} : {success: false, error: {message: 'No lasso', code: 904}},
  );
  lassoMocks({left: -18, top: -18, right: 618, bottom: 618});
  page = {3: shape(3, 300, 'g3', 1000), 4: shape(4, 300, 'g4', 1000)};
  api.lassoElements = jest.fn(async () => {
    lassoed = [];
    return {success: true, result: false};
  });
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.modifyPageElements.mock.calls[0][0].map((e: any) => e.numInPage)).toEqual([3, 4]);
  expect(stored).toBe(300);
});

test('pending transform: only when the ink sticks out of the box', () => {
  const {pendingTransform} = require('../src/selection');
  const ink = {left: 100, top: 100, right: 500, bottom: 400};
  expect(pendingTransform({left: 20, top: 30, right: 900, bottom: 800}, ink)).toBe(false); // loose lasso
  expect(pendingTransform({left: 100, top: 100, right: 300, bottom: 250}, ink)).toBe(true); // shrunk
  expect(pendingTransform({left: 600, top: 100, right: 1000, bottom: 400}, ink)).toBe(true); // moved
});
