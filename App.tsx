/**
 * Panel opened by the lasso toolbar button: pick a size, a colour, a line
 * pattern, a hatching or a fill, and the selection takes it at once. Compact:
 * one grid of sizes, then one row per tool (label + four choices). Errors show
 * in a bubble over the panel and fade away, so the layout never grows.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  DeviceEventEmitter,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {Summary, applyStyle, readSummary} from './src/selection';
import {FILLS, FillStyle, HATCHES, applyDashes, applyFill} from './src/effects';
import {DASH_STYLES, DashStyle} from './src/patterns';
import {LIMITS, getSettings, subscribe, updateSettings} from './src/settings';
import {PEN_COLORS, StyleChange} from './src/style';
import {PRESETS_MM, formatMm, toInternal} from './src/widths';

export const REFRESH_EVENT = 'strokewidth:refresh';

function describe(s: Summary | null): string {
  if (!s) {
    return 'Reading selection…';
  }
  if (s.error) {
    return s.error;
  }
  const parts = [
    `${s.strokes} stroke${s.strokes === 1 ? '' : 's'}`,
    `${s.shapes} shape${s.shapes === 1 ? '' : 's'}`,
  ];
  if (s.others) {
    parts.push(`${s.others} other (unchanged)`);
  }
  return `${parts.join(' · ')} — ${s.range} mm · ${s.colors}`;
}

/** Dash pattern preview: [length, gap] pairs drawn as small bars (length 0 = dot). */
const DASH_PREVIEW: Record<DashStyle, number[][]> = {
  dashed: [
    [10, 6],
    [10, 6],
    [10, 6],
    [10, 0],
  ],
  long: [
    [22, 6],
    [22, 0],
  ],
  dotted: [
    [0, 8],
    [0, 8],
    [0, 8],
    [0, 8],
    [0, 0],
  ],
  dashdot: [
    [18, 5],
    [0, 7],
    [18, 0],
  ],
};

function DashIcon({dash}: {dash: DashStyle}) {
  return (
    <View style={styles.iconRow}>
      {DASH_PREVIEW[dash].map(([len, gap], i) => (
        <View
          key={i}
          style={[
            len ? styles.bar : styles.dot,
            len ? {width: len} : null,
            {marginRight: gap},
          ]}
        />
      ))}
    </View>
  );
}

const hex = (c: number) => `#${c.toString(16).padStart(2, '0').repeat(3)}`;

/** Square with hatching in its colour (rotated bars, clipped), or filled with a colour. */
function FillIcon({fill}: {fill: FillStyle}) {
  if (!('hatch' in fill)) {
    return (
      <View style={[styles.fillBox, {backgroundColor: hex(fill.color)}]} />
    );
  }
  // -45° runs up to the right ("/"): a vertical bar turned clockwise.
  const turn = fill.hatch === -45 ? 45 : -45;
  return (
    <View style={styles.fillBox}>
      {[-18, -9, 0, 9, 18].map(o => (
        <View
          key={o}
          style={[
            styles.hatch,
            {backgroundColor: hex(fill.color)},
            {transform: [{translateX: o}, {rotate: `${turn}deg`}]},
          ]}
        />
      ))}
    </View>
  );
}

/** An action never keeps the panel busy forever: after this, it is reported as failed. */
const ACTION_TIMEOUT_MS = 30000;
/** How long an error bubble stays. */
const TOAST_MS = 4000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('took too long, stopped')),
      ms,
    );
    work.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type Action = (onReady: () => void) => Promise<{ok: boolean; message: string}>;

/** One tool row: a label on the left (with optional extra controls) and four cells. */
function ToolRow({
  label,
  extra,
  children,
}: {
  label: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.labelBox}>
        <Text style={styles.label}>{label}</Text>
        {extra}
      </View>
      {children}
    </View>
  );
}

