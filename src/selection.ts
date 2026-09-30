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
const lassoRoute = (strokes: number, shapes: number) =>
  strokes === 0 && shapes === 1;

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
  const res: any = await PluginCommAPI.getLassoElements();
  const elements = ok<Element[]>(res);
  return elements
    ? {elements}
    : {elements: [], error: `No lasso selection (${errorText(res)})`};
}

/**
 * Right after a lasso move or resize, while the shape is still selected, the
 * host keeps the transform pending in the lasso: the elements it hands out are
 * the old ones, and changes made to the page only show once the lasso is let go
 * and made again. So, before acting, the lasso is let go (which commits the
 * transform, as tapping elsewhere does) and made again on the same area.
 *
 * Returns a filter that keeps only the elements that were selected before, in
 * case the new rectangular lasso also caught neighbours. If the host refuses the
 * lasso calls, nothing is changed and every element is kept.
 */
export async function settleLasso(): Promise<(e: Element) => boolean> {
  const keepAll = () => true;
  try {
    const before = await lassoElements();
    const nums = new Set(before.elements.map(e => e.numInPage));
    const count = before.elements.length;
    release(before.elements);
    const rect = ok<{left: number; top: number; right: number; bottom: number}>(
      await PluginCommAPI.getLassoRect(),
    );
    if (before.error || !rect) {
      return keepAll;
    }
    if (!ok<boolean>(await PluginCommAPI.setLassoBoxState(2))) {
      return keepAll;
    }
    const r = {
      left: Math.floor(rect.left),
      top: Math.floor(rect.top),
      right: Math.ceil(rect.right),
      bottom: Math.ceil(rect.bottom),
    };
    await PluginCommAPI.lassoElements(r);
    const after = await lassoElements();
    const known = after.elements.filter(e => nums.has(e.numInPage)).length;
    release(after.elements);
    // Same elements (numbers kept): keep only those. Numbers changed by the
    // commit: fall back to the whole new selection if it has the same size.
    return known === count || after.elements.length !== count
      ? e => nums.has(e.numInPage)
      : keepAll;
  } catch {
    return keepAll;
  }
}

export const release = (elements: Element[]) =>
  elements.forEach(e => e?.uuid && PluginCommAPI.recycleElement(e.uuid));

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
  // Right after a lasso resize, the host may accept the change but modify none
  // of the elements (they are being re-committed): it then answers success with
  // an empty list. So the result is checked, and the selection re-read and the
  // change applied again, up to three times.
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(r => setTimeout(r, 250));
    }
    const {elements, error} = await lassoElements();
    if (error) {
      return {ok: false, message: error};
    }
    const targets = elements.filter(
      e => (isStroke(e) || isShape(e)) && keep(e),
    );
    release(elements.filter(e => !targets.includes(e)));
    if (!targets.length) {
      return {ok: false, message: 'The selection has no strokes or shapes.'};
    }
    for (const e of targets) {
      restyle(e, change);
    }
    const page =
      ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
    // No explicit layer: the host uses the current layer.
    const res: any = await PluginCommAPI.modifyPageElements(targets, page);
    const changed = ok<number[]>(res);
    if (!changed) {
      release(targets);
      last = `Could not change the selection: ${errorText(res)}`;
      continue;
    }
    if (Array.isArray(changed) && changed.length < targets.length) {
      last = `Only ${changed.length} of ${targets.length} elements were updated.`;
      continue;
    }
    // Modified elements stay referenced by the host: they are not recycled here.
    if (await applied(change, keep)) {
      return {ok: true, message: `${targets.length} elements updated.`};
    }
    // Read back unchanged: apply again; if it still reads back unchanged after
    // the last attempt, trust the host (which reported every element updated).
    last = '';
  }
  return last ? {ok: false, message: last} : {ok: true, message: 'Updated.'};
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
