import {Element, PluginCommAPI} from 'sn-plugin-lib';
import {
  DashStyle,
  P,
  closedOutline,
  dashPattern,
  dashPolyline,
  chainRows,
  hatchSegments,
  fillPolylines,
  splitArrow,
  range,
  visibleRuns,
} from './patterns';
import {areaSegments, enclosedArea} from './regions';
import {Ink, hatchFill, solidFill} from './inkfill';
import {
  ensureWriteAccess,
  errorText,
  PDF_LIMIT,
  isPdf,
  isShape,
  isStroke,
  lassoElements,
  prepareSelection,
  releaseLasso,
  ok,
  release,
} from './selection';
import {getSettings} from './settings';
import {trace, traceStart} from './trace';
import {ABANDONED, actionLive} from './session';
import {
  Outline,
  Size,
  Style,
  contourOf,
  describeElement,
  outlineOf,
  pageSize,
  styleOf,
} from './outline';

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

/** About 100 width units per pixel of line (measured: 0.5 pen ≈ 600 ≈ 6 px). */
const px = (width: number) => width / 100;

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
  if (!actionLive()) {
    return 0;
  }
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
  // A pending move is applied first; neighbours caught by the reselection are
  // left alone, and the lasso let go once the action is done.
  const prep = await prepareSelection();
  if (prep.error) {
    return {all: [], targets: [], error: prep.error};
  }
  releaseAfter = prep.extras;
  const {elements, error} = await lassoElements();
  return {
    all: elements,
    targets: elements.filter(e => (isStroke(e) || isShape(e)) && prep.keep(e)),
    error,
  };
}

let releaseAfter = false;

async function thenRelease<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } finally {
    if (releaseAfter) {
      releaseAfter = false;
      await releaseLasso();
    }
  }
}

/**
 * Dashes for strokes and shapes alike: each is drawn again as one geometry per
 * dash, then the original is deleted. (Strokes were first dashed by hiding
 * points through their draw flags, as a partial eraser does; the device does
 * not show that.) Dashes are drawn at the element's width and colour, with the
 * fineliner for strokes (a dash has no pressure). An arrow keeps its head solid.
 *
 * Order: dashes inserted first, originals deleted only once every dash is in,
 * so nothing is ever lost and nothing is re-inserted. Deletion goes through the
 * lasso when it holds exactly these elements (no element number involved, the
 * lasso keeps no copy), else the lasso is let go and they are deleted by number.
 */
async function dashElements(
  elements: Element[],
  dash: DashStyle,
  size: Size | null,
  lassoHoldsExactly: boolean,
): Promise<{done: number; why?: string}> {
  const pieces: object[] = [];
  for (const e of elements) {
    const o = await outlineOf(e, size);
    if (!o) {
      continue;
    }
    const pattern = dashPattern(dash, px(o.style.penWidth));
    if (isStroke(e)) {
      const style: Style = {...o.style, penType: FINELINER};
      for (const run of visibleRuns(
        o.points,
        await drawFlags(e, o.points.length),
      )) {
        pieces.push(...dashPolyline(run, pattern).map(d => geometry(d, style)));
      }
      continue;
    }
    const arrow = splitArrow(o.points);
    pieces.push(
      ...dashPolyline(arrow ? arrow.shaft : o.points, pattern).map(d =>
        geometry(d, o.style),
      ),
    );
    if (arrow) {
      pieces.push(geometry(arrow.head, o.style));
    }
  }
  if (!pieces.length) {
    return {done: 0, why: 'could not read the selection'};
  }
  const page =
    ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? elements[0].pageNum;
  if (!actionLive()) {
    return {done: 0, why: ABANDONED.message};
  }
  const nums = elements.map(e => e.numInPage);
  trace(
    `dash ${elements.length} element(s) #${nums.join(
      ',',
    )} (page ${page}, el. page ${elements[0].pageNum} layer ${
      elements[0].layerNum
    }) · ${pieces.length} dashes · ${
      lassoHoldsExactly ? 'through the lasso' : 'by number'
    }`,
  );
  if (!lassoHoldsExactly && !(await releaseLasso())) {
    return {done: 0, why: 'the selection could not be let go: nothing changed'};
  }
  const done = await insertAll(pieces);
  trace(`dashes drawn: ${done}/${pieces.length}`);
  if (done < pieces.length) {
    return {
      done: 0,
      why: `only ${done} of ${pieces.length} dashes could be drawn; the originals were kept`,
    };
  }
  let deleted: any = lassoHoldsExactly
    ? await PluginCommAPI.deleteLassoElements()
    : await PluginCommAPI.deletePageElements(nums, page);
  if (lassoHoldsExactly && !ok<boolean>(deleted)) {
    // In a PDF the lasso can be gone after the insertion: delete by number
    // (the dashes were appended, the originals keep their numbers).
    trace(`lasso delete: ${errorText(deleted)} → by number`);
    deleted = await PluginCommAPI.deletePageElements(nums, page);
  }
  trace(
    `originals deleted: ${ok<boolean>(deleted) ? 'ok' : errorText(deleted)}`,
  );
  return ok<boolean>(deleted)
    ? {done: elements.length}
    : {
        done: 0,
        why: `dashes drawn, but the originals could not be deleted: ${errorText(
          deleted,
        )}`,
      };
}

