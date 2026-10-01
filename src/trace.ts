/**
 * What the last action did, step by step, shown in small print in the panel:
 * the lasso and the page behave in ways the SDK does not document, and this is
 * how they are checked on the device.
 */

let lines: string[] = [];
const listeners = new Set<() => void>();

export function traceStart(action: string) {
  lines = [action];
  listeners.forEach(fn => fn());
}

export function trace(step: string) {
  lines = [...lines, step].slice(-12);
  listeners.forEach(fn => fn());
}

export const getTrace = () => lines;

export function subscribeTrace(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
