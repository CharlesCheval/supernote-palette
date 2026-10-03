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
 * The lasso is never let go, made again or otherwise driven by the plugin: doing
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

/** What identifies an element through a move: kind, point count, ink box. */
type Print = {kind: string; n: number; box: Rect};

async function printOf(
  e: Element,
  size: Awaited<ReturnType<typeof pageSize>>,
): Promise<Print | null> {
  const o = await outlineOf(e, size);
  if (!o || !o.points.length) {
    return null;
  }
  let box = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  for (const p of o.points) {
    box = {
      left: Math.min(box.left, p.x),
      top: Math.min(box.top, p.y),
      right: Math.max(box.right, p.x),
      bottom: Math.max(box.bottom, p.y),
    };
  }
  const kind = isShape(e) ? `geo ${e.geometry!.type}` : `type ${e.type}`;
  return {kind, n: o.points.length, box};
}

/** Lets the lasso go and checks it is gone. */
export async function releaseLasso(): Promise<boolean> {
  const call = (work: Promise<any>) => withTimeout(work, 5000, null);
  const gone = async () =>
    !ok<Element[]>(
      await call(PluginCommAPI.getLassoElements() as Promise<any>),
    );
  const res: any = await call(
    PluginCommAPI.setLassoBoxState(2) as Promise<any>,
  );
  if (await gone()) {
    trace('lasso let go: ok');
    return true;
  }
  // Measured (test.25): a lasso made by the plugin is not let go by state 2,
  // but saving the note lets the lasso go (as measured in test.23).
  const saved: any = await call(
    PluginNoteAPI.saveCurrentNote() as Promise<any>,
  );
  const ok2 = await gone();
  trace(
    `lasso let go: state 2 ${
      ok<boolean>(res) ? 'ok' : errorText(res)
    }, still there; save ${saved?.success ? 'ok' : errorText(saved)} → ${
      ok2 ? 'gone' : 'STILL SELECTED'
    }`,
  );
  return ok2;
}

/** How the action finds its elements, once any pending move is applied. */
export type Prepared = {
  /** Keeps only the user's elements (the lasso may also hold neighbours). */
  keep: (e: Element) => boolean;
  /** Neighbours were caught: the lasso is let go once the action is done. */
  extras: boolean;
  error?: string;
};

const keepAll: Prepared = {keep: () => true, extras: false};

/**
 * Before an action: if the lasso holds a pending move or resize (lasso rect ≠
 * preview rect), applies it and finds the same elements again.
 *
 * Measured on a Manta: saving the note applies the move and lets the lasso go;
 * the elements are recreated (new numbers, new uuids) and keep their kind and
 * point count. So: save; lasso the preview rect (where they now are); among
 * what it catches (neighbours too, when the shape was put over other writing),
 * recognise each element by kind, point count and its ink box mapped through
 * the move (old lasso rect → preview rect). The action then changes only
 * those. If any element is not recognised for sure, nothing is changed and the
 * lasso is let go.
 */