function App(): React.JSX.Element {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  // Saved settings (hatch density): re-render when they load or change.
  const [, settingsChanged] = useState(0);
  useEffect(() => subscribe(() => settingsChanged(n => n + 1)), []);
  const density = getSettings().hatchDensity;
  const changeDensity = (delta: number) =>
    updateSettings({hatchDensity: density + delta});

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = setTimeout(() => setToast(''), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const refresh = useCallback(() => {
    // A new opening: an old error bubble would describe a previous selection.
    setToast('');
    setSummary(null);
    readSummary()
      .then(setSummary)
      .catch(e =>
        setSummary({
          strokes: 0,
          shapes: 0,
          others: 0,
          range: '—',
          colors: '—',
          hidden: '',
          raw: '',
          penWidth: null,
          error: String(e?.message ?? e),
        }),
      );
  }, []);

  useEffect(() => {
    refresh();
    const sub = DeviceEventEmitter.addListener(REFRESH_EVENT, refresh);
    return () => sub.remove();
  }, [refresh]);

  /**
   * Runs one action on the selection. The panel closes as soon as the selection
   * is read, so the page shows while it is edited. A failure, at any step, is
   * shown in a bubble, the panel coming back if it had closed. The action is
   * bounded in time, so the panel can never stay stuck.
   */
  const run = async (action: Action) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setToast('');
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        PluginManager.closePluginView();
      }
    };
    let failure = '';
    try {
      const res = await withTimeout(action(close), ACTION_TIMEOUT_MS);
      failure = res.ok ? '' : res.message;
    } catch (e: any) {
      failure = `Error: ${e?.message ?? e}`;
    } finally {
      setBusy(false);
    }
    if (failure) {
      setToast(failure);
      if (closed) {
        PluginManager.showPluginView();
      }
    } else {
      close();
    }
  };

  const apply = (change: StyleChange) =>
    run(ready => applyStyle(change, ready));

  const pen = summary?.penWidth;

  return (
    <View style={styles.root}>
      <ScrollView style={styles.card} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Inkwell</Text>
          <Pressable
            onPress={() => PluginManager.closePluginView()}
            style={styles.close}
            hitSlop={16}>
            <Text style={styles.title}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.grid}>
          {PRESETS_MM.map(mm => (
            <Pressable
              key={mm}
              style={[styles.size, busy && styles.dim]}
              onPress={() => apply({width: toInternal(mm)})}>
              <View
                style={[
                  styles.sample,
                  {height: Math.max(2, Math.round(mm * 5))},
                ]}
              />
              <Text style={styles.sizeText}>{mm.toFixed(1)}</Text>
            </Pressable>
          ))}
          <Pressable
            style={[styles.size, styles.penCell, (busy || !pen) && styles.dim]}
            onPress={() => pen && apply({width: pen})}>
            <Text style={styles.penText}>= pen</Text>
            <Text style={styles.penSub}>{pen ? formatMm(pen) : '—'}</Text>
          </Pressable>
        </View>

        <View style={styles.rule} />

        <ToolRow label="Colour">
          {PEN_COLORS.map(c => (
            <Pressable
              key={c.value}
              style={[styles.tool, busy && styles.dim]}
              onPress={() => apply({color: c.value})}>
              <View style={[styles.swatch, {backgroundColor: c.swatch}]} />
            </Pressable>
          ))}
        </ToolRow>

        <ToolRow label="Line">
          {DASH_STYLES.map(d => (
            <Pressable
              key={d}
              style={[styles.tool, busy && styles.dim]}
              onPress={() => run(ready => applyDashes(d, ready))}>
              <DashIcon dash={d} />
            </Pressable>
          ))}
        </ToolRow>

        <ToolRow
          label="Hatch"
          extra={
            <View style={styles.stepper}>
              <Pressable
                style={styles.step}
                hitSlop={8}
                onPress={() => changeDensity(-LIMITS.hatchDensity.step)}>
                <Text style={styles.stepText}>−</Text>
              </Pressable>
              <Text style={styles.density}>{density}%</Text>
              <Pressable
                style={styles.step}
                hitSlop={8}
                onPress={() => changeDensity(LIMITS.hatchDensity.step)}>
                <Text style={styles.stepText}>+</Text>
              </Pressable>
            </View>
          }>
          {HATCHES.map(f => (
            <Pressable
              key={JSON.stringify(f)}
              style={[styles.tool, busy && styles.dim]}
              onPress={() => run(ready => applyFill(f, ready, density))}>
              <FillIcon fill={f} />
            </Pressable>
          ))}
        </ToolRow>

        <ToolRow label="Fill">
          {FILLS.map(f => (
            <Pressable
              key={JSON.stringify(f)}
              style={[styles.tool, busy && styles.dim]}
              onPress={() => run(ready => applyFill(f, ready))}>
              <FillIcon fill={f} />
            </Pressable>
          ))}
        </ToolRow>

        <Text style={styles.info} numberOfLines={1}>
          {describe(summary)}
          {summary?.hidden ? ` · hidden ${summary.hidden}` : ''}
        </Text>
      </ScrollView>

      {toast ? (
        <View style={styles.toastLayer} pointerEvents="box-none">
          <Pressable style={styles.toast} onPress={() => setToast('')}>
            <Text style={styles.toastText}>{toast}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Transparent around the card: if the host lets it through, the note shows behind.
  root: {flex: 1, backgroundColor: 'transparent'},
  card: {
    flexGrow: 0,
    backgroundColor: '#ffffff',
    borderBottomWidth: 2,
    borderColor: '#000000',
  },
  content: {paddingHorizontal: 28, paddingTop: 18, paddingBottom: 14},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {fontSize: 26, fontWeight: '700', color: '#000000'},
  close: {paddingHorizontal: 6},
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  size: {
    width: '23.5%',
    height: 52,
    marginBottom: 10,
    paddingHorizontal: 14,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sample: {width: '48%', backgroundColor: '#000000', borderRadius: 3},
  sizeText: {fontSize: 22, color: '#000000'},
  penCell: {flexDirection: 'column', justifyContent: 'center'},
  penText: {fontSize: 18, color: '#000000'},
  penSub: {fontSize: 15, color: '#555555'},
  rule: {height: 1, backgroundColor: '#c9c9c9', marginTop: 4, marginBottom: 12},
  row: {flexDirection: 'row', alignItems: 'center', marginBottom: 10},
  labelBox: {width: 104},
  label: {fontSize: 19, color: '#000000'},
  tool: {
    flex: 1,
    height: 52,
    marginLeft: 10,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#000000',
  },
  stepper: {flexDirection: 'row', alignItems: 'center', marginTop: 4},
  step: {
    width: 28,
    height: 26,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {fontSize: 18, lineHeight: 20, color: '#000000'},
  density: {width: 44, fontSize: 14, color: '#000000', textAlign: 'center'},
  iconRow: {flexDirection: 'row', alignItems: 'center'},
  bar: {height: 5, backgroundColor: '#000000'},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#000000'},
  fillBox: {
    width: 32,
    height: 32,
    borderWidth: 2,
    borderColor: '#000000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hatch: {
    position: 'absolute',
    width: 2,
    height: 60,
    backgroundColor: '#9d9d9d',
  },
  dim: {opacity: 0.4},
  info: {fontSize: 14, color: '#555555', marginTop: 2},
  toastLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toast: {
    maxWidth: '80%',
    paddingHorizontal: 28,
    paddingVertical: 20,
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: '#000000',
    borderRadius: 14,
  },
  toastText: {
    fontSize: 20,
    lineHeight: 28,
    color: '#000000',
    textAlign: 'center',
  },
});

export default App;
