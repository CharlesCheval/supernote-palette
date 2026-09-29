import {Element, PluginCommAPI, PointUtils} from 'sn-plugin-lib';
import {
  DashStyle,
  P,
  closedOutline,
  dashPattern,
  dashPolyline,
  ellipsePoints,
  fillPolylines,
  hatchSegments,
} from './patterns';
import {ensureWriteAccess, errorText, isShape, isStroke, lassoElements, ok, release} from './selection';

/**
 * Line patterns and fills for the lasso selection. Supernote has no dashed or
 * filled style, so the result is made of plain geometries (polylines):
 * - dashes REPLACE each selected stroke / shape;
 * - hatching and fills are ADDED inside each closed stroke / shape, which stays.
 */

export type FillStyle = 'hatch' | 'cross' | 'gray' | 'solid';

type Result = {ok: boolean; message: string};
type Style = {penType: number; penColor: number; penWidth: number};

/** About 100 width units per pixel of line (measured: 0.5 pen ≈ 600 ≈ 6 px). */
const px = (width: number) => width / 100;

type Size = {width: number; height: number};

async function pageSize(): Promise<Size | null> {
  const s = ok<Size>(await PluginCommAPI.getPageDisplaySize());
  return s && s.width > 1 && s.height > 1 ? {width: Math.round(s.width), height: Math.round(s.height)} : null;
}

/** An element's outline in page pixels, and the style it is drawn with. */
async function outlineOf(e: Element, size: Size | null): Promise<{points: P[]; style: Style} | null> {
  if (isShape(e)) {
    const g = e.geometry!;
    const style = {penType: g.penType, penColor: g.penColor, penWidth: g.penWidth || e.thickness};
    if ((g.type === 'GEO_circle' || g.type === 'GEO_ellipse') && g.ellipseCenterPoint) {
      const pts = ellipsePoints(g.ellipseCenterPoint, g.ellipseMajorAxisRadius, g.ellipseMinorAxisRadius, g.ellipseAngle);
      return {points: pts, style};
    }
    return g.points?.length >= 2 ? {points: g.points.map(p => ({x: p.x, y: p.y})), style} : null;
  }
  if (isStroke(e) && e.stroke && size) {
    const n = await e.stroke.points.size();
    if (n < 2) {
      return null;
    }
    const emr = await e.stroke.points.getRange(0, n);
    const style = {penType: e.stroke.penType, penColor: e.stroke.penColor, penWidth: e.thickness};
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

async function insertAll(geometries: object[]): Promise<number> {
  let done = 0;
  for (const g of geometries) {
    if (!ok<boolean>(await PluginCommAPI.insertGeometry(g as any))) {
      break;
    }
    done++;
  }
  return done;
}

async function selection(): Promise<{all: Element[]; targets: Element[]; error?: string}> {
  const {elements, error} = await lassoElements();
  return {all: elements, targets: elements.filter(e => isStroke(e) || isShape(e)), error};
}

/** Replaces every selected stroke and shape by dashes that follow it. */
export async function applyDashes(dash: DashStyle): Promise<Result> {
  const {all, targets, error} = await selection();
  if (error || !targets.length) {
    release(all);
    return {ok: false, message: error ?? 'The selection has no strokes or shapes.'};
  }
  const size = await pageSize();
  const pieces: object[] = [];
  for (const e of targets) {
    const o = await outlineOf(e, size);
    if (o) {
      pieces.push(...dashPolyline(o.points, dashPattern(dash, px(o.style.penWidth))).map(d => geometry(d, o.style)));
    }
  }
  if (!pieces.length) {
    release(all);
    return {ok: false, message: 'Could not read the selected lines.'};
  }
  // Delete first, while the lasso still holds the selection, then draw the dashes.
  // A pure selection goes through the lasso (keeps the undo history).
  let deleted: any;
  if (all.length === targets.length) {
    deleted = await PluginCommAPI.deleteLassoElements();
  } else if (await ensureWriteAccess()) {
    const page = ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
    deleted = await PluginCommAPI.deletePageElements(targets.map(e => e.numInPage), page);
  } else {
    release(all);
    return {ok: false, message: 'File access denied: allow it ("Always allow") to change the selection.'};
  }
  if (!ok<boolean>(deleted)) {
    release(all);
    return {ok: false, message: `Could not replace the lines: ${errorText(deleted)}`};
  }
  const done = await insertAll(pieces);
  if (done < pieces.length) {
    // Put the originals back rather than leave a half-dashed drawing.
    const page = ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
    await PluginCommAPI.insertPageElements(targets, page);
    release(all);
    return {ok: false, message: `Only ${done} of ${pieces.length} dashes could be drawn; the lines were restored.`};
  }
  release(all);
  return {ok: true, message: `${pieces.length} dashes drawn.`};
}

/** Hatching / fill spacing and line width (px) for each fill style. */
function fillPlan(fill: FillStyle, outlineWidth: number) {
  if (fill === 'gray' || fill === 'solid') {
    const width = 1200; // ≈ 12 px lines, 8 px apart: they merge into a solid area
    return {width, spacing: 8, inset: px(width) / 2 + px(outlineWidth) / 2};
  }
  const width = Math.min(outlineWidth, 500);
  return {width, spacing: Math.max(14, 3 * px(width)), inset: px(outlineWidth) / 2};
}

/** Hatches or fills the inside of every selected closed stroke or shape. */
export async function applyFill(fill: FillStyle): Promise<Result> {
  const {all, targets, error} = await selection();
  if (error || !targets.length) {
    release(all);
    return {ok: false, message: error ?? 'The selection has no strokes or shapes.'};
  }
  const size = await pageSize();
  const lines: object[] = [];
  let open = 0;
  for (const e of targets) {
    const o = await outlineOf(e, size);
    const polygon = o && closedOutline(o.points);
    if (!o || !polygon) {
      open++;
      continue;
    }
    const plan = fillPlan(fill, o.style.penWidth);
    const style = {
      ...o.style,
      penWidth: plan.width,
      penColor: fill === 'gray' ? 0xc9 : o.style.penColor,
    };
    if (fill === 'gray' || fill === 'solid') {
      lines.push(...fillPolylines(polygon, plan.spacing, plan.inset).map(c => geometry(c, style)));
    } else {
      for (const angle of fill === 'cross' ? [-45, 45] : [-45]) {
        lines.push(...hatchSegments(polygon, angle, plan.spacing, plan.inset).map(s => geometry(s, style)));
      }
    }
  }
  release(all);
  if (!lines.length) {
    return {ok: false, message: 'Only closed shapes can be filled: close the outline and try again.'};
  }
  const done = await insertAll(lines);
  if (done < lines.length) {
    return {ok: false, message: `Only ${done} of ${lines.length} lines could be drawn.`};
  }
  return {ok: true, message: open ? `Filled; ${open} open line(s) skipped.` : 'Filled.'};
}
