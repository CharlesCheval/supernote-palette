import {Element, PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {
  errorText,
  isShape,
  isStroke,
  ok,
  outlineOf,
  pageSize,
  withTimeout,
} from './outline';
import {range} from './patterns';
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

type Rect = {left: number; top: number; right: number; bottom: number};

/**
 * Whether a move or resize is still pending in the lasso. A lasso drawn by hand
 * always encloses the ink it selects, however loosely; while a shrink or a move
 * is pending, the box is at the new place and size but the elements read are
 * the old ones, so their ink sticks out of the box. That is the only signal
 * used: a loose lasso (box much bigger than the ink) is normal, and an enlarge
 * still pending cannot be told apart from it, so it is left alone.
 */
export function pendingTransform(box: Rect, ink: Rect, margin = 24): boolean {
  return (
    ink.left < box.left - margin ||
    ink.top < box.top - margin ||
    ink.right > box.right + margin ||
    ink.bottom > box.bottom + margin
  );
}

const LASSO_CALL_MS = 3000;

/**
 * After a lasso move or resize, while the shape is still selected, the host
 * keeps the transform pending in the lasso, with its own copy of the elements,
 * and writes that copy back when the lasso is let go: a change made to the page
 * meanwhile was silently lost. Before every action the lasso is therefore let
 * go (committing any transform, as tapping elsewhere does) and made again on
 * its box, so the change applies to the elements as they now are.
 *
 * Returns a filter that keeps only the elements selected before, in case the
 * rectangular lasso also caught neighbours. Every host call is bounded in time;
 * if anything fails, the lasso is not touched and every element is kept.
 */
export async function settleLasso(): Promise<(e: Element) => boolean> {
  const keepAll = () => true;
  try {
    const before = await withTimeout(lassoElements(), LASSO_CALL_MS, {
      elements: [],
      error: 'timeout',
    });
    if (before.error || !before.elements.length) {
      trace(`lasso: ${before.error ?? 'empty'}`);
      return keepAll;
    }
    const nums = new Set(before.elements.map(e => e.numInPage));
    const count = before.elements.length;
    const size = await pageSize();
    const box = ok<Rect>(
      await withTimeout(
        PluginCommAPI.getLassoRect() as Promise<any>,
        LASSO_CALL_MS,
        null,
      ),
    );
    const pts = [];
    for (const e of before.elements) {
      const o = await outlineOf(e, size);
      if (o) {
        pts.push(...o.points);
      }
    }
    release(before.elements);
    const xs = range(pts.map(p => p.x));
    const ys = range(pts.map(p => p.y));
    const fmt = (r: Rect | null) =>
      r
        ? `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(
            r.right,
          )},${Math.round(r.bottom)}`
        : 'none';
    trace(
      `lasso: ${count} el. #${[...nums].join(',')} · box ${fmt(box)} · ink ${
        pts.length
          ? fmt({left: xs.min, top: ys.min, right: xs.max, bottom: ys.max})
          : 'none'
      } · page ${size ? `${size.width}×${size.height}` : '?'}`,
    );
    // Only a box in page pixels can be compared (and lassoed again).
    if (
      !box ||
      !size ||
      !pts.length ||
      box.right > 1.3 * size.width ||
      box.bottom > 1.3 * size.height
    ) {
      return keepAll;
    }
    // Measured: after a move or resize the host keeps its own transformed copy
    // of the selection and writes it back when the lasso is let go, over any
    // change made to the page meanwhile, and nothing read through the SDK tells
    // that a transform is pending. So the lasso is ALWAYS let go first
    // (committing any transform) and made again on its box.
    trace(
      `committing lasso (ink ${
        pendingTransform(box, {
          left: xs.min,
          top: ys.min,
          right: xs.max,
          bottom: ys.max,
        })
          ? 'outside'
          : 'inside'
      } box)`,
    );
    if (!actionLive()) {
      return keepAll;
    }
    if (
      !ok<boolean>(
        await withTimeout(
          PluginCommAPI.setLassoBoxState(2) as Promise<any>,
          LASSO_CALL_MS,
          null,
        ),
      )
    ) {
      return keepAll;
    }
    const r = {
      left: Math.floor(box.left),
      top: Math.floor(box.top),
      right: Math.ceil(box.right),
      bottom: Math.ceil(box.bottom),
    };
    await withTimeout(
      PluginCommAPI.lassoElements(r) as Promise<any>,
      LASSO_CALL_MS,
      null,
    );
    const after = await withTimeout(lassoElements(), LASSO_CALL_MS, {
      elements: [],
      error: 'timeout',
    });
    const known = after.elements.filter(e => nums.has(e.numInPage)).length;
    const total = after.elements.length;
    const now = [];
    for (const e of after.elements) {
      const o = await outlineOf(e, size);
      if (o) {
        now.push(...o.points);
      }
    }
    const nx = range(now.map(p => p.x));
    const ny = range(now.map(p => p.y));
    trace(
      `re-lasso: ${
        after.error ??
        `${total} el., ${known} same numbers · ink ${
          now.length
            ? fmt({left: nx.min, top: ny.min, right: nx.max, bottom: ny.max})
            : 'none'
        }`
      }`,
    );
    release(after.elements);
    if (known > 0) {
      return e => nums.has(e.numInPage);
    }
    // Numbers changed by the commit: the new selection, made on the shape's own
    // resize box.
    return total > 0 && total <= count + 2
      ? keepAll
      : e => nums.has(e.numInPage);
  } catch (e: any) {
    trace(`lasso check failed: ${e?.message ?? e}`);
    return keepAll;
  }
}

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
  const keep = await settleLasso();
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
  const targets = elements.filter(e => (isStroke(e) || isShape(e)) && keep(e));
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
  trace(
    `read back: ${(await applied(change, keep)) ? 'changed' : 'unchanged'}`,
  );
  return {ok: true, message: `${targets.length} elements updated.`};
}

/** Whether the selection, read again, shows the change. */
async function applied(
  change: StyleChange,
  keep: (e: Element) => boolean,
): Promise<boolean> {
  const {elements, error} = await lassoElements();
  if (error) {
    return true; // cannot check (selection dropped): trust the host's answer
  }
  const targets = elements.filter(e => (isStroke(e) || isShape(e)) && keep(e));
  const ok_ = targets.every(e =>
    'width' in change
      ? (isShape(e) ? e.geometry!.penWidth || e.thickness : e.thickness) ===
        change.width
      : colorOf(e) === change.color,
  );
  release(elements);
  return ok_;
}
