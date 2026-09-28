import {PEN_COLORS, colorName, restyle, restyleGeometry} from '../src/style';

test('the four system colours', () => {
  expect(PEN_COLORS.map(c => c.value)).toEqual([0xfe, 0xc9, 0x9d, 0x00]);
  expect(colorName(0x9d)).toBe('Dark gray');
});

test('width: stroke thickness, and penWidth for shapes', () => {
  const stroke = {thickness: 400, stroke: {penColor: 0}};
  const shape = {thickness: 400, geometry: {penWidth: 400, penColor: 0}};
  restyle(stroke, {width: 1200});
  restyle(shape, {width: 1200});
  expect(stroke.thickness).toBe(1200);
  expect(shape).toEqual({thickness: 1200, geometry: {penWidth: 1200, penColor: 0}});
});

test('colour: penColor only, width untouched', () => {
  const stroke = {thickness: 400, stroke: {penColor: 0}};
  const shape = {thickness: 600, geometry: {penWidth: 600, penColor: 0}};
  restyle(stroke, {color: 0xc9});
  restyle(shape, {color: 0xc9});
  expect(stroke).toEqual({thickness: 400, stroke: {penColor: 0xc9}});
  expect(shape).toEqual({thickness: 600, geometry: {penWidth: 600, penColor: 0xc9}});
});

test('lasso geometry copy', () => {
  const g = {penWidth: 600, penColor: 0, type: 'GEO_circle'};
  expect(restyleGeometry(g, {color: 0xfe})).toEqual({penWidth: 600, penColor: 0xfe, type: 'GEO_circle'});
  expect(restyleGeometry(g, {width: 2400}).penWidth).toBe(2400);
  expect(g.penColor).toBe(0);
});
