jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
  PluginCommAPI: {
    getLassoElements: jest.fn(),
    getPenInfo: jest.fn(async () => ({success: true, result: {width: 300}})),
    getCurrentPageNum: jest.fn(async () => ({success: true, result: 0})),
    getCurrentFilePath: jest.fn(async () => ({
      success: true,
      result: '/Note/a.note',
    })),
    modifyPageElements: jest.fn(),
    getLassoRect: jest.fn(async () => ({success: false})),
    deleteLassoElements: jest.fn(async () => ({success: true, result: true})),
    insertPageElements: jest.fn(async () => ({success: true, result: true})),
    recycleElement: jest.fn(),
    clearElementCache: jest.fn(),
  },
  PluginManager: {hasPermission: jest.fn(async () => 1)},
}));
import {PluginCommAPI} from 'sn-plugin-lib';
import {applyStyle} from '../src/selection';
import {newOpening, startAction} from '../src/session';

const api = PluginCommAPI as any;
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

test('the lasso is never let go nor made again', async () => {
  api.setLassoBoxState = jest.fn();
  api.lassoElements = jest.fn();
  api.modifyPageElements.mockImplementation(async () => ({success: true, result: [3, 4]}));
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(true);
  expect(api.setLassoBoxState).not.toHaveBeenCalled();
  expect(api.lassoElements).not.toHaveBeenCalled();
});


test('in a PDF, without a way to replace the selection, nothing is touched', async () => {
  api.getCurrentFilePath.mockImplementation(async () => ({success: true, result: '/Document/a.pdf'}));
  startAction();
  const res = await applyStyle({width: 300});
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/PDF/);
  expect(api.deleteLassoElements).not.toHaveBeenCalled();
  expect(api.insertPageElements).not.toHaveBeenCalled();
  expect(api.modifyPageElements).not.toHaveBeenCalled();
});
