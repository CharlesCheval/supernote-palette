/**
 * Pen sizes as shown in Supernote's pen menu (mm), and the internal width the
 * host stores for them (`Element.thickness`, `Geometry.penWidth`).
 *
 * The SDK does not document the unit, and it is not linear. These values were
 * read on a Manta (firmware 3.29 beta) by drawing with each pen size.
 * 0.3 and 0.4 are interpolated from the neighbouring steps; 2.5 to 3.5 go beyond
 * the pen menu and are extrapolated (+600 per 0.5 mm, as from 1.5 to 2.0).
 */
export const PEN_SIZES: ReadonlyArray<{mm: number; internal: number; extrapolated?: boolean}> = [
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
  {mm: 2.5, internal: 3000, extrapolated: true},
  {mm: 3.0, internal: 3600, extrapolated: true},
  {mm: 3.5, internal: 4200, extrapolated: true},
];

export const PRESETS_MM = PEN_SIZES.map(s => s.mm);

/**
 * The same width is not drawn the same by every pen. Measured on a Manta with
 * four strokes set to 3.5 (4200): needle point 33.5 px, ink pen 20.4 px (its
 * points carry pressure, which thins the line), marker 32.9 px (diagonal),
 * calligraphy 8.2 px (varies with direction).
 * Strokes of these pen types get their width multiplied so that they look like
 * the needle point at the chosen size. Other pens are left at ×1.
 * Keys are Stroke.penType values: 1 = pressure pen (SDK), 16 = ink pen (measured).
 */
export const PEN_WIDTH_FACTORS: Readonly<Record<number, number>> = {1: 1.64, 16: 1.64};

export const widthFactor = (penType: number | undefined) =>
  (penType !== undefined && PEN_WIDTH_FACTORS[penType]) || 1;

/** Width to store on a stroke of `penType` so that it looks like the needle point at `internal`. */
export const forPen = (internal: number, penType: number | undefined) =>
  Math.round(internal * widthFactor(penType));

/** The needle-point-equivalent width of a stroke of `penType` stored at `stored`. */
export const asNeedle = (stored: number, penType: number | undefined) =>
  Math.round(stored / widthFactor(penType));

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
