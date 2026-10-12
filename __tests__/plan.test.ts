import {isPicked, steps, toggle} from '../src/plan';

test('one choice per row: another option replaces, the same one drops it', () => {
  let p = toggle({}, 'width', 300);
  p = toggle(p, 'width', 1200);
  expect(p.width).toBe(1200);
  p = toggle(p, 'width', 1200);
  expect(p.width).toBeUndefined();
});

test('fills compare by value', () => {
  const p = toggle({}, 'fill', {color: 0xc9});
  expect(isPicked(p, 'fill', {color: 0xc9})).toBe(true);
  expect(isPicked(p, 'fill', {color: 0x9d})).toBe(false);
  expect(isPicked(null, 'fill', {color: 0xc9})).toBe(false);
});

test('applied in a fixed order whatever the picking order: dashes always last', () => {
  let p = toggle({}, 'dash', 'dashed');
  p = toggle(p, 'hatch', {hatch: 45, color: 0});
  p = toggle(p, 'width', 1200);
  p = toggle(p, 'color', 0x9d);
  p = toggle(p, 'fill', {color: 0xc9});
  expect(steps(p)).toEqual(['width', 'color', 'fill', 'hatch', 'dash']);
});
