import {Element, PluginCommAPI, PluginFileAPI, PointUtils} from 'sn-plugin-lib';
import {P, ellipsePoints, range} from './patterns';

/**
 * Reading selected elements as outlines in page pixels, shared by the panel
 * actions. Also the small SDK helpers they all use.
 */

export function ok<T>(res: any): T | null {
  return res?.success ? (res.result as T) : null;
}

export function errorText(res: any): string {
  return res?.error
    ? `${res.error.message ?? 'unknown'} (code ${res.error.code ?? '?'})`
    : 'no result';
}

export const isStroke = (e: Element) => e.type === Element.TYPE_STROKE;
export const isShape = (e: Element) =>
  e.type === Element.TYPE_GEO && !!e.geometry;

/** A host call that never answers must not block the panel. */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * The display size (EMR points are converted with it), and the page's own
 * size when it differs (a page made for another device, scaled to fill the
 * screen: an A6X note on a Manta).
 */
export type Size = {
  width: number;
  height: number;
  page?: {width: number; height: number};
};
export type Style = {penType: number; penColor: number; penWidth: number};
export type Outline = {points: P[]; style: Style};

const validSize = (s: any): s is {width: number; height: number} =>
  !!s && s.width > 1 && s.height > 1;

export async function pageSize(): Promise<Size | null> {
  const s = ok<Size>(await PluginCommAPI.getPageDisplaySize());
  if (!validSize(s)) {
    return null;
  }
  const size: Size = {width: Math.round(s.width), height: Math.round(s.height)};
  try {
    const path = ok<string>(await PluginCommAPI.getCurrentFilePath());
    const page = ok<number>(await PluginCommAPI.getCurrentPageNum());
    const own =
      path && page != null
        ? ok<Size>(await PluginFileAPI.getPageSize(path, page))
        : null;
    // Any page size that differs, in either orientation: a page from another
    // device, or a portrait page under a display reported in landscape.
    // calibrate() decides whether it is used.
    if (
      validSize(own) &&
      (own.width !== size.width || own.height !== size.height)
    ) {
      size.page = {width: own.width, height: own.height};
    }
  } catch {
    // no page size: the display size is the page's (as before)
  }
  return size;
}

/**
 * Coordinates, as measured on a Manta (its own notes in portrait and in
 * landscape, an A6X note):
 * - new elements are written in the page size the host reports
 *   (PluginFileAPI.getPageSize; 2560×3414 for a Manta note in landscape);
 * - stroke EMR points follow the screen: converted with the display size,
 *   then scaled to that page size when it differs in the same orientation
 *   (an A6X page, as in Snap);
 * - shapes and the lasso rect are read in the note's own page pixels, which
 *   differ in landscape: a circle and the lasso rect came back at 3/4 of the
 *   strokes' and of where things are written. Shapes are scaled by
 *   shapeScale, set by calibrate().
 */
let shapeScale = 1;

/** What the last calibration measured, shown in the panel (test builds). */
export let lastCalibration = '';

/** An EMR point in the pixels new elements are written in. */
export function emrToPage(p: P, size: Size): P {
  const q = PointUtils.emrPoint2Android(p, {
    width: size.width,
    height: size.height,
  });
  const page = size.page;
  if (!page || page.width < page.height !== size.width < size.height) {
    return q;
  }
  return screenToPage(q, size, page);
}

type Box = {left: number; top: number; right: number; bottom: number};

const boxOf = (pts: P[]): Box => ({
  left: Math.min(...pts.map(p => p.x)),
  top: Math.min(...pts.map(p => p.y)),
  right: Math.max(...pts.map(p => p.x)),
  bottom: Math.max(...pts.map(p => p.y)),
});

const scaleBox = (b: Box, k: number): Box => ({
  left: b.left * k,
  top: b.top * k,
  right: b.right * k,
  bottom: b.bottom * k,
});

/** How far a box sticks out of another (0 when inside). */
export function overflow(b: Box, r: Box): number {
  return (
    Math.max(0, r.left - b.left) +
    Math.max(0, b.right - r.right) +
    Math.max(0, r.top - b.top) +
    Math.max(0, b.bottom - r.bottom)
  );
}

