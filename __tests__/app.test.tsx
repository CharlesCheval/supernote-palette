jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_STROKE: 0, TYPE_GEO: 5},
  PluginCommAPI: {
    getLassoElements: jest.fn(async () => ({success: true, result: []})),
    getPenInfo: jest.fn(async () => ({success: true, result: {type: 10, color: 0, width: 600}})),
    recycleElement: jest.fn(),
  },
  PluginManager: {closePluginView: jest.fn()},
  PointUtils: {},
}));
import React from 'react';
import {Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import App from '../App';

test('panel renders sizes, colours, line and fill tools', async () => {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<App />);
  });
  const buttons = tree!.root.findAllByType(Pressable);
  // close + 15 sizes + 4 colours + 4 lines + 4 hatches + 4 gaps + 4 fills + match pen
  expect(buttons.length).toBe(1 + 15 + 4 + 4 + 4 + 4 + 4 + 1);
});
