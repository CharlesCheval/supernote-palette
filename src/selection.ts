import {
  Element,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
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

const fmt = (r: Rect | null) =>
  r
    ? `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(
        r.right,
      )},${Math.round(r.bottom)}`
    : 'none';

/** Bounding box of the elements' ink, or null when none can be read. */
async function inkBox(
  elements: Element[],
  size: Awaited<ReturnType<typeof pageSize>>,
): Promise<Rect | null> {
  const pts = [];
  for (const e of elements) {
    const o = await outlineOf(e, size);
    if (o) {
      pts.push(...o.points);
    }
  }
  if (!pts.length) {
    return null;
  }
  const xs = range(pts.map(p => p.x));
  const ys = range(pts.map(p => p.y));
  return {left: xs.min, top: ys.min, right: xs.max, bottom: ys.max};
}

/** Elements of the current page, by number, read fresh from the note. */
export async function pageElements(
  nums: number[],
): Promise<{elements: Element[]; error?: string}> {
  const path = ok<string>(await PluginCommAPI.getCurrentFilePath());
  const page = ok<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || page == null) {
    trace(`page read: no ${path ? 'page' : 'file path'}`);
    return {elements: [], error: 'Could not read the page.'};
  }
  PluginCommAPI.clearElementCache();
  if (nums.length > 30) {
    // Many elements: one read of the whole page beats one call each.
    const wanted = new Set(nums);
    const all =
      ok<Element[]>(
        await withTimeout(
          PluginFileAPI.getElements(page, path) as Promise<any>,
          4 * LASSO_CALL_MS,
          null,
        ),
      ) ?? [];
    const elements = all.filter(e => wanted.has(e.numInPage));
    return elements.length
      ? {elements}
      : {
          elements: [],
          error: 'The selected elements were not found on the page.',
        };
  }
  const elements: Element[] = [];
  let why = '';
  for (const n of nums) {
    const res: any = await withTimeout(
      PluginFileAPI.getElement(path, page, n) as Promise<any>,
      LASSO_CALL_MS,
      null,
    );
    const e = ok<Element>(res);
    if (e) {
      elements.push(e);
    } else {
      why = errorText(res);
    }
  }
  trace(
    `page read p${page}: ${elements.length}/${nums.length}${
      why ? ` · ${why}` : ''
    } · uuids ${elements
      .slice(0, 3)
      .map(e => String(e.uuid).slice(0, 6))
      .join(',')}`,
  );
  return elements.length
    ? {elements}
    : {
        elements: [],
        error: 'The selected elements were not found on the page.',
      };
}

/** Every element number of the current page. */
async function pageNumbers(): Promise<number[]> {
  const path = ok<string>(await PluginCommAPI.getCurrentFilePath());
  const page = ok<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || page == null) {
    return [];
  }
  return (
    ok<number[]>(
      await withTimeout(
        PluginFileAPI.getElementNumList(path, page) as Promise<any>,
        LASSO_CALL_MS,
        null,
      ),
    ) ?? []
  );
}

/** Where the action finds its elements once the lasso is settled. */
export type Settled = {
  /** Keeps only the elements selected by the user (a re-lasso may catch neighbours). */
  keep: (e: Element) => boolean;
  /** Whether the lasso holds the selection: if not, `read` reads the page. */
  lassoed: boolean;
  read: () => Promise<{elements: Element[]; error?: string}>;
};

/**
 * After a lasso move or resize, while the shape is still selected, the host
 * keeps the transform pending in the lasso with its own copy of the elements,
 * and writes that copy back when the lasso is let go: a change made to the page
 * meanwhile was silently lost. Worse, everything read through the SDK (the
 * elements AND the lasso box) still describes the shape BEFORE the transform,
 * so a pending transform cannot be detected, nor its new place known.
 *
 * So before every action the lasso is let go (committing any transform, as
 * tapping elsewhere does), the selected elements are found again on the page
 * (by number, checked by uuid or by type and point count, else among the
 * newest elements), and the lasso is made again around their ink as it now is.
 * If that last step fails, the action works on the page elements directly.
 */
