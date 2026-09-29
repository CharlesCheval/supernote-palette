import {FileUtils, PluginManager} from 'sn-plugin-lib';

/**
 * Persistent settings, kept across restarts. The SDK has no API to write a text
 * file, so the JSON is stored as the NAME of an empty folder in the plugin's
 * private directory (as in ShapeSnap).
 */

export type Settings = {
  /** Hatch density, percent (10–100). */
  hatchDensity: number;
};

export const DEFAULTS: Settings = {hatchDensity: 50};

export const LIMITS = {hatchDensity: {min: 10, max: 100, step: 10}};

let current: Settings = {...DEFAULTS};
const listeners = new Set<() => void>();

export const getSettings = () => current;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Saved values merged over the defaults, out-of-range numbers brought back in range. */
export function normalize(saved: Partial<Settings>): Settings {
  const s = {...DEFAULTS, ...saved};
  const {min, max} = LIMITS.hatchDensity;
  s.hatchDensity =
    typeof s.hatchDensity === 'number'
      ? Math.min(max, Math.max(min, s.hatchDensity))
      : DEFAULTS.hatchDensity;
  return s;
}

async function settingsDir(): Promise<string | null> {
  const dir = await PluginManager.getPluginDirPath();
  return dir ? `${dir}/settings` : null;
}

export async function loadSettings() {
  try {
    const dir = await settingsDir();
    if (!dir || !(await FileUtils.exists(dir))) {
      return;
    }
    // Typed as strings, but the native module returns {path, type} objects.
    const entries: unknown[] = (await FileUtils.listFiles(dir)) ?? [];
    for (const entry of entries) {
      const path =
        typeof entry === 'string'
          ? entry
          : (entry as {path?: string} | null)?.path;
      if (typeof path !== 'string') {
        continue;
      }
      const name = path.replace(/\/+$/, '');
      try {
        current = normalize(
          JSON.parse(decodeURIComponent(name.slice(name.lastIndexOf('/') + 1))),
        );
        listeners.forEach(fn => fn());
        return;
      } catch {
        // unreadable entry: try the next one
      }
    }
  } catch (e) {
    console.warn('[Inkwell] loadSettings', e);
  }
}

let writes: Promise<void> = Promise.resolve();

export function updateSettings(patch: Partial<Settings>) {
  current = normalize({...current, ...patch});
  listeners.forEach(fn => fn());
  const snapshot = current;
  writes = writes
    .then(async () => {
      if (snapshot !== current) {
        return; // a newer value will be written
      }
      const dir = await settingsDir();
      if (!dir) {
        return;
      }
      await FileUtils.deleteDir(dir);
      await FileUtils.makeDir(dir);
      await FileUtils.makeDir(
        `${dir}/${encodeURIComponent(JSON.stringify(snapshot))}`,
      );
    })
    .catch(e => console.warn('[Inkwell] saveSettings', e));
}
