jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 5},
  PluginCommAPI: {
    getLassoElements: jest.fn(async () => ({success: true, result: []})),
    getPenInfo: jest.fn(async () => ({success: true, result: {type: 10, color: 0, width: 600}})),
    recycleElement: jest.fn(),
  },
  PluginManager: {closePluginView: jest.fn(), getPluginDirPath: jest.fn(async () => null)},
  FileUtils: {},
  PointUtils: {},
}));
import React from 'react';
import {Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import App from '../App';

test('panel renders sizes, colours, line and fill tools', async () => {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<App />);
  });
  const buttons = tree!.root.findAllByType(Pressable);
  // close + 15 sizes + pen + 4 colours + 4 lines + density − + + 4 hatches + 4 fills
  expect(buttons.length).toBe(1 + 15 + 1 + 4 + 4 + 2 + 4 + 4);
});

test('hatch density: 50 % by default, 10 % steps, capped at 100 %', async () => {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<App />);
  });
  const label = () => tree!.root.findAll(n => n.props.children?.[1] === '%')[0]?.props.children[0];
  expect(label()).toBe(50);
  const plus = tree!.root.findAllByType(Pressable).find(p => p.findAllByType(Text).some(t => t.props.children === '+'))!;
  for (let i = 0; i < 8; i++) {
    act(() => plus.props.onPress());
  }
  expect(label()).toBe(100);
});

test('a failing action shows its message in a bubble, and the panel is usable again', async () => {
  const {PluginCommAPI} = require('sn-plugin-lib');
  PluginCommAPI.getLassoElements.mockImplementation(async () => ({success: false, error: {message: 'no lasso', code: 1}}));
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<App />);
  });
  const fills = tree!.root.findAllByType(Pressable).slice(-4);
  await act(async () => {
    await fills[0].props.onPress();
  });
  const texts = tree!.root.findAllByType(Text).map(t => String(t.props.children));
  expect(texts.some(t => t.includes('No lasso selection'))).toBe(true);
  // Not stuck: the same button runs again.
  await act(async () => {
    await fills[0].props.onPress();
  });
  expect(PluginCommAPI.getLassoElements.mock.calls.length).toBeGreaterThanOrEqual(3);
});
