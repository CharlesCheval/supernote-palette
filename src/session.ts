/**
 * Panel openings and the action running in each.
 *
 * While the panel is hidden, the host may hold back the plugin's timers and
 * calls: an action started before closing could then resume only when the panel
 * is opened again, and change the page under a NEW selection (which dropped it).
 * Each opening abandons the action still running: it must check `actionLive()`
 * right before every change to the page.
 */

let opening = 0;
let action = -1;

/** A new opening of the panel: any action still running is abandoned. */
export function newOpening() {
  opening++;
}

/** An action starts in the current opening. */
export function startAction() {
  action = opening;
}

/** Whether the running action may still change the page. */
export const actionLive = () => action === opening;

export const ABANDONED = {
  ok: false,
  message: 'Stopped: the panel was opened again.',
};