/** Makes every selected stroke and shape dashed. */
export const applyDashes = (
  dash: DashStyle,
  onReady: OnReady = () => {},
): Promise<Result> => thenRelease(dashes(dash, onReady));

async function dashes(
  dash: DashStyle,
  onReady: OnReady = () => {},
): Promise<Result> {
  traceStart(`Dash ${dash}`);
  if (await isPdf()) {
    return {ok: false, message: PDF_LIMIT};
  }
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
  const problems: string[] = [];
  // Only strokes and shapes selected, nothing else: they go through the lasso.
  const exactly = !releaseAfter && all.length === targets.length;
  const r = await dashElements(targets, dash, size, exactly);
  if (r.why) {
    problems.push(r.why);
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
export const applyFill = (
  fill: FillStyle,
  onReady: OnReady = () => {},
  density = getSettings().hatchDensity,
): Promise<Result> => thenRelease(fills(fill, onReady, density));

async function fills(
  fill: FillStyle,
  onReady: OnReady = () => {},
  density = getSettings().hatchDensity,
): Promise<Result> {
  traceStart('hatch' in fill ? 'Hatch' : 'Fill');
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
  // Solid fill: up to the real ink of the outline, with a smooth edge.
  if (!('hatch' in fill)) {
    const lines = await solidLines(targets, fill, size);
    if (lines) {
      release(all);
      const inserted = await insertAll(lines);
      return inserted < lines.length
        ? {
            ok: false,
            message: `Only ${inserted} of ${lines.length} lines could be drawn.`,
          }
        : {ok: true, message: 'Filled.'};
    }
    // Nothing enclosed found this way: the former method below decides.
  } else {
    const lines = await hatchLines(targets, fill, size, density);
    if (lines) {
      release(all);
      const inserted = await insertAll(lines);
      return inserted < lines.length
        ? {
            ok: false,
            message: `Only ${inserted} of ${lines.length} lines could be drawn.`,
          }
        : {ok: true, message: 'Hatched.'};
    }
  }
  // Visible pieces of every selected stroke / shape: a partly erased stroke
  // stays one element with hidden points, and only its visible runs count.
  const pieces: Outline[] = [];
  let erased = 0; // cut with the eraser: the stored centre line still holds the erased parts
  let drawn = 0; // read from the drawn contour instead of the centre line
  const unreadable: string[] = [];
  for (const e of targets) {
    const o = await outlineOf(e, size);
    const cut = (await eraserCount(e)) > 0;
    if (o && !cut) {
      const runs = visibleRuns(o.points, await drawFlags(e, o.points.length));
      pieces.push(...runs.map(points => ({points, style: o.style})));
      continue;
    }
    // Erased, or no readable centre line: the drawn contour is the ink as shown.
    const loops = await contourOf(e, size);
    if (loops.length) {
      drawn++;
      pieces.push(...loops.map(points => ({points, style: styleOf(e)})));
    } else if (o) {
      erased++;
      pieces.push({points: o.points, style: o.style});
    } else {
      unreadable.push(await describeElement(e));
    }
  }
  release(all);
  const closed = pieces.map(o => closedOutline(o.points));
  const lines: object[] = [];
  if (pieces.length && !erased && !drawn && closed.every(Boolean)) {
    // Every piece closed on its own: fill each exactly, from its outline.
    pieces.forEach((o, i) =>
      lines.push(...fillPolygon(closed[i]!, o.style, fill, density)),
    );
  } else if (pieces.length) {
    // Otherwise the pieces may close areas together (joined strokes, shapes cut
    // with the eraser and joined up…): all of them, closed ones included, are
    // taken as the walls. For shapes cut with the eraser, whose stored outline
    // still holds the erased parts, this fills their union.
    lines.push(...fillAcross(pieces, fill, density));
  }
  if (!lines.length) {
    const seen = [
      `${targets.length} selected`,
      `${pieces.length} pieces (${closed.filter(Boolean).length} closed)`,
      erased ? `${erased} erased` : '',
      drawn ? `${drawn} from contours` : '',
      unreadable.length
        ? `unreadable: ${unreadable.slice(0, 2).join(' | ')}`
        : '',
    ].filter(Boolean);
    return {
      ok: false,
      message: `Nothing closed to fill: close the outline and try again. (${seen.join(
        ' · ',
      )})`,
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

/** Fill lines: ≈ 0.7 mm, 5 px apart, always drawn with the fineliner (uniform). */
const SOLID_WIDTH = 8;
const SOLID_SPACING = 5;
const FINELINER = 10;

/**
 * A solid fill as one ring plus straight rows (see inkfill.ts).
 *
 * Hand-drawn strokes are drawn by the host ABOVE geometries (measured: a fill
 * that ran under a stroke made thicker afterwards was hidden by it). So the
 * fill goes up to the middle of a stroke, whose inner half hides its edge,
 * whatever the stroke's real (pressure) width, and even after its width was
 * changed: the stored ink contour is not updated then, which left a white rim.
 * A stroke cut with the eraser keeps its erased points in its centre line, so
 * its drawn contour is used instead. Shapes, drawn below the fill, are taken
 * with their exact width: the fill stops at their inner edge.
 * Null when nothing enclosed is found: the caller falls back.
 */
async function solidLines(
  targets: Element[],
  fill: FillStyle,
  size: Size | null,
): Promise<object[] | null> {
  const inks: Ink[] = [];
  for (const e of targets) {
    const o = await outlineOf(e, size);
    if (isStroke(e)) {
      if ((await eraserCount(e)) > 0) {
        const loops = await contourOf(e, size);
        if (loops.length && o) {
          inks.push({loops, centre: o.points});
          continue;
        }
      }
      if (o) {
        // Visible runs only (a partial eraser hides points through draw flags).
        for (const run of visibleRuns(
          o.points,
          await drawFlags(e, o.points.length),
        )) {
          inks.push({points: run, width: 2});
        }
      }
      continue;
    }
    if (o) {
      inks.push({points: o.points, width: px(o.style.penWidth)});
    }
  }
  const area = solidFill(inks, SOLID_WIDTH, SOLID_SPACING, JOIN_GAP);
  if (!area) {
    return null;
  }
  const style: Style = {
    penType: FINELINER,
    penColor: fill.color,
    penWidth: SOLID_WIDTH * 100,
  };
  // A few continuous paths (usually one per enclosed part): a lasso touching
  // any bit of the fill takes it whole, and the host inserts few elements.
  return area.paths.map(p =>
    geometry(p.points, {...style, penWidth: Math.round(p.width * 100)}),
  );
}

/**
 * Hatching on the same grid as solid fills, its line ends placed square to the
 * outline: each end's round cap just overlaps the inner edge of the outline
 * (about 1 px), which closes the hatching against it as the former hatching
 * did on thin strokes, without running onto thick ones. (The fill lines are
 * drawn ABOVE strokes, measured: a line taken up to the middle of a thick
 * stroke showed over it.) Outlines are taken at their pen width, eraser-cut
 * strokes by their drawn contour. Null when nothing enclosed is found: the
 * caller falls back.
 */
async function hatchLines(
  targets: Element[],
  fill: FillStyle,
  size: Size | null,
  density: number,
): Promise<object[] | null> {
  if (!('hatch' in fill)) {
    return null;
  }
  const inks: Ink[] = [];
  let outlineWidth = 0;
  for (const e of targets) {
    const o = await outlineOf(e, size);
    if (!o) {
      continue;
    }
    outlineWidth = Math.max(outlineWidth, o.style.penWidth);
    if (isStroke(e) && (await eraserCount(e)) > 0) {
      const loops = await contourOf(e, size);
      if (loops.length) {
        inks.push({loops, centre: o.points});
        continue;
      }
    }
    const runs = isStroke(e)
      ? visibleRuns(o.points, await drawFlags(e, o.points.length))
      : [o.points];
    for (const run of runs) {
      inks.push({points: run, width: px(o.style.penWidth)});
    }
  }
  const plan = fillPlan(fill, outlineWidth, density);
  const hatch = hatchFill(
    inks,
    fill.hatch,
    plan.spacing,
    // Ends this far from the ink: the cap (half a line) overlaps it by ~1 px.
    Math.max(0.5, px(plan.width) / 2 - 1),
    JOIN_GAP,
  );
  if (!hatch || !hatch.segments.length) {
    return null;
  }
  const style: Style = {
    penType: FINELINER,
    penColor: fill.color,
    penWidth: plan.width,
  };
  // One element per line: joins between lines would show (drawn above strokes).
  return hatch.segments.map(sg => geometry(sg, style));
}

/** Lines inside one closed outline. */
function fillPolygon(
  polygon: P[],
  outline: Style,
  fill: FillStyle,
  density: number,
): object[] {
  const plan = fillPlan(fill, outline.penWidth, density);
  const style = {...outline, penWidth: plan.width, penColor: fill.color};
  if (!('hatch' in fill)) {
    return fillPolylines(polygon, plan.spacing, plan.inset).map(c =>
      geometry(c, style),
    );
  }
  return hatchSegments(polygon, fill.hatch, plan.spacing, plan.inset).map(s =>
    geometry(s, style),
  );
}

/** How many eraser strokes cut this stroke (0 when none, or unknown). */
async function eraserCount(e: Element): Promise<number> {
  try {
    const refs = e.stroke?.eraseLineTrailNums;
    return isStroke(e) && refs ? Math.max(0, await refs.size()) : 0;
  } catch {
    return 0;
  }
}

/** A stroke's per-point draw flags (false = erased), or null when it has none. */
async function drawFlags(e: Element, n: number): Promise<boolean[] | null> {
  try {
    const flags = e.stroke?.flagDraw;
    if (!isStroke(e) || !flags || (await flags.size()) !== n) {
      return null;
    }
    return await flags.getRange(0, n);
  } catch {
    return null;
  }
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
  const outlineWidth = range(outlines.map(o => o.style.penWidth)).max;
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