export async function prepareSelection(): Promise<Prepared> {
  if (await isPdf()) {
    const fresh = await pdfLassoMismatch();
    if (fresh) {
      return {...keepAll, error: fresh};
    }
  }
  const r = await lassoRects();
  if (!r || !differs(r)) {
    return keepAll;
  }
  if (await isPdf()) {
    return {
      ...keepAll,
      error:
        'Moved or resized in a PDF: tap outside, select it again, then apply.',
    };
  }
  if (Math.abs(r.rotate) > 0.5) {
    return {
      ...keepAll,
      error:
        'The selection was rotated: tap outside, select it again, then apply.',
    };
  }
  const size = await pageSize();
  const before = await lassoElements();
  if (before.error || !before.elements.length) {
    return {...keepAll, error: before.error ?? 'Empty selection.'};
  }
  const sx =
    (r.preview.right - r.preview.left) /
    Math.max(1, r.lasso.right - r.lasso.left);
  const sy =
    (r.preview.bottom - r.preview.top) /
    Math.max(1, r.lasso.bottom - r.lasso.top);
  const map = (b: Rect): Rect => ({
    left: r.preview.left + (b.left - r.lasso.left) * sx,
    top: r.preview.top + (b.top - r.lasso.top) * sy,
    right: r.preview.left + (b.right - r.lasso.left) * sx,
    bottom: r.preview.top + (b.bottom - r.lasso.top) * sy,
  });
  const wanted: Print[] = [];
  for (const e of before.elements) {
    const p = await printOf(e, size);
    if (!p) {
      return {
        ...keepAll,
        error:
          'A selected element could not be read: tap outside, select it again, then apply.',
      };
    }
    wanted.push({...p, box: map(p.box)});
  }
  trace(`moved: ${wanted.length} el. → preview ${fmtRect(r.preview)}`);
  if (!actionLive()) {
    return {...keepAll, error: ABANDONED.message};
  }
  if (!(await ensureWriteAccess())) {
    return {
      ...keepAll,
      error: 'File access denied: the note cannot be saved first.',
    };
  }
  const step = (work: Promise<any>) =>
    withTimeout(work, 5000, {
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
      ...keepAll,
      error: `Not done: the note could not be saved first (${errorText(
        saved,
      )}).`,
    };
  }
  // Saving lets the lasso go (measured); otherwise it is let go here.
  if (
    ok<Element[]>(await step(PluginCommAPI.getLassoElements() as Promise<any>))
  ) {
    if (!(await releaseLasso())) {
      return {...keepAll, error: 'Not done: the lasso could not be let go.'};
    }
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
  const after = await lassoElements();
  trace(
    `lasso ${fmtRect(target)}: ${
      ok<boolean>(lassoed) ? 'ok' : errorText(lassoed)
    } · ${after.error ?? `${after.elements.length} el.`}`,
  );
  const fail = async (why: string): Promise<Prepared> => {
    trace(why);
    if (!after.error) {
      await releaseLasso();
    }
    return {
      ...keepAll,
      error:
        'The move was applied, but the moved elements could not be told apart for sure: select them yourself, then apply.',
    };
  };
  if (after.error || !after.elements.length) {
    return fail('nothing selected');
  }
  // Recognise the wanted elements among those caught, by kind and point count
  // first. When a kind has exactly as many candidates as wanted elements, they
  // are those (no position needed: shapes read from a lasso do not give a
  // reliable position, measured with a circle). Only when neighbours of the
  // same kind and point count were caught too is the position used, with a
  // strict tolerance and a clear winner, else nothing is changed.
  const prints = [];
  for (const e of after.elements) {
    prints.push({e, p: await printOf(e, size)});
  }
  const used = new Set<Element>();
  const groups = new Map<string, Print[]>();
  for (const w of wanted) {
    const key = `${w.kind}|${w.n}`;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  for (const [key, ws] of groups) {
    const cands = prints.filter(c => c.p && `${c.p.kind}|${c.p.n}` === key);
    if (cands.length < ws.length) {
      return fail(`not found: ${ws.length} × ${key} (${cands.length} caught)`);
    }
    if (cands.length === ws.length) {
      cands.forEach(c => used.add(c.e));
      continue;
    }
    for (const w of ws) {
      const tol = Math.max(
        12,
        0.08 * Math.max(w.box.right - w.box.left, w.box.bottom - w.box.top),
      );
      const scored = cands
        .filter(c => !used.has(c.e))
        .map(c => ({
          e: c.e,
          err: Math.max(
            Math.abs(c.p!.box.left - w.box.left),
            Math.abs(c.p!.box.top - w.box.top),
            Math.abs(c.p!.box.right - w.box.right),
            Math.abs(c.p!.box.bottom - w.box.bottom),
          ),
        }))
        .sort((x, y) => x.err - y.err);
      const [first, second] = scored;
      if (!first || first.err > tol) {
        return fail(`not found: ${key} at ${fmtRect(w.box)}`);
      }
      if (second && second.err <= tol && second.err - first.err < 4) {
        return fail(`ambiguous: ${key}`);
      }
      used.add(first.e);
    }
  }
  const extras = after.elements.length > used.size;
  trace(
    `recognised ${used.size}/${wanted.length}${
      extras
        ? ` · ${after.elements.length - used.size} neighbours left alone`
        : ''
    }`,
  );
  const nums = new Set([...used].map(e => e.numInPage));
  return {keep: e => nums.has(e.numInPage), extras};
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
/** How a selection is restyled in a PDF, where the page cannot be modified (see effects). */
export type PdfRestyle = (
  change: StyleChange,
  prep: Prepared,
) => Promise<{ok: boolean; message: string}>;

export async function applyStyle(
  change: StyleChange,
  onReady: () => void = () => {},
  pdfRestyle?: PdfRestyle,
): Promise<{ok: boolean; message: string}> {
  traceStart(
    'width' in change ? `Width ${change.width}` : `Colour ${change.color}`,
  );
  const prep = await prepareSelection();
  if (prep.error) {
    return {ok: false, message: prep.error};
  }
  const res = await applyPrepared(change, prep, onReady, pdfRestyle);
  if (prep.extras) {
    // Neighbours were caught by the reselection: nothing stays selected.
    await releaseLasso();
  }
  return res;
}

async function applyPrepared(
  change: StyleChange,
  prep: Prepared,
  onReady: () => void,
  pdfRestyle?: PdfRestyle,
): Promise<{ok: boolean; message: string}> {
  const summary = await readSummary();
  onReady();
  let viaLassoRefused909 = false;
  if (
    !prep.extras &&
    !summary.error &&
    lassoRoute(summary.strokes, summary.shapes)
  ) {
    const viaLasso = await applyToLassoShape(change);
    // In a PDF the lasso route can be refused: the page route is tried next.
    if (viaLasso.ok || viaLasso === ABANDONED) {
      return viaLasso;
    }
    viaLassoRefused909 = /code 909/.test(viaLasso.message);
    trace(`lasso shape: ${viaLasso.message} → page route`);
  }
  if (await isPdf()) {
    if (viaLassoRefused909) {
      return {ok: false, message: PDF_RESELECT};
    }
    return pdfRestyle
      ? pdfRestyle(change, prep)
      : {ok: false, message: PDF_LIMIT};
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
  const targets = elements.filter(
    e => (isStroke(e) || isShape(e)) && prep.keep(e),
  );
  if (!targets.length) {
    return {ok: false, message: 'The selection has no strokes or shapes.'};
  }
  for (const e of targets) {
    restyle(e, change);
    forPageWrite(e);
  }
  const page =
    ok<number>(await PluginCommAPI.getCurrentPageNum()) ?? targets[0].pageNum;
  if (!actionLive()) {
    trace('abandoned: panel opened again');
    return ABANDONED;
  }
  // No explicit layer: the host uses the current layer.
  let res: any = await PluginCommAPI.modifyPageElements(targets, page);
  if (modifiedCount(res) === 0) {
    // Seen in PDFs: nothing modified. What the elements say about themselves,
    // then one more try with their own page and layer.
    const e0 = targets[0];
    trace(
      `0 modified · page ${page} · el. #${targets
        .map(e => e.numInPage)
        .join(',')} page ${e0.pageNum} layer ${e0.layerNum}`,
    );
    if (e0.pageNum !== page || e0.layerNum != null) {
      res = await PluginCommAPI.modifyPageElements(
        targets,
        e0.pageNum,
        e0.layerNum != null && e0.layerNum >= 0 ? e0.layerNum : null,
      );
      trace(`retry (own page/layer) → ${modifiedCount(res) ?? errorText(res)}`);
    }
  }
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
  if (!prep.extras) {
    trace(`read back: ${(await applied(change)) ? 'changed' : 'unchanged'}`);
  }
  return {ok: true, message: `${targets.length} elements updated.`};
}

/**
 * PDFs (measured on a Manta, test.43–44): modifyPageElements changes nothing
 * (0 modified, with the element's own page and layer too), deleting and
 * letting the lasso go are unreliable, and the page was left in a strange state
 * (a selection box reaching far off the page). In a PDF only what works is
 * offered: one lassoed shape (lasso route), fills and hatching.
 */
export async function isPdf(): Promise<boolean> {
  const path = ok<string>(await PluginCommAPI.getCurrentFilePath());
  return typeof path === 'string' && path.toLowerCase().endsWith('.pdf');
}

export const PDF_LIMIT =
  'In a PDF, width and colour can only be changed on a single shape: other changes are not reliable there.';

/**
 * PDFs (measured, test.45–46): right after Snap draws a shape, its lasso reads
 * as one shape but its points are not where the shape is (hatching came out
 * outside, at the wrong size; the outline could vanish), and
 * modifyLassoGeometry refuses it (code 909). Lassoed again by hand, all is
 * right. Counting the lasso's geometries did not tell them apart (test.46):
 * the read shape is checked against the lasso rect instead, and refused when
 * it does not lie inside it.
 */
async function pdfLassoMismatch(): Promise<string | undefined> {
  const rect = ok<Rect>(
    await withTimeout(PluginCommAPI.getLassoRect() as Promise<any>, 3000, null),
  );
  const {elements, error} = await lassoElements();
  if (!rect || error || !elements.length) {
    return undefined; // reported by the action itself
  }
  const size = await pageSize();
  const slack = Math.max(
    30,
    0.15 * Math.max(rect.right - rect.left, rect.bottom - rect.top),
  );
  for (const e of elements.filter(x => isStroke(x) || isShape(x))) {
    const p = await printOf(e, size);
    if (!p) {
      continue;
    }
    const inside =
      p.box.left >= rect.left - slack &&
      p.box.top >= rect.top - slack &&
      p.box.right <= rect.right + slack &&
      p.box.bottom <= rect.bottom + slack;
    if (!inside) {
      trace(`pdf: ${p.kind} at ${fmtRect(p.box)} ∉ lasso ${fmtRect(rect)}`);
      return PDF_RESELECT;
    }
  }
  return undefined;
}

export const PDF_RESELECT =
  'In a PDF, the selection left by Snap is not reliable: tap outside, select the shape again with the lasso, then apply.';

/** How many elements modifyPageElements reports changed (null if unknown). */
function modifiedCount(res: any): number | null {
  const r = ok<number[]>(res);
  return Array.isArray(r) ? r.length : null;
}

/**
 * Circles and ellipses read from the page hold TWICE their radius in the radius
 * fields (measured: hatching came out twice too big), while modifyPageElements
 * takes them as radii: written back unchanged, circles doubled in size when
 * several shapes were restyled together. They are halved before writing.
 */
export function forPageWrite(e: Element) {
  const g: any = e.geometry;
  if (g && (g.type === 'GEO_circle' || g.type === 'GEO_ellipse')) {
    g.ellipseMajorAxisRadius = g.ellipseMajorAxisRadius / 2;
    g.ellipseMinorAxisRadius = g.ellipseMinorAxisRadius / 2;
  }
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
