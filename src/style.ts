/**
 * What the panel can change on the selected strokes and shapes, and how each
 * element field is set. Pure logic, unit-tested.
 */

/** Supernote's four system colours (SDK: Stroke.penColor / Geometry.penColor), light to dark. */
export const PEN_COLORS: ReadonlyArray<{value: number; name: string; swatch: string}> = [
  {value: 0xfe, name: 'White', swatch: '#fefefe'},
  {value: 0xc9, name: 'Light gray', swatch: '#c9c9c9'},
  {value: 0x9d, name: 'Dark gray', swatch: '#9d9d9d'},
  {value: 0x00, name: 'Black', swatch: '#000000'},
];

export type StyleChange = {width: number} | {color: number};

/** The fields of an SDK element this module touches. */
export type Styled = {
  thickness: number;
  stroke?: {penColor: number} | null;
  geometry?: {penWidth: number; penColor: number} | null;
};

/** Applies the change in place: width → thickness (+ penWidth for shapes), colour → penColor. */
export function restyle(e: Styled, change: StyleChange) {
  if ('width' in change) {
    e.thickness = change.width;
    if (e.geometry) {
      e.geometry.penWidth = change.width;
    }
    return;
  }
  if (e.stroke) {
    e.stroke.penColor = change.color;
  }
  if (e.geometry) {
    e.geometry.penColor = change.color;
  }
}

/** The same change on a geometry passed to modifyLassoGeometry. */
export function restyleGeometry<G extends {penWidth: number; penColor: number}>(g: G, change: StyleChange): G {
  return 'width' in change ? {...g, penWidth: change.width} : {...g, penColor: change.color};
}

export const colorName = (value: number) => PEN_COLORS.find(c => c.value === value)?.name ?? `0x${value.toString(16)}`;
