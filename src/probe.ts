import {
  Element,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
} from 'sn-plugin-lib';
import {errorText, ok, outlineOf, pageSize, withTimeout} from './outline';
import {range} from './patterns';

/**
 * Test builds only: a read-only probe of what the host reports about the lasso,
 * to understand how a moved or resized selection behaves on the device. It
 * never changes the page or the lasso: only getters, a lasso preview image
 * written in the plugin's own folder, and the touch gestures seen meanwhile.
 */

type Rect = {left: number; top: number; right: number; bottom: number};

export type Snapshot = {n: number; lines: string[]; image: string | null};

let snapshots: Snapshot[] = [];
let count = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

export const getSnapshots = () => snapshots;
export function subscribeProbe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function clearProbe() {
  snapshots = [];
  gestures = [];
  notify();
}

// ---------------------------------------------------------------------------
// Touch gestures (finger or pen), recorded between probes
// ---------------------------------------------------------------------------

type Gesture = {
  tool: string;
  pointers: number;
  from: {x: number; y: number};
  to: {x: number; y: number};
  ms: number;
};

let gestures: Gesture[] = [];
let open: (Gesture & {t0: number}) | null = null;

const TOOLS: Record<number, string> = {1: 'finger', 2: 'pen'};

export function feedMotion(e: any) {
  if (!e || typeof e.action !== 'number') {
    return;
  }
  const action = e.action % 256; // low byte: the action, without the pointer index
  const at = {x: Math.round(e.x), y: Math.round(e.y)};
  const pointers = typeof e.pointerCount === 'number' ? e.pointerCount : 1;
  if (action === 0) {
    open = {
      tool: TOOLS[e.toolType] ?? `tool ${e.toolType}`,
      pointers,
      from: at,
      to: at,
      ms: 0,
      t0: e.eventTime ?? Date.now(),
    };
    return;
  }
  if (!open) {
    return;
  }
  open.pointers = Math.max(open.pointers, pointers);
  open.to = at;
  if (action === 1 || action === 3) {
    const {t0, ...g} = open;
    g.ms = Math.round((e.eventTime ?? Date.now()) - t0);
    gestures = [...gestures, g].slice(-6);
    open = null;
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const MS = 3000;
const fmt = (r: Rect | null | undefined) =>
  r
    ? `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(
        r.right,
      )},${Math.round(r.bottom)}`
    : 'none';

async function inkOf(
  e: Element,
  size: Awaited<ReturnType<typeof pageSize>>,
): Promise<{box: Rect | null; n: number}> {
  const o = await outlineOf(e, size);
  if (!o || !o.points.length) {
    return {box: null, n: 0};
  }
  const xs = range(o.points.map(p => p.x));
  const ys = range(o.points.map(p => p.y));
  return {
    box: {left: xs.min, top: ys.min, right: xs.max, bottom: ys.max},
    n: o.points.length,
  };
}

function describe(e: Element, ink: {box: Rect | null; n: number}): string {
  const kind = e.geometry ? `geo ${e.geometry.type}` : `type ${e.type}`;
  return `#${e.numInPage} ${String(e.uuid).slice(0, 6)} ${kind} w${
    e.thickness
  } n${ink.n} ink ${fmt(ink.box)}`;
}

const call = (p: Promise<any> | any) =>
  withTimeout(Promise.resolve(p), MS, {
    success: false,
    error: {message: 'timeout', code: '-'},
  });

export async function probe(): Promise<void> {
  const n = ++count;
  const lines: string[] = [];
  const time = new Date().toTimeString().slice(0, 8);
  const size = await pageSize();

  const rect = await call(PluginCommAPI.getLassoRect());
  lines.push(
    `P${n} ${time} · page ${
      size ? `${size.width}×${size.height}` : '?'
    } · lasso rect ${ok<Rect>(rect) ? fmt(ok<Rect>(rect)) : errorText(rect)}`,
  );

  // The preview the host renders for the lasso: its own rect and rotation.
  let image: string | null = null;
  const dir = await PluginManager.getPluginDirPath();
  if (dir) {
    const path = `${dir}/probe-${n}.png`;
    const prev = await call(PluginCommAPI.generateLassoPreview(path));
    const p = ok<{imagePath: string; rect: Rect; rotateDegree: number}>(prev);
    lines.push(
      p
        ? `preview rect ${fmt(p.rect)} · rotate ${p.rotateDegree}`
        : `preview: ${errorText(prev)}`,
    );
    image = p ? p.imagePath || path : null;
  }

  const types = ok<Record<string, number>>(
    await call(PluginCommAPI.getLassoElementTypeCounts()),
  );
  if (types) {
    const nonzero = Object.entries(types)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k.replace(/Num$/, '')} ${v}`);
    lines.push(`types: ${nonzero.join(', ') || 'none'}`);
  }

  PluginCommAPI.clearElementCache();
  const els = await call(PluginCommAPI.getLassoElements());
  const elements = ok<Element[]>(els);
  if (elements) {
    let all: Rect | null = null;
    const shown: string[] = [];
    for (const [i, e] of elements.entries()) {
      const ink = await inkOf(e, size);
      if (ink.box) {
        all = all
          ? {
              left: Math.min(all.left, ink.box.left),
              top: Math.min(all.top, ink.box.top),
              right: Math.max(all.right, ink.box.right),
              bottom: Math.max(all.bottom, ink.box.bottom),
            }
          : ink.box;
      }
      if (i < 2) {
        shown.push(describe(e, ink));
      }
    }
    lines.push(`elements ${elements.length} · all ink ${fmt(all)}`);
    lines.push(...shown.map(s => `  ${s}`));
  } else {
    lines.push(`elements: ${errorText(els)}`);
  }

  const geos = ok<any[]>(await call(PluginCommAPI.getLassoGeometries()));
  if (geos?.length) {
    const g = geos[0];
    const pts: {x: number; y: number}[] = Array.isArray(g.points)
      ? g.points
      : [];
    const xs = range(pts.map(p => p.x));
    const ys = range(pts.map(p => p.y));
    lines.push(
      `geometries ${geos.length} · ${g.type} ${
        pts.length
          ? fmt({left: xs.min, top: ys.min, right: xs.max, bottom: ys.max})
          : g.ellipseCenterPoint
          ? `centre ${Math.round(g.ellipseCenterPoint.x)},${Math.round(
              g.ellipseCenterPoint.y,
            )}`
          : ''
      }`,
    );
  }

  PluginCommAPI.clearElementCache();
  const last = await call(PluginFileAPI.getLastElement());
  const lastEl = ok<Element>(last);
  lines.push(
    lastEl
      ? `last on page: ${describe(lastEl, await inkOf(lastEl, size))}`
      : `last on page: ${errorText(last)}`,
  );

  lines.push(
    gestures.length
      ? `gestures: ${gestures
          .map(
            g =>
              `${g.tool}${g.pointers > 1 ? `×${g.pointers}` : ''} ${g.from.x},${
                g.from.y
              }→${g.to.x},${g.to.y} ${g.ms}ms`,
          )
          .join(' | ')}`
      : 'gestures: none seen',
  );
  gestures = [];

  snapshots = [...snapshots, {n, lines, image}].slice(-3);
  notify();
}
