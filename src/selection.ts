import {Element, PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {describeRange} from './widths';

/**
 * Reads the current lasso selection and rewrites the width of its strokes and
 * geometries. Other elements (text boxes, pictures, links…) are left untouched.
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
  /** Active pen raw width, to check the mm mapping. */
  penWidth: number | null;
  /** False when the change will clear Supernote's undo history. */
  undoable: boolean;
  error?: string;
};

/** Only a lone shape can go through the undo-friendly lasso route. */
const lassoRoute = (strokes: number, shapes: number) => strokes === 0 && shapes === 1;

function ok<T>(res: any): T | null {
  return res?.success ? (res.result as T) : null;
}

function errorText(res: any): string {
  return res?.error ? `${res.error.message ?? 'unknown'} (code ${res.error.code ?? '?'})` : 'no result';
}

const isStroke = (e: Element) => e.type === Element.TYPE_STROKE;
const isShape = (e: Element) => e.type === Element.TYPE_GEO && !!e.geometry;
const widthOf = (e: Element) => (isShape(e) ? e.geometry!.penWidth || e.thickness : e.thickness);

async function lassoElements(): Promise<{elements: Element[]; error?: string}> {
  const res: any = await PluginCommAPI.getLassoElements();
  const elements = ok<Element[]>(res);
  return elements ? {elements} : {elements: [], error: `No lasso selection (${errorText(res)})`};
}

const release = (elements: Element[]) => elements.forEach(e => e?.uuid && PluginCommAPI.recycleElement(e.uuid));

export async function readSummary(): Promise<Summary> {
  const [{elements, error}, pen] = await Promise.all([lassoElements(), PluginCommAPI.getPenInfo()]);
  const targets = elements.filter(e => isStroke(e) || isShape(e));
  const summary: Summary = {
    strokes: elements.filter(isStroke).length,
    shapes: elements.filter(isShape).length,
    others: elements.length - targets.length,
    range: describeRange(targets.map(widthOf)),
    penWidth: ok<{width: number}>(pen)?.width ?? null,
    undoable: true,
    error,
  };
  summary.undoable = lassoRoute(summary.strokes, summary.shapes);
  release(elements);
  return summary;
}

let writeGranted = false;

async function ensureWriteAccess(): Promise<boolean> {
  if (writeGranted) {
    return true;
  }
  const permission = 'plugin.permission.FILE:WRITE';
  if ((await PluginManager.hasPermission(permission)) < 1) {
    const choice = await PluginManager.requestPermission(permission, 'Changing stroke width edits the page.');
    if (choice !== 1 && choice !== 2) {
      return false;
    }
  }
  writeGranted = true;
  return true;
}

/** Lasso route for a single selected shape: keeps the undo history. */
async function applyToLassoShape(width: number): Promise<{ok: boolean; message: string}> {
  const res: any = await PluginCommAPI.getLassoGeometries();
  const shapes = ok<any[]>(res) ?? [];
  if (shapes.length !== 1) {
    return {ok: false, message: `Could not read the selected shape: ${errorText(res)}`};
  }
  const shape = {...shapes[0], penWidth: width, showLassoAfterInsert: true};
  const mod: any = await PluginCommAPI.modifyLassoGeometry(shape);
  return ok<boolean>(mod)
    ? {ok: true, message: 'Shape updated.'}
    : {ok: false, message: `Could not change the width: ${errorText(mod)}`};
}

/** Sets every selected stroke and shape to `width` (internal units). */
export async function applyWidth(width: number): Promise<{ok: boolean; message: string}> {
  const summary = await readSummary();
  if (!summary.error && lassoRoute(summary.strokes, summary.shapes)) {
    return applyToLassoShape(width);
  }
  if (!(await ensureWriteAccess())) {
    return {ok: false, message: 'File access denied: allow it ("Always allow") to change widths.'};
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
    e.thickness = width;
    if (isShape(e)) {
      e.geometry!.penWidth = width;
    }
  }
  const page = ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
  // No explicit layer: the host uses the current layer.
  const res: any = await PluginCommAPI.modifyPageElements(targets, page);
  const changed = ok<number[]>(res);
  if (!changed) {
    release(targets);
    return {ok: false, message: `Could not change the width: ${errorText(res)}`};
  }
  // Modified elements stay referenced by the host: they are not recycled here.
  return {ok: true, message: `${changed.length} of ${targets.length} elements updated.`};
}