export async function settleLasso(): Promise<Settled> {
  const keepAll: Settled = {
    keep: () => true,
    lassoed: true,
    read: lassoElements,
  };
  try {
    const before = await withTimeout(lassoElements(), LASSO_CALL_MS, {
      elements: [],
      error: 'timeout',
    });
    if (before.error || !before.elements.length) {
      trace(`lasso: ${before.error ?? 'empty'}`);
      return keepAll;
    }
    const size = await pageSize();
    const box = ok<Rect>(
      await withTimeout(
        PluginCommAPI.getLassoRect() as Promise<any>,
        LASSO_CALL_MS,
        null,
      ),
    );
    // What identifies each selected element once the lasso is let go.
    const uuids = new Set(before.elements.map(e => e.uuid));
    const prints = new Map<string, number>();
    for (const e of before.elements) {
      const o = await outlineOf(e, size);
      const key = `${e.type}:${o?.points.length ?? 0}`;
      prints.set(key, (prints.get(key) ?? 0) + 1);
    }
    const nums = before.elements.map(e => e.numInPage);
    const count = nums.length;
    trace(
      `lasso: ${count} el. #${nums.join(',')} · box ${fmt(box)} · ink ${fmt(
        await inkBox(before.elements, size),
      )}`,
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
      trace('lasso could not be let go: left as is');
      return keepAll;
    }

    // No transform pending: the lasso made again on its own box holds the
    // same elements (what worked before). Checked by uuid or number.
    const nums0 = new Set(nums);
    const same = (e: Element) => uuids.has(e.uuid) || nums0.has(e.numInPage);
    if (box && (!size || box.right <= 1.3 * size.width)) {
      await withTimeout(
        PluginCommAPI.lassoElements({
          left: Math.floor(box.left),
          top: Math.floor(box.top),
          right: Math.ceil(box.right),
          bottom: Math.ceil(box.bottom),
        }) as Promise<any>,
        LASSO_CALL_MS,
        null,
      );
      const again = await withTimeout(lassoElements(), LASSO_CALL_MS, {
        elements: [],
        error: 'timeout',
      });
      const kept = again.elements.filter(same).length;
      trace(
        `re-lasso on box: ${
          again.error ?? `${again.elements.length} el., ${kept} selected before`
        }`,
      );
      if (kept > 0) {
        return {keep: same, lassoed: true, read: lassoElements};
      }
    }

    // Moved: find the selected elements again on the page.
    const matches = async (candidates: number[]) => {
      const {elements} = await pageElements(candidates);
      // By uuid first; then, for what is still missing, by type and point
      // count (strokes only: a long stroke's point count is a good fingerprint).
      const found = elements.filter(e => uuids.has(e.uuid));
      const left = new Map(prints);
      for (const e of found) {
        const o = await outlineOf(e, size);
        const key = `${e.type}:${o?.points.length ?? 0}`;
        left.set(key, (left.get(key) ?? 0) - 1);
      }
      for (const e of elements) {
        if (found.length >= count) {
          break;
        }
        if (uuids.has(e.uuid) || !isStroke(e)) {
          continue;
        }
        const o = await outlineOf(e, size);
        const n = o?.points.length ?? 0;
        const key = `${e.type}:${n}`;
        if (n >= 10 && (left.get(key) ?? 0) > 0) {
          left.set(key, left.get(key)! - 1);
          found.push(e);
        }
      }
      return found;
    };
    let found = await matches(nums);
    let where = 'same numbers';
    if (found.length < count) {
      // Renumbered by the commit: look among the newest elements.
      const all = await pageNumbers();
      const newest = all.slice(-(2 * count + 4));
      found = await matches([...new Set([...nums, ...newest])]);
      where = 'newest';
    }
    const foundNums = new Set(found.map(e => e.numInPage));
    const ink = await inkBox(found, size);
    trace(
      `found ${found.length}/${count} (${where}) #${[...foundNums].join(
        ',',
      )} · ink ${fmt(ink)}`,
    );
    if (!found.length || !ink) {
      return {
        keep: () => false,
        lassoed: false,
        read: async () => ({
          elements: [],
          error: 'The selection was lost after the move: select it again.',
        }),
      };
    }
    const keep = (e: Element) => foundNums.has(e.numInPage);
    const fromPage: Settled = {
      keep,
      lassoed: false,
      read: () => pageElements([...foundNums]),
    };
    if (!actionLive()) {
      return fromPage;
    }
    // Lasso made again around the ink as it now is.
    const pad = 6;
    await withTimeout(
      PluginCommAPI.lassoElements({
        left: Math.max(0, Math.floor(ink.left - pad)),
        top: Math.max(0, Math.floor(ink.top - pad)),
        right: Math.ceil(ink.right + pad),
        bottom: Math.ceil(ink.bottom + pad),
      }) as Promise<any>,
      LASSO_CALL_MS,
      null,
    );
    const after = await withTimeout(lassoElements(), LASSO_CALL_MS, {
      elements: [],
      error: 'timeout',
    });
    const known = after.elements.filter(keep).length;
    trace(
      `re-lasso: ${
        after.error ?? `${after.elements.length} el., ${known} selected before`
      }`,
    );
    return known > 0 ? {keep, lassoed: true, read: lassoElements} : fromPage;
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
  const settled = await settleLasso();
  const {keep} = settled;
  if (settled.lassoed) {
    const summary = await readSummary();
    if (!summary.error && lassoRoute(summary.strokes, summary.shapes)) {
      onReady();
      return applyToLassoShape(change);
    }
  }
  onReady();
  if (!(await ensureWriteAccess())) {
    return {
      ok: false,
      message:
        'File access denied: allow it ("Always allow") to change the selection.',
    };
  }
  // One attempt only. Retrying (with a pause) could run after the panel had
  // closed and resume when it was opened again, dropping the new selection.
  const {elements, error} = await settled.read();
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
  if (settled.lassoed) {
    trace(
      `read back: ${(await applied(change, keep)) ? 'changed' : 'unchanged'}`,
    );
  }
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