/** How far apart two boxes' edges are. */
export function edgeGap(a: Box, b: Box): number {
  return (
    Math.abs(a.left - b.left) +
    Math.abs(a.right - b.right) +
    Math.abs(a.top - b.top) +
    Math.abs(a.bottom - b.bottom)
  );
}

/** Ratios between the page sizes in use (portrait and landscape, Manta and A5X/A6X). */
const SCALES = [1, 4 / 3, 3 / 4, 1920 / 1404, 1404 / 1920];

/** Page sizes the host reports in landscape (a portrait page widened to the screen). */
const LANDSCAPE_PAGES = [
  {width: 2560, height: 3414},
  {width: 1872, height: 2496},
];

/**
 * Sets shapeScale for this selection. With strokes in it: the scale that
 * makes the lasso rect (read like shapes) frame the strokes and the scaled
 * shapes best, 1 unless another fits clearly better. Without strokes there is
 * nothing to measure against: 4/3 when the reported page is a landscape one
 * (measured), else 1.
 */
export async function calibrate(
  elements: Element[],
  size: Size | null,
): Promise<void> {
  shapeScale = 1;
  if (!size) {
    lastCalibration = '';
    return;
  }
  const written = size.page ?? size;
  const parts = [
    `display ${size.width}×${size.height} · page ${
      size.page ? `${size.page.width}×${size.page.height}` : 'same'
    }`,
  ];
  const r0 = Math.round;
  const fmt = (b: Box) =>
    `${r0(b.left)},${r0(b.top)}–${r0(b.right)},${r0(b.bottom)}`;
  try {
    const strokePts: P[] = [];
    const shapePts: P[] = [];
    for (const e of elements.slice(0, 12)) {
      const o = await rawOutlineOf(e, size);
      if (o) {
        (isStroke(e) ? strokePts : shapePts).push(...o.points);
      }
    }
    const landscape = LANDSCAPE_PAGES.some(
      l => l.width === written.width && l.height === written.height,
    );
    const rect = ok<Box>(await PluginCommAPI.getLassoRect());
    if (rect && strokePts.length) {
      parts.push(`lasso ${fmt(rect)} · strokes ${fmt(boxOf(strokePts))}`);
      const gap = (k: number) =>
        edgeGap(
          boxOf([
            ...strokePts,
            ...shapePts.map(p => ({x: p.x * k, y: p.y * k})),
          ]),
          scaleBox(rect, k),
        );
      const base = gap(1);
      let best = {k: 1, gap: base};
      for (const k of SCALES) {
        const g = gap(k);
        if (g < best.gap) {
          best = {k, gap: g};
        }
      }
      if (best.k !== 1 && base > 40 && best.gap < base / 2) {
        shapeScale = best.k;
      }
    } else if (landscape) {
      shapeScale = 4 / 3;
      parts.push('no stroke: landscape page');
    } else {
      parts.push(rect ? 'no stroke' : 'no lasso rect');
    }
  } catch (e: any) {
    parts.push(`calibration error ${e?.message ?? e}`);
  }
  parts.push(`shapes ×${shapeScale === 1 ? '1' : shapeScale.toFixed(3)}`);
  lastCalibration = parts.join(' · ');
}

/** Screen pixels to page pixels (a page scaled to fill the screen). */
export function screenToPage(
  q: P,
  display: {width: number; height: number},
  page: {width: number; height: number},
): P {
  return {
    x: (q.x * page.width) / display.width,
    y: (q.y * page.height) / display.height,
  };
}

export function styleOf(e: Element): Style {
  if (isShape(e)) {
    const g = e.geometry!;
    return {
      penType: g.penType,
      penColor: g.penColor,
      penWidth: g.penWidth || e.thickness,
    };
  }
  return {
    penType: e.stroke?.penType ?? 10,
    penColor: e.stroke?.penColor ?? 0,
    penWidth: e.thickness || 300,
  };
}

