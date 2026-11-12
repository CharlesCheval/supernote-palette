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
    // Only a page of another size in the same orientation: a rotated display
    // (landscape) with a portrait page size must keep the display size alone,
    // as before.
    const sameOrientation =
      validSize(own) && own.width < own.height === size.width < size.height;
    if (
      validSize(own) &&
      sameOrientation &&
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
 * How a page from another device stores its strokes' EMR points is not known
 * for sure: Snap measured that live strokes follow the screen ("scaled":
 * display conversion, then page scale), but Palette reads strokes saved in
 * the note, and with that conversion its dashes still landed elsewhere on an
 * A6X note on a Manta. So the conversion is chosen per selection, by
 * calibrate(): the one that puts the strokes inside the lasso rect.
 */
export type EmrMode = 'scaled' | 'page' | 'display';
let emrMode: EmrMode = 'display';

/** What the last calibration measured, shown in the panel (test builds). */
export let lastCalibration = '';

function convert(p: P, size: Size, mode: EmrMode): P {
  const display = {width: size.width, height: size.height};
  if (!size.page || mode === 'display') {
    return PointUtils.emrPoint2Android(p, display);
  }
  if (mode === 'page') {
    return PointUtils.emrPoint2Android(p, {
      width: Math.round(size.page.width),
      height: Math.round(size.page.height),
    });
  }
  return screenToPage(PointUtils.emrPoint2Android(p, display), size, size.page);
}

/** An EMR point in page pixels, with the conversion calibrate() chose. */
export function emrToPage(p: P, size: Size): P {
  try {
    return convert(p, size, emrMode);
  } catch {
    return convert(p, size, 'display'); // page size unknown to PointUtils
  }
}

type Box = {left: number; top: number; right: number; bottom: number};

const boxOf = (pts: P[]): Box => ({
  left: Math.min(...pts.map(p => p.x)),
  top: Math.min(...pts.map(p => p.y)),
  right: Math.max(...pts.map(p => p.x)),
  bottom: Math.max(...pts.map(p => p.y)),
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

/**
 * Chooses the EMR conversion for this selection: among those that can run,
 * the one whose stroke points stick out of the lasso rect the least. Only
 * pages from another device need it; on the device's own pages all agree.
 */
export async function calibrate(
  elements: Element[],
  size: Size | null,
): Promise<void> {
  // The conversion of Palette 0.6.2 unless another one clearly fits better.
  emrMode = 'display';
  if (!size?.page) {
    lastCalibration = size ? `page = display ${size.width}×${size.height}` : '';
    return;
  }
  const parts = [
    `display ${size.width}×${size.height} · page ${size.page.width}×${size.page.height}`,
  ];
  try {
    const rect = ok<Box>(await PluginCommAPI.getLassoRect());
    const stroke = elements.find(e => isStroke(e) && e.stroke);
    if (!rect || !stroke?.stroke) {
      lastCalibration = parts
        .concat('no lasso rect or stroke: scaled')
        .join(' · ');
      return;
    }
    const n = await stroke.stroke.points.size();
    const raw = n ? await stroke.stroke.points.getRange(0, n) : [];
    const sample = raw.filter(
      (_, i) => i % Math.max(1, Math.floor(raw.length / 60)) === 0,
    );
    const r0 = Math.round;
    parts.push(
      `lasso ${r0(rect.left)},${r0(rect.top)}–${r0(rect.right)},${r0(
        rect.bottom,
      )}`,
    );
    let best: {mode: EmrMode; out: number} | null = null;
    let displayOut = 0;
    for (const mode of ['scaled', 'page', 'display'] as EmrMode[]) {
      try {
        const b = boxOf(sample.map(p => convert(p, size, mode)));
        const out = overflow(b, rect);
        parts.push(
          `${mode} ${r0(b.left)},${r0(b.top)}–${r0(b.right)},${r0(b.bottom)}`,
        );
        if (mode === 'display') {
          displayOut = out;
        }
        if (!best || out < best.out) {
          best = {mode, out};
        }
      } catch {
        parts.push(`${mode} n/a`);
      }
    }
    // Another conversion only when the display one sticks out of the lasso
    // and the other fits clearly better.
    if (
      best &&
      best.mode !== 'display' &&
      displayOut > 20 &&
      best.out < displayOut / 2
    ) {
      emrMode = best.mode;
    }
    parts.push(`→ ${emrMode}`);
  } catch (e: any) {
    parts.push(`calibration error ${e?.message ?? e}`);
  }
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
