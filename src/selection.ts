import {Element, PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {StyleChange, colorName, restyle, restyleGeometry} from './style';
import {describeRange} from './widths';

/**
 * Reads the current lasso selection and rewrites the width or the colour of its
 * strokes and geometries. Other elements (text boxes, pictures, links…) are left untouched.
 *
 * Two routes, because of Supernote's undo history (measured on a Manta):
 * - a single shape: modifyLassoGeometry, a lasso operation, which keeps undo;
 * - anything else: modifyPageElements, which clears the undo history.
 */

export type Summary = {
  strokes: number;
  shapes: number;
  others: number;
  /** Current widths, e.g. "0.3" or "0.3–0.8". */
  range: string;
  /** Current colours, e.g. "Black" or "Black, Dark gray". */
  colors: string;
  /** Raw internal widths of strokes and of shapes, to compare their scales. */
  raw: string;
  /** Hidden points (draw flag off) over all points of the first strokes, e.g. "12/340". */
  hidden: string;
  /** Active pen raw width, to check the mm mapping. */
  penWidth: number | null;
  error?: string;
};

/** Only a lone shape can go through the undo-friendly lasso route. */
const lassoRoute = (strokes: number, shapes: number) => strokes === 0 && shapes === 1;

export function ok<T>(res: any): T | null {
  return res?.success ? (res.result as T) : null;
}

export function errorText(res: any): string {
  return res?.error ? `${res.error.message ?? 'unknown'} (code ${res.error.code ?? '?'})` : 'no result';
}

export const isStroke = (e: Element) => e.type === Element.TYPE_STROKE;
export const isShape = (e: Element) => e.type === Element.TYPE_GEO && !!e.geometry;
const widthOf = (e: Element) => (isShape(e) ? e.geometry!.penWidth || e.thickness : e.thickness);
const colorOf = (e: Element) => (isShape(e) ? e.geometry!.penColor : e.stroke?.penColor);

function describeColors(elements: Element[]): string {
  const values = [...new Set(elements.map(colorOf).filter((c): c is number => typeof c === 'number'))];
  return values.length ? values.map(colorName).join(', ') : '—';
}

export async function lassoElements(): Promise<{elements: Element[]; error?: string}> {
  const res: any = await PluginCommAPI.getLassoElements();
  const elements = ok<Element[]>(res);
  return elements ? {elements} : {elements: [], error: `No lasso selection (${errorText(res)})`};
}

export const release = (elements: Element[]) => elements.forEach(e => e?.uuid && PluginCommAPI.recycleElement(e.uuid));

export async function readSummary(): Promise<Summary> {
  const [{elements, error}, pen] = await Promise.all([lassoElements(), PluginCommAPI.getPenInfo()]);
  const targets = elements.filter(e => isStroke(e) || isShape(e));
  const summary: Summary = {
    strokes: elements.filter(isStroke).length,
    shapes: elements.filter(isShape).length,
    others: elements.length - targets.length,
    range: describeRange(targets.map(widthOf)),
    colors: describeColors(targets),
    raw: rawRanges(elements),
    hidden: await hiddenPoints(elements.filter(isStroke).slice(0, 5)),
    penWidth: ok<{width: number}>(pen)?.width ?? null,
    error,
  };
  release(elements);
  return summary;
}

/** Diagnostics for dashed strokes: how many points have their draw flag off. */
async function hiddenPoints(strokes: Element[]): Promise<string> {
  let off = 0;
  let total = 0;
  try {
    for (const e of strokes) {
      const flags = e.stroke?.flagDraw;
      const n = flags ? await flags.size() : 0;
      if (n > 0) {
        const values = await flags!.getRange(0, n);
        off += values.filter(v => v === false).length;
        total += n;
      }
    }
  } catch {
    return 'n/a';
  }
  return total ? `${off}/${total}` : '';
}

function rawRange(values: number[]): string {
  const v = values.filter(n => n > 0);
  if (!v.length) {
    return '';
  }
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

function rawRanges(elements: Element[]): string {
  const strokes = rawRange(elements.filter(isStroke).map(e => e.thickness));
  const shapes = rawRange(elements.filter(isShape).map(e => e.geometry!.penWidth));
  const shapeThickness = rawRange(elements.filter(isShape).map(e => e.thickness));
  return [
    strokes && `strokes ${strokes}`,
    shapes && `shapes ${shapes}${shapeThickness && shapeThickness !== shapes ? ` (element ${shapeThickness})` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

let writeGranted = false;

export async function ensureWriteAccess(): Promise<boolean> {
  if (writeGranted) {
    return true;
  }
  const permission = 'plugin.permission.FILE:WRITE';
  if ((await PluginManager.hasPermission(permission)) < 1) {
    const choice = await PluginManager.requestPermission(permission, 'Changing width or colour edits the page.');
    if (choice !== 1 && choice !== 2) {
      return false;
    }
  }
  writeGranted = true;
  return true;
}

/** Lasso route for a single selected shape: keeps the undo history. */
async function applyToLassoShape(change: StyleChange): Promise<{ok: boolean; message: string}> {
  const res: any = await PluginCommAPI.getLassoGeometries();
  const shapes = ok<any[]>(res) ?? [];
  if (shapes.length !== 1) {
    return {ok: false, message: `Could not read the selected shape: ${errorText(res)}`};
  }
  const shape = {...restyleGeometry(shapes[0], change), showLassoAfterInsert: true};
  const mod: any = await PluginCommAPI.modifyLassoGeometry(shape);
  return ok<boolean>(mod)
    ? {ok: true, message: 'Shape updated.'}
    : {ok: false, message: `Could not change the shape: ${errorText(mod)}`};
}

/** Sets the width (internal units) or the colour of every selected stroke and shape. */
export async function applyStyle(change: StyleChange): Promise<{ok: boolean; message: string}> {
  const summary = await readSummary();
  if (!summary.error && lassoRoute(summary.strokes, summary.shapes)) {
    return applyToLassoShape(change);
  }
  if (!(await ensureWriteAccess())) {
    return {ok: false, message: 'File access denied: allow it ("Always allow") to change the selection.'};
  }
  const {elements, error} = await lassoElements();
  if (error) {
    return {ok: false, message: error};
  }
  const targets = elements.filter(e => isStroke(e) || isShape(e));
  release(elements.filter(e => !targets.includes(e)));
  if (!targets.length) {
    return {ok: false, message: 'The selection has no strokes or shapes.'};
  }
  for (const e of targets) {
    restyle(e, change);
  }
  const page = ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
  // No explicit layer: the host uses the current layer.
  const res: any = await PluginCommAPI.modifyPageElements(targets, page);
  const changed = ok<number[]>(res);
  if (!changed) {
    release(targets);
    return {ok: false, message: `Could not change the selection: ${errorText(res)}`};
  }
  // Modified elements stay referenced by the host: they are not recycled here.
  return {ok: true, message: `${changed.length} of ${targets.length} elements updated.`};
}
