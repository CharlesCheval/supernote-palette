import type {FillStyle} from './effects';
import type {DashStyle} from './patterns';

/**
 * Several changes picked in the panel, applied together (a long press on an
 * option starts picking; Apply runs them). One choice per row: picking another
 * option of the same row replaces it, picking the same one again drops it.
 */
export type Plan = {
  width?: number;
  color?: number;
  fill?: FillStyle;
  hatch?: FillStyle;
  dash?: DashStyle;
};
export type PlanKey = keyof Plan;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function toggle<K extends PlanKey>(
  plan: Plan,
  key: K,
  value: NonNullable<Plan[K]>,
): Plan {
  const next = {...plan};
  if (same(plan[key], value)) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

export const isPicked = <K extends PlanKey>(
  plan: Plan | null,
  key: K,
  value: Plan[K],
) => !!plan && plan[key] !== undefined && same(plan[key], value);

/**
 * The order the changes are applied in, whatever the order they were picked:
 * - width and colour first, so the fill fits the final outline and the dashes
 *   take the final width and colour;
 * - fill before hatching, so the hatching shows on top of it;
 * - dashes last: they replace the originals (the selection is gone after
 *   them), and a fill or hatching would leak through their gaps.
 */
export const ORDER: PlanKey[] = ['width', 'color', 'fill', 'hatch', 'dash'];

export function steps(plan: Plan): PlanKey[] {
  return ORDER.filter(k => plan[k] !== undefined);
}
