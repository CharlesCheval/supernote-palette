import {Element, PluginCommAPI, PointUtils} from 'sn-plugin-lib';
import {
  DashStyle,
  P,
  closedOutline,
  dashFlags,
  dashPattern,
  dashPolyline,
  ellipsePoints,
  fillPolylines,
  chainRows,
  hatchSegments,
  meanSpacing,
} from './patterns';
import {areaSegments, enclosedArea} from './regions';
import {
  ensureWriteAccess,
  errorText,
  isShape,
  isStroke,
  lassoElements,
  ok,
  release,
} from './selection';
import {getSettings} from './settings';

/**
 * Line patterns and fills for the lasso selection. Supernote has no dashed or
 * filled style, so the result is made of plain geometries (polylines):
 * - dashes: a stroke stays ONE element, its gaps hidden through the per-point
 *   draw flags (flagDraw, as a partial eraser leaves them); a shape has no such
 *   flags, so it is REPLACED by one geometry per dash;
 * - hatching and fills are ADDED inside each closed stroke / shape, which stays.
 */

/** Hatching at ±45° in a colour, or a solid fill in a colour. */
export type FillStyle = {hatch: -45 | 45; color: number} | {color: number};

/** "/" and "\", in black then dark gray: one row of four. */
export const HATCHES: FillStyle[] = [
  {hatch: -45, color: 0x00},
  {hatch: 45, color: 0x00},
  {hatch: -45, color: 0x9d},
  {hatch: 45, color: 0x9d},
];

/** Solid fills in the four system colours, light to dark. */
export const FILLS: FillStyle[] = [
  {color: 0xfe},
  {color: 0xc9},
  {color: 0x9d},
  {color: 0x00},
];

/** Called once the selection is read: the panel can close while the page is edited. */
type OnReady = () => void;

type Result = {ok: boolean; message: string};
type Style = {penType: number; penColor: number; penWidth: number};

/** About 100 width units per pixel of line (measured: 0.5 pen ≈ 600 ≈ 6 px). */
const px = (width: number) => width / 100;

type Size = {width: number; height: number};

async function pageSize(): Promise<Size | null> {
  const s = ok<Size>(await PluginCommAPI.getPageDisplaySize());
  return s && s.width > 1 && s.height > 1
    ? {width: Math.round(s.width), height: Math.round(s.height)}
    : null;
}

/** An element's outline in page pixels, and the style it is drawn with. */
async function outlineOf(
  e: Element,
  size: Size | null,
): Promise<{points: P[]; style: Style} | null> {
  if (isShape(e)) {
    const g = e.geometry!;
    const style = {
      penType: g.penType,
      penColor: g.penColor,
      penWidth: g.penWidth || e.thickness,
    };
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
    const style = {
      penType: e.stroke.penType,
      penColor: e.stroke.penColor,
      penWidth: e.thickness,
    };
    return {points: emr.map(p => PointUtils.emrPoint2Android(p, size)), style};
  }
  return null;
}

function geometry(points: P[], style: Style) {
  return {
    showLassoAfterInsert: false,
    penType: style.penType,
    penColor: style.penColor,
    penWidth: Math.max(100, Math.round(style.penWidth)),
    type: 'GEO_polygon',
    points: points.map(p => ({x: Math.round(p.x), y: Math.round(p.y)})),
    ellipseCenterPoint: null,
    ellipseMajorAxisRadius: 0,
    ellipseMinorAxisRadius: 0,
    ellipseAngle: 0,
  };
}

/** One insertGeometry call per line: slow (each call redraws), but proven. */
async function insertOneByOne(geometries: object[]): Promise<number> {
  let done = 0;
  for (const g of geometries) {
    if (!ok<boolean>(await PluginCommAPI.insertGeometry(g as any))) {
      break;
    }
    done++;
  }
  return done;
}

/**
 * All lines in ONE insertPageElements call: the geometry elements are created
 * in parallel (createElement does not touch the page), then inserted together.
 * Falls back to one insertGeometry per line if the batch is refused.
 */
