import {Element, PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {errorText, isShape, isStroke, ok} from './outline';
import {trace, traceStart} from './trace';
import {ABANDONED, actionLive} from './session';
import {StyleChange, colorName, restyle, restyleGeometry} from './style';

export {errorText, isShape, isStroke, ok};
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
const lassoRoute = (strokes: number, shapes: number) =>
  strokes === 0 && shapes === 1;

const widthOf = (e: Element) =>
  isShape(e) ? e.geometry!.penWidth || e.thickness : e.thickness;
const colorOf = (e: Element) =>
  isShape(e) ? e.geometry!.penColor : e.stroke?.penColor;

function describeColors(elements: Element[]): string {
  const values = [
    ...new Set(
      elements.map(colorOf).filter((c): c is number => typeof c === 'number'),
    ),
  ];
  return values.length ? values.map(colorName).join(', ') : '—';
}

export async function lassoElements(): Promise<{
  elements: Element[];
  error?: string;
}> {
  // The SDK's native side keeps the last element it read in a one-entry memo
  // that is never refreshed: the host hands out the SAME uuid for an element it
  // changed (resized, restyled), so without this, its points and width were the
  // old ones. Clearing the cache before every read makes it current.
  PluginCommAPI.clearElementCache();
  const res: any = await PluginCommAPI.getLassoElements();
  const elements = ok<Element[]>(res);
  return elements
    ? {elements}
    : {elements: [], error: `No lasso selection (${errorText(res)})`};
}

/**
 * The lasso is never let go, made again or otherwise driven by Inkwell: doing
 * so (test builds 16 to 19) duplicated multi-stroke selections and once made
 * the note crash and lose its recent history. A limit remains, from the host:
 * right after a lasso move or resize, the host keeps its own transformed copy
 * of the selection and writes it back when the lasso is let go, and nothing
 * read through the SDK shows that a transform is pending. A change made then is
 * lost; tapping elsewhere and selecting again first avoids it.
 */

/**
 * Elements read from the lasso are NOT recycled. Recycling frees the native
 * copy by uuid, and the host hands out the same uuid for an element it still
 * uses: after a change, the next selection of that element was dropped as soon
 * as the panel read and recycled it. The copies are small and freed with the
 * plugin.
 */
export const release = (_elements: Element[]) => undefined;

export async function readSummary(): Promise<Summary> {
  const [{elements, error}, pen] = await Promise.all([
    lassoElements(),
    PluginCommAPI.getPenInfo(),
  ]);
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
  let erasers = 0;
  try {
    for (const e of strokes) {
      const flags = e.stroke?.flagDraw;
      const n = flags ? await flags.size() : 0;
      if (n > 0) {
        const values = await flags!.getRange(0, n);
        off += values.filter(v => v === false).length;
        total += n;
      }
      erasers += e.stroke?.eraseLineTrailNums
        ? Math.max(0, await e.stroke.eraseLineTrailNums.size())
        : 0;
    }
  } catch {
    return 'n/a';
  }
  // Diagnostics: hidden points, and eraser strokes cutting the selected strokes.
  return [total ? `${off}/${total}` : '', erasers ? `erased by ${erasers}` : '']
    .filter(Boolean)
    .join(' · ');
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
  const shapes = rawRange(
    elements.filter(isShape).map(e => e.geometry!.penWidth),
  );
  const shapeThickness = rawRange(
    elements.filter(isShape).map(e => e.thickness),
  );
  return [
    strokes && `strokes ${strokes}`,
    shapes &&
      `shapes ${shapes}${
        shapeThickness && shapeThickness !== shapes
          ? ` (element ${shapeThickness})`
          : ''
      }`,
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
    const choice = await PluginManager.requestPermission(
      permission,
      'Changing width or colour edits the page.',
    );
    if (choice !== 1 && choice !== 2) {
      return false;
    }
  }
  writeGranted = true;
  return true;
}

/** Lasso route for a single selected shape: keeps the undo history. */
async function applyToLassoShape(
  change: StyleChange,
): Promise<{ok: boolean; message: string}> {
  const res: any = await PluginCommAPI.getLassoGeometries();
  const shapes = ok<any[]>(res) ?? [];
  if (shapes.length !== 1) {
    return {
      ok: false,
      message: `Could not read the selected shape: ${errorText(res)}`,
    };
  }
  const shape = {
    ...restyleGeometry(shapes[0], change),
    showLassoAfterInsert: true,
  };
  if (!actionLive()) {
    return ABANDONED;
  }
  const mod: any = await PluginCommAPI.modifyLassoGeometry(shape);
  return ok<boolean>(mod)
    ? {ok: true, message: 'Shape updated.'}
    : {ok: false, message: `Could not change the shape: ${errorText(mod)}`};
}

/** Sets the width (internal units) or the colour of every selected stroke and shape. */
export async function applyStyle(
  change: StyleChange,
  onReady: () => void = () => {},
): Promise<{ok: boolean; message: string}> {
  traceStart(
    'width' in change ? `Width ${change.width}` : `Colour ${change.color}`,
  );
  const summary = await readSummary();
  onReady();
  if (!summary.error && lassoRoute(summary.strokes, summary.shapes)) {
    return applyToLassoShape(change);
  }
  if (!(await ensureWriteAccess())) {
    return {
      ok: false,
      message:
        'File access denied: allow it ("Always allow") to change the selection.',
    };
  }
  // One attempt only. Retrying (with a pause) could run after the panel had
  // closed and resume when it was opened again, dropping the new selection.
  const {elements, error} = await lassoElements();
  if (error) {
    return {ok: false, message: error};
  }
  const targets = elements.filter(e => isStroke(e) || isShape(e));
  if (!targets.length) {
    return {ok: false, message: 'The selection has no strokes or shapes.'};
  }
  for (const e of targets) {
    restyle(e, change);
  }
  const page =
    ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
  if (!actionLive()) {
    trace('abandoned: panel opened again');
    return ABANDONED;
  }
  // No explicit layer: the host uses the current layer.
  const res: any = await PluginCommAPI.modifyPageElements(targets, page);
  const changed = ok<number[]>(res);
  trace(
    `modify: ${targets.length} el. → ${
      changed
        ? `${Array.isArray(changed) ? changed.length : '?'} modified`
        : errorText(res)
    }`,
  );
  if (!changed) {
    return {
      ok: false,
      message: `Could not change the selection: ${errorText(res)}`,
    };
  }
  if (Array.isArray(changed) && changed.length < targets.length) {
    return {
      ok: false,
      message: `Only ${changed.length} of ${targets.length} elements were updated.`,
    };
  }
  // Diagnostics only: what the selection reads like now.
  trace(`read back: ${(await applied(change)) ? 'changed' : 'unchanged'}`);
  return {ok: true, message: `${targets.length} elements updated.`};
}

/** Whether the selection, read again, shows the change. */
async function applied(change: StyleChange): Promise<boolean> {
  const {elements, error} = await lassoElements();
  if (error) {
    return true; // cannot check (selection dropped): trust the host's answer
  }
  const targets = elements.filter(e => isStroke(e) || isShape(e));
  const ok_ = targets.every(e =>
    'width' in change
      ? (isShape(e) ? e.geometry!.penWidth || e.thickness : e.thickness) ===
        change.width
      : colorOf(e) === change.color,
  );
  release(elements);
  return ok_;
}
