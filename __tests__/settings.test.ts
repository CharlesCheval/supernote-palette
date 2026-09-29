jest.mock('sn-plugin-lib', () => ({FileUtils: {}, PluginManager: {}}));
import {DEFAULTS, normalize} from '../src/settings';

test('hatch density defaults to 50 % and is kept in range', () => {
  expect(DEFAULTS.hatchDensity).toBe(50);
  expect(normalize({}).hatchDensity).toBe(50);
  expect(normalize({hatchDensity: 70}).hatchDensity).toBe(70);
  expect(normalize({hatchDensity: 400}).hatchDensity).toBe(100);
  expect(normalize({hatchDensity: 0}).hatchDensity).toBe(10);
  expect(normalize({hatchDensity: 'x' as any}).hatchDensity).toBe(50);
});