async function insertAll(geometries: object[]): Promise<number> {
  const page = ok<number>(await PluginCommAPI.getCurrentPageNum());
  if (page != null && geometries.length > 1) {
    try {
      const created = await Promise.all(
        geometries.map(() => PluginCommAPI.createElement(Element.TYPE_GEO)),
      );
      const elements = created.map(r => ok<Element>(r));
      if (elements.every(e => e)) {
        elements.forEach((e, i) => {
          const g = geometries[i] as any;
          e!.geometry = g;
          e!.thickness = g.penWidth;
          e!.pageNum = page;
        });
        // Success is judged on the call itself: its result type is not documented.
        const res: any = await PluginCommAPI.insertPageElements(
          elements as Element[],
          page,
        );
        if (res?.success && res.result !== false) {
          return geometries.length;
        }
      }
    } catch {
      // fall back below
    }
  }
  return insertOneByOne(geometries);
}

async function selection(): Promise<{
  all: Element[];
  targets: Element[];
  error?: string;
}> {
  const {elements, error} = await lassoElements();
  return {
    all: elements,
    targets: elements.filter(e => isStroke(e) || isShape(e)),
    error,
  };
}

/**
 * Stroke route: hides the gaps through the stroke's own draw flags, then saves it
 * with modifyPageElements (clears the undo history). The stroke stays one element.
 */
async function dashStrokes(
  strokes: Element[],
  dash: DashStyle,
  size: Size,
): Promise<{done: number; why?: string}> {
  for (const e of strokes) {
    const o = await outlineOf(e, size);
    const flags = e.stroke?.flagDraw;
    const n = o?.points.length ?? 0;
    if (!o || !flags || (await flags.size()) !== n) {
      return {done: 0, why: `stroke #${e.numInPage}: draw flags unavailable`};
    }
    const values = dashFlags(
      o.points,
      dashPattern(dash, px(o.style.penWidth)),
      2 * meanSpacing(o.points),
    );
    if (!(await flags.setRange(0, n - 1, values))) {
      return {
        done: 0,
        why: `stroke #${e.numInPage}: could not set the draw flags`,
      };
    }
  }
  const page =
    ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? strokes[0].pageNum;
  const res: any = await PluginCommAPI.modifyPageElements(strokes, page);
  return ok<number[]>(res)
    ? {done: strokes.length}
    : {done: 0, why: errorText(res)};
}

/** Shape route: deletes each shape by number, then draws one geometry per dash. */
async function dashShapes(
  shapes: Element[],
  dash: DashStyle,
  size: Size | null,
): Promise<{done: number; why?: string}> {
  const pieces: object[] = [];
  for (const e of shapes) {
    const o = await outlineOf(e, size);
    if (o) {
      pieces.push(
        ...dashPolyline(o.points, dashPattern(dash, px(o.style.penWidth))).map(
          d => geometry(d, o.style),
        ),
      );
    }
  }
  if (!pieces.length) {
    return {done: 0, why: 'could not read the shapes'};
  }
  const page =
    ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? shapes[0].pageNum;
  const deleted: any = await PluginCommAPI.deletePageElements(
    shapes.map(e => e.numInPage),
    page,
  );
  if (!ok<boolean>(deleted)) {
    return {done: 0, why: errorText(deleted)};
  }
  const done = await insertAll(pieces);
  if (done < pieces.length) {
    // Put the shapes back rather than leave them half dashed.
    await PluginCommAPI.insertPageElements(shapes, page);
    return {
      done: 0,
      why: `only ${done} of ${pieces.length} dashes could be drawn; shapes restored`,
    };
  }
  return {done: shapes.length};
}

/** Makes every selected stroke and shape dashed. */
export async function applyDashes(
  dash: DashStyle,
  onReady: OnReady = () => {},
): Promise<Result> {
  const {all, targets, error} = await selection();
  if (error || !targets.length) {
    release(all);
    return {
      ok: false,
      message: error ?? 'The selection has no strokes or shapes.',
    };
  }
  if (!(await ensureWriteAccess())) {
    release(all);
    return {
      ok: false,
      message:
        'File access denied: allow it ("Always allow") to change the selection.',
    };
  }
  onReady();
  const size = await pageSize();
  const strokes = targets.filter(isStroke);
  const shapes = targets.filter(isShape);
  const problems: string[] = [];
  if (strokes.length) {
    const r = size
      ? await dashStrokes(strokes, dash, size)
      : {done: 0, why: 'unknown page size'};
    if (r.why) {
      problems.push(`strokes: ${r.why}`);
    }
  }
  if (shapes.length) {
    const r = await dashShapes(shapes, dash, size);
    if (r.why) {
      problems.push(`shapes: ${r.why}`);
    }
  }
  // Modified and re-inserted elements stay referenced by the host: only the others are recycled.
  release(all.filter(e => !targets.includes(e)));
  return problems.length
    ? {ok: false, message: `Not dashed — ${problems.join(' · ')}`}
    : {ok: true, message: 'Dashed.'};
}