/** A point or a length read from a shape, in the pixels new elements are written in. */
export const scaled = (p: P): P =>
  shapeScale === 1 ? p : {x: p.x * shapeScale, y: p.y * shapeScale};
export const scaledLength = (l: number) => l * shapeScale;

/** An element's outline (its centre line) in the pixels new elements are written in. */
export async function outlineOf(
  e: Element,
  size: Size | null,
): Promise<Outline | null> {
  const o = await rawOutlineOf(e, size);
  return o && isShape(e) && shapeScale !== 1
    ? {...o, points: o.points.map(scaled)}
    : o;
}

async function rawOutlineOf(
  e: Element,
  size: Size | null,
): Promise<Outline | null> {
  const style = styleOf(e);
  if (isShape(e)) {
    const g = e.geometry!;
    if (
      (g.type === 'GEO_circle' || g.type === 'GEO_ellipse') &&
      g.ellipseCenterPoint
    ) {
      // Read back from the page, the "radius" fields hold twice the drawn radius
      // (measured on a Manta: hatching came out twice too wide), unlike insertGeometry.
      const pts = ellipsePoints(
        g.ellipseCenterPoint,
        g.ellipseMajorAxisRadius / 2,
        g.ellipseMinorAxisRadius / 2,
        g.ellipseAngle,
      );
      return {points: pts, style};
    }
    return g.points?.length >= 2
      ? {points: g.points.map(p => ({x: p.x, y: p.y})), style}
      : null;
  }
  if (isStroke(e) && e.stroke && size) {
    const n = await e.stroke.points.size();
    if (n < 2) {
      return null;
    }
    const emr = await e.stroke.points.getRange(0, n);
    return {points: emr.map(p => emrToPage(p, size)), style};
  }
  return null;
}

/**
 * Contour points are stored either in page pixels or in raw pen (EMR)
 * coordinates; EMR values run far beyond the page size, which tells them apart.
 */
export function inPagePixels(
  points: P[],
  size: Size,
  emrToPx: (p: P) => P,
): P[] {
  const xs = range(points.map(p => p.x));
  const ys = range(points.map(p => p.y));
  const emr = xs.max > 1.3 * size.width || ys.max > 1.3 * size.height;
  return emr ? points.map(emrToPx) : points;
}

/**
 * The drawn contour of an element: the outline of its ink as displayed, eraser
 * cuts included. Used when the centre line cannot be read or no longer matches
 * what is shown (after the eraser).
 */
export async function contourOf(e: Element, size: Size | null): Promise<P[][]> {
  try {
    const c = e.contoursSrc;
    const n = c ? await c.size() : 0;
    if (!size || n < 1) {
      return [];
    }
    const loops = (await c.getRange(0, n)).filter(
      l => Array.isArray(l) && l.length > 1,
    );
    const all = loops.flat();
    if (!all.length) {
      return [];
    }
    const conv = (p: P) => emrToPage(p, size);
    const px = inPagePixels(all, size, conv);
    // Split the converted points back into their loops.
    const out: P[][] = [];
    let k = 0;
    for (const l of loops) {
      out.push(px.slice(k, k + l.length));
      k += l.length;
    }
    return out;
  } catch {
    return [];
  }
}

/** One line telling what an element holds, for diagnostics. */
export async function describeElement(e: Element): Promise<string> {
  const size = async (a: any) => {
    try {
      return a ? await a.size() : 0;
    } catch {
      return '?';
    }
  };
  const parts = [`type ${e.type}`];
  if (e.geometry) {
    const g = e.geometry;
    parts.push(
      `${g.type}`,
      `pts ${g.points?.length ?? 0}`,
      `centre ${g.ellipseCenterPoint ? 'yes' : 'no'}`,
    );
  }
  if (e.stroke) {
    parts.push(
      `pts ${await size(e.stroke.points)}`,
      `erasers ${await size(e.stroke.eraseLineTrailNums)}`,
    );
  }
  parts.push(`contours ${await size(e.contoursSrc)}`, `status ${e.status}`);
  return parts.join(' ');
}
