import {
  Element,
  PluginCommAPI,
  PluginManager,
  PluginNoteAPI,
} from 'sn-plugin-lib';
import {
  errorText,
  isShape,
  isStroke,
  ok,
  outlineOf,
  pageSize,
  withTimeout,
} from './outline';
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
  /** The selection was moved or resized and is still held by the lasso. */
  moved: boolean;
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

type Rect = {left: number; top: number; right: number; bottom: number};

export const MOVED_MESSAGE =
  'The selection was moved or resized: use "Apply move & reselect", or tap outside and select it again.';

type Rects = {lasso: Rect; preview: Rect; rotate: number};

/** The lasso rect and the lasso preview's rect, or null when either cannot be read. */
async function lassoRects(): Promise<Rects | null> {
  try {
    const dir = await PluginManager.getPluginDirPath();
    if (!dir) {
      return null;
    }
    const [rect, preview] = await Promise.all([
      withTimeout(PluginCommAPI.getLassoRect() as Promise<any>, 3000, null),
      withTimeout(
        PluginCommAPI.generateLassoPreview(
          `${dir}/lasso-check.png`,
        ) as Promise<any>,
        3000,
        null,
      ),
    ]);
    const a = ok<Rect>(rect);
    const b = ok<{rect: Rect; rotateDegree: number}>(preview);
    return a && b?.rect
      ? {lasso: a, preview: b.rect, rotate: b.rotateDegree || 0}
      : null;
  } catch {
    return null;
  }
}

const fmtRect = (r: Rect) =>
  `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(
    r.right,
  )},${Math.round(r.bottom)}`;

const differs = (r: Rects) =>
  Math.abs(r.lasso.left - r.preview.left) > 4 ||
  Math.abs(r.lasso.top - r.preview.top) > 4 ||
  Math.abs(r.lasso.right - r.preview.right) > 4 ||
  Math.abs(r.lasso.bottom - r.preview.bottom) > 4 ||
  Math.abs(r.rotate) > 0.5;

/**
 * Whether the lasso holds a move or resize not yet applied to the page.
 *
 * Measured with the probe (test.21): while a transform is pending, the lasso
 * rect and the elements read still describe the selection BEFORE it, and
 * whatever is changed on the page is overwritten by the host's own transformed
 * copy when the lasso is let go. Only the lasso PREVIEW follows the transform:
 * its rect is the new one. So the two rects are compared, read only.
 */
export async function lassoMoved(): Promise<boolean> {
  const r = await lassoRects();
  if (!r) {
    return false; // cannot tell: act as before
  }
  const moved = differs(r);
  trace(
    `lasso ${fmtRect(r.lasso)} · preview ${fmtRect(r.preview)}${
      moved ? ' · MOVED' : ''
    }`,
  );
  return moved;
}

/** Strokes and each geometry type, counted: what a move must keep. */
function makeup(elements: Element[]): string {
  const counts = new Map<string, number>();
  for (const e of elements) {
    const k = isShape(e) ? `geo ${e.geometry!.type}` : `type ${e.type}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort()
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

/**
 * On request only (a button shown when a move is pending): applies the pending
 * move or resize and selects the same elements again, as the user would by
 * tapping outside and lassoing them. Unlike test builds 16-19, which lassoed
 * the OLD box and changed elements found on the page outside any lasso, this:
 * 1. saves the note first, so a problem cannot cost more than the last action;
 * 2. lets the lasso go (the host applies the transform), then lassoes the
 *    preview rect, which is where the selection now is;
 * 3. checks the new selection: same number and kinds of elements, ink inside
 *    that rect. Otherwise the lasso is let go and nothing else is done.
 * It never changes an element: the style is applied afterwards, by the usual
 * route, on a normal selection.
 */
export async function commitMove(): Promise<{ok: boolean; message: string}> {
  traceStart('Apply move & reselect');
  const r = await lassoRects();
  if (!r || !differs(r)) {
    return {ok: true, message: 'No pending move: nothing to do.'};
  }
  const before = await lassoElements();
  if (before.error || !before.elements.length) {
    return {ok: false, message: before.error ?? 'Empty selection.'};
  }
  const expected = makeup(before.elements);
  trace(`before: ${expected} · preview ${fmtRect(r.preview)}`);
  if (!actionLive()) {
    return ABANDONED;
  }
  if (!(await ensureWriteAccess())) {
    return {
      ok: false,
      message: 'File access denied: the note cannot be saved first.',
    };
  }
  const step = <T>(work: Promise<T>) =>
    withTimeout(work as Promise<any>, 5000, {
      success: false,
      error: {message: 'timeout', code: '-'},
    });
  const saved: any = await step(
    PluginNoteAPI.saveCurrentNote() as Promise<any>,
  );
  trace(
    `save: ${
      saved?.success && saved.result !== false ? 'ok' : errorText(saved)
    }`,
  );
  if (!saved?.success || saved.result === false) {
    return {
      ok: false,
      message: `Not done: the note could not be saved first (${errorText(
        saved,
      )}).`,
    };
  }
  // Measured (test.23): saving applies the pending move and lets the lasso go
  // by itself. The lasso is let go here only if it is still there.
  const still: any = await step(
    PluginCommAPI.getLassoElements() as Promise<any>,
  );
  if (ok<Element[]>(still)) {
    const letGo: any = await step(
      PluginCommAPI.setLassoBoxState(2) as Promise<any>,
    );
    trace(`let go: ${ok<boolean>(letGo) ? 'ok' : errorText(letGo)}`);
    if (!ok<boolean>(letGo)) {
      return {ok: false, message: `Not done: ${errorText(letGo)}`};
    }
  } else {
    trace('lasso already let go by the save');
  }
  const target = {
    left: Math.floor(r.preview.left),
    top: Math.floor(r.preview.top),
    right: Math.ceil(r.preview.right),
    bottom: Math.ceil(r.preview.bottom),
  };
  const lassoed: any = await step(
    PluginCommAPI.lassoElements(target) as Promise<any>,
  );
  trace(
    `lasso ${fmtRect(target)}: ${
      ok<boolean>(lassoed) ? 'ok' : errorText(lassoed)
    }`,
  );
  const after = await lassoElements();
  const got = makeup(after.elements);
  const size = await pageSize();
  let inside = after.elements.length > 0;
  for (const e of after.elements) {
    const o = await outlineOf(e, size);
    if (
      !o ||
      o.points.some(
        p =>
          p.x < target.left - 8 ||
          p.x > target.right + 8 ||
          p.y < target.top - 8 ||
          p.y > target.bottom + 8,
      )
    ) {
      inside = false;
      break;
    }
  }
  trace(`after: ${after.error ?? got}${inside ? '' : ' · ink outside'}`);
  if (after.error || got !== expected || !inside) {
    // Not exactly the same selection: nothing is selected rather than a wrong one.
    await PluginCommAPI.setLassoBoxState(2);
    return {
      ok: false,
      message:
        'Move applied, but the selection could not be made again exactly: select it yourself.',
    };
  }
  return {
    ok: true,
    message: 'Move applied and selected again: choose the change.',
  };
}

export async function readSummary(): Promise<Summary> {
  const [{elements, error}, pen, moved] = await Promise.all([
    lassoElements(),
    PluginCommAPI.getPenInfo(),
    lassoMoved(),
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
    moved,
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
  if (summary.moved) {
    return {ok: false, message: MOVED_MESSAGE};
  }
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
