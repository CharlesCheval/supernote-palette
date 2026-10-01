jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoElements: jest.fn(),
    getPenInfo: jest.fn(async () => ({success: true, result: {width: 300}})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 0})),
    modifyPageElements: jest.fn(),
    recycleElement: jest.fn(),
  },
  PluginManager: {hasPermission: jest.fn(async () => 1)},
}));
import {PluginCommAPI} from 'sn-plugin-lib';
import {applyStyle} from '../src/selection';

const api = PluginCommAPI as any;
/** A fresh copy of the selection on every read, as the host returns it. */
let stored = 2400;
const stroke = () => ({type: 0, uuid: 'u', numInPage: 3, pageNum: 0, thickness: stored, stroke: {penColor: 0, penType: 10}});

beforeEach(() => {
  jest.clearAllMocks();
  stored = 2400;
  api.getLassoElements.mockImplementation(async () => ({success: true, result: [stroke(), stroke()]}));
});

test('right after a resize: success with no element modified → applied again', async () => {
  api.modifyPageElements
    .mockImplementationOnce(async () => ({success: true, result: []}))
    .mockImplementation(async (els: any[]) => {
      stored = els[0].thickness;
      return {success: true, result: [3, 4]};
    });
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.modifyPageElements).toHaveBeenCalledTimes(2);
  expect(stored).toBe(300);
});

test('reported success but not applied on read-back → applied again', async () => {
  let calls = 0;
  api.modifyPageElements.mockImplementation(async (els: any[]) => {
    calls++;
    if (calls > 1) {
      stored = els[0].thickness;
    }
    return {success: true, result: [3, 4]};
  });
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(calls).toBe(2);
  expect(stored).toBe(300);
});

test('a refusal is reported after three attempts', async () => {
  api.modifyPageElements.mockImplementation(async () => ({success: false, error: {message: 'nope', code: 9}}));
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/nope/);
  expect(api.modifyPageElements).toHaveBeenCalledTimes(3);
});

const shape = (n: number, box: number) => ({
  type: 700,
  uuid: `g${n}`,
  numInPage: n,
  pageNum: 0,
  thickness: stored,
  geometry: {type: 'GEO_polygon', penWidth: stored, penColor: 0, penType: 10, points: [{x: 0, y: 0}, {x: box, y: box}]},
});

function lassoMocks(rect: {left: number; top: number; right: number; bottom: number}) {
  api.getPageDisplaySize = jest.fn(async () => ({success: true, result: {width: 1920, height: 2560}}));
  api.getLassoRect = jest.fn(async () => ({success: true, result: rect}));
  api.setLassoBoxState = jest.fn(async () => ({success: true, result: true}));
  api.modifyPageElements.mockImplementation(async (els: any[]) => {
    stored = els[0].thickness;
    return {success: true, result: els.map(e => e.numInPage)};
  });
}

test('a pending lasso resize is committed first: lasso let go and made again, originals only', async () => {
  let lassoed = [3, 4];
  api.getLassoElements.mockImplementation(async () => ({success: true, result: lassoed.map(n => shape(n, 600))}));
  // The box was shrunk to 300 px while the elements still read 600 px.
  lassoMocks({left: 10.4, top: 20.6, right: 300.2, bottom: 300.9});
  api.lassoElements = jest.fn(async () => {
    lassoed = [3, 4, 7]; // the rectangle also catches a neighbour
    return {success: true, result: true};
  });
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.setLassoBoxState).toHaveBeenCalledWith(2);
  expect(api.lassoElements).toHaveBeenCalledWith({left: 10, top: 20, right: 301, bottom: 301});
  const modified = api.modifyPageElements.mock.calls[0][0].map((e: any) => e.numInPage);
  expect(modified).toEqual([3, 4]); // not the neighbour
});

test('no pending transform: the lasso is left alone', async () => {
  api.getLassoElements.mockImplementation(async () => ({success: true, result: [shape(3, 600), shape(4, 600)]}));
  lassoMocks({left: -10, top: -10, right: 615, bottom: 612}); // box around the ink, with margin
  api.lassoElements = jest.fn();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.setLassoBoxState).not.toHaveBeenCalled();
  expect(api.lassoElements).not.toHaveBeenCalled();
});
