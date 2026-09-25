/**
 * Pen sizes as shown in Supernote's pen menu (mm), and the internal width the
 * host stores for them (`Element.thickness`, `Geometry.penWidth`).
 *
 * The SDK does not document the unit, and it is not linear. These values were
 * read on a Manta (firmware 3.29 beta) by drawing with each pen size.
 * 0.3 and 0.4 are interpolated from the neighbouring steps.
 */
export const PEN_SIZES: ReadonlyArray<{mm: number; internal: number}> = [
  {mm: 0.1, internal: 200},
  {mm: 0.2, internal: 300},
  {mm: 0.3, internal: 400},
  {mm: 0.4, internal: 500},
  {mm: 0.5, internal: 600},
  {mm: 0.6, internal: 700},
  {mm: 0.7, internal: 900},
  {mm: 0.8, internal: 1000},
  {mm: 0.9, internal: 1100},
  {mm: 1.0, internal: 1200},
  {mm: 1.5, internal: 1800},
  {mm: 2.0, internal: 2400},
];

export const PRESETS_MM = PEN_SIZES.map(s => s.mm);

/** Minimum width accepted by the SDK. */
export const MIN_INTERNAL = 100;

export function toInternal(mm: number): number {
  const exact = PEN_SIZES.find(s => s.mm === mm);
  if (exact) {
    return exact.internal;
  }
  // Between table entries: interpolate linearly.
  const hi = PEN_SIZES.findIndex(s => s.mm > mm);
  if (hi <= 0) {
    return hi === 0 ? Math.max(MIN_INTERNAL, PEN_SIZES[0].internal) : PEN_SIZES[PEN_SIZES.length - 1].internal;
  }
  const a = PEN_SIZES[hi - 1];
  const b = PEN_SIZES[hi];
  return Math.round(a.internal + ((mm - a.mm) / (b.mm - a.mm)) * (b.internal - a.internal));
}

/** Pen size label for an internal width: "0.3", or "≈0.3" when it is not an exact pen size. */
export function formatMm(internal: number): string {
  let best = PEN_SIZES[0];
  for (const s of PEN_SIZES) {
    if (Math.abs(s.internal - internal) < Math.abs(best.internal - internal)) {
      best = s;
    }
  }
  return `${best.internal === internal ? '' : '≈'}${best.mm.toFixed(1)}`;
}

/** "0.3" for a uniform selection, "0.3–0.8" for a mixed one. */
export function describeRange(widths: number[]): string {
  const valid = widths.filter(w => w > 0);
  if (!valid.length) {
    return '—';
  }
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  return lo === hi ? formatMm(lo) : `${formatMm(lo)}–${formatMm(hi)}`;
}
