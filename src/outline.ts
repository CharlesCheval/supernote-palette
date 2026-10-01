import {Element, PluginCommAPI, PointUtils} from 'sn-plugin-lib';
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

export type Size = {width: number; height: number};
export type Style = {penType: number; penColor: number; penWidth: number};
export type Outline = {points: P[]; style: Style};

export async function pageSize(): Promise<Size | null> {
  const s = ok<Size>(await PluginCommAPI.getPageDisplaySize());
  return s && s.width > 1 && s.height > 1
    ? {width: Math.round(s.width), height: Math.round(s.height)}
    : null;
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

/** An element's outline (its centre line) in page pixels, or null when it cannot be read. */
export async function outlineOf(
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
    return {points: emr.map(p => PointUtils.emrPoint2Android(p, size)), style};
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
    const conv = (p: P) => PointUtils.emrPoint2Android(p, size);
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
