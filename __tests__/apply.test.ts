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