/** Hatching / fill spacing and line width (px) for each fill style. */
function fillPlan(fill: FillStyle, outlineWidth: number, density: number) {
  if (!('hatch' in fill)) {
    const width = 1200; // ≈ 12 px lines, 8 px apart: they merge into a solid area
    return {width, spacing: 8, inset: px(width) / 2 + px(outlineWidth) / 2};
  }
  const width = Math.min(outlineWidth, 500);
  return {
    width,
    spacing: (100 / density) * Math.max(14, 3 * px(width)),
    inset: px(outlineWidth) / 2,
  };
}

/** Hatches or fills the inside of every selected closed stroke or shape. */
export async function applyFill(
  fill: FillStyle,
  onReady: OnReady = () => {},
  density = getSettings().hatchDensity,
): Promise<Result> {
  const {all, targets, error} = await selection();
  if (error || !targets.length) {
    release(all);
    return {
      ok: false,
      message: error ?? 'The selection has no strokes or shapes.',
    };
  }
  onReady();
  const size = await pageSize();
  const lines: object[] = [];
  // Strokes that are not closed on their own may still close an area together.
  const openOutlines: {points: P[]; style: Style}[] = [];
  for (const e of targets) {
    const o = await outlineOf(e, size);
    const polygon = o && closedOutline(o.points);
    if (o && !polygon) {
      openOutlines.push(o);
    }
    if (!o || !polygon) {
      continue;
    }
    const plan = fillPlan(fill, o.style.penWidth, density);
    const style = {
      ...o.style,
      penWidth: plan.width,
      penColor: fill.color,
    };
    if (!('hatch' in fill)) {
      lines.push(
        ...fillPolylines(polygon, plan.spacing, plan.inset).map(c =>
          geometry(c, style),
        ),
      );
    } else {
      lines.push(
        ...hatchSegments(polygon, fill.hatch, plan.spacing, plan.inset).map(s =>
          geometry(s, style),
        ),
      );
    }
  }
  if (openOutlines.length) {
    lines.push(...fillAcross(openOutlines, fill, density));
  }
  release(all);
  if (!lines.length) {
    return {
      ok: false,
      message:
        'Nothing closed to fill: close the outline (ends may be drawn with separate strokes) and try again.',
    };
  }
  const done = await insertAll(lines);
  if (done < lines.length) {
    return {
      ok: false,
      message: `Only ${done} of ${lines.length} lines could be drawn.`,
    };
  }
  return {ok: true, message: 'Filled.'};
}

/** Ends of separate strokes closer than this (px) are taken as joined. */
const JOIN_GAP = 16;

/**
 * Hatching / fill of the areas enclosed by several strokes together (a triangle
 * drawn in three strokes, sides crossing at the corners…). Drawn with the first
 * stroke's pen.
 */
function fillAcross(
  outlines: {points: P[]; style: Style}[],
  fill: FillStyle,
  density: number,
): object[] {
  const area = enclosedArea(
    outlines.map(o => ({points: o.points, width: px(o.style.penWidth)})),
    JOIN_GAP,
  );
  if (!area) {
    return [];
  }
  const outlineWidth = Math.max(...outlines.map(o => o.style.penWidth));
  const plan = fillPlan(fill, outlineWidth, density);
  const style = {
    ...outlines[0].style,
    penWidth: plan.width,
    penColor: fill.color,
  };
  if (!('hatch' in fill)) {
    return chainRows(areaSegments(area, 0, plan.spacing, plan.inset, true)).map(
      c => geometry(c, style),
    );
  }
  return areaSegments(area, fill.hatch, plan.spacing, plan.inset).map(s =>
    geometry(s, style),
  );
}
