/**
 * Panel opened by the lasso toolbar button: pick a pen size or a colour, and every
 * selected stroke and shape takes it at once.
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
import {FILLS, FillStyle, applyDashes, applyFill} from './src/effects';
import {DASH_STYLES, DashStyle} from './src/patterns';
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
  return `${parts.join(' · ')}  —  width ${s.range} mm · ${s.colors}`;
}

/** Dash pattern preview: [length, gap] pairs drawn as small bars (length 0 = dot). */
const DASH_PREVIEW: Record<DashStyle, number[][]> = {
  dashed: [
    [14, 8],
    [14, 8],
    [14, 8],
    [14, 0],
  ],
  long: [
    [30, 8],
    [30, 0],
  ],
  dotted: [
    [0, 10],
    [0, 10],
    [0, 10],
    [0, 10],
    [0, 0],
  ],
  dashdot: [
    [24, 7],
    [0, 7],
    [24, 0],
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

/** Square with dark gray hatching (rotated bars, clipped), or filled with a colour. */
function FillIcon({fill}: {fill: FillStyle}) {
  if ('color' in fill) {
    return (
      <View style={[styles.fillBox, {backgroundColor: hex(fill.color)}]} />
    );
  }
  // -45° runs up to the right ("/"): a vertical bar turned clockwise.
  const turn = fill.hatch === -45 ? 45 : -45;
  return (
    <View style={styles.fillBox}>
      {[-24, -12, 0, 12, 24].map(o => (
        <View
          key={o}
          style={[
            styles.hatch,
            {transform: [{translateX: o}, {rotate: `${turn}deg`}]},
          ]}
        />
      ))}
    </View>
  );
}

function App(): React.JSX.Element {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(() => {
    setMessage('');
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
   * is read, so the page shows while it is edited; it comes back only to report
   * a failure.
   */
  const run = async (
    action: (onReady: () => void) => Promise<{ok: boolean; message: string}>,
  ) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setMessage('');
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        PluginManager.closePluginView();
      }
    };
    let failure = '';
    try {
      const res = await action(close);
      failure = res.ok ? '' : res.message;
    } catch (e: any) {
      failure = `Error: ${e?.message ?? e}`;
    } finally {
      setBusy(false);
    }
    if (failure) {
      setMessage(failure);
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Inkwell</Text>
        <Pressable
          onPress={() => PluginManager.closePluginView()}
          style={styles.close}>
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
              style={[styles.sample, {height: Math.max(2, Math.round(mm * 8))}]}
            />
            <Text style={styles.sizeText}>{mm.toFixed(1)}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.colors}>
        {PEN_COLORS.map(c => (
          <Pressable
            key={c.value}
            style={[styles.color, busy && styles.dim]}
            onPress={() => apply({color: c.value})}>
            <View style={[styles.swatch, {backgroundColor: c.swatch}]} />
            <Text style={styles.colorText}>{c.name}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Line</Text>
        {DASH_STYLES.map(d => (
          <Pressable
            key={d}
            style={[styles.tool, busy && styles.dim]}
            onPress={() => run(ready => applyDashes(d, ready))}>
            <DashIcon dash={d} />
          </Pressable>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Fill</Text>
        {FILLS.map(f => (
          <Pressable
            key={JSON.stringify(f)}
            style={[styles.tool, busy && styles.dim]}
            onPress={() => run(ready => applyFill(f, ready))}>
            <FillIcon fill={f} />
          </Pressable>
        ))}
      </View>

      {pen ? (
        <Pressable
          style={[styles.match, busy && styles.dim]}
          onPress={() => apply({width: pen})}>
          <Text style={styles.matchText}>
            Match active pen ({formatMm(pen)} · raw {pen})
          </Text>
        </Pressable>
      ) : null}

      {/* At the bottom: the selection is read asynchronously, so nothing above moves when it arrives. */}
      <Text style={styles.info}>{describe(summary)}</Text>
      {summary?.raw ? (
        <Text style={styles.raw}>
          raw width: {summary.raw}
          {summary.hidden ? ` · hidden points: ${summary.hidden}` : ''}
        </Text>
      ) : null}

      {message ? <Text style={styles.message}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#ffffff'},
  content: {padding: 36},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {fontSize: 30, fontWeight: '700', color: '#000000'},
  close: {padding: 8},
  info: {
    fontSize: 20,
    lineHeight: 30,
    color: '#000000',
    marginTop: 24,
    marginBottom: 8,
  },
  raw: {
    fontSize: 15,
    color: '#444444',
    marginBottom: 20,
    fontFamily: 'monospace',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  size: {
    width: '31%',
    height: 110,
    marginBottom: 16,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sample: {
    width: '60%',
    backgroundColor: '#000000',
    borderRadius: 4,
    marginBottom: 14,
  },
  sizeText: {fontSize: 28, color: '#000000'},
  colors: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 8,
    paddingTop: 20,
    borderTopWidth: 1,
    borderColor: '#c9c9c9',
  },
  color: {alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6},
  swatch: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: '#000000',
  },
  colorText: {fontSize: 18, color: '#000000', marginTop: 8},
  section: {flexDirection: 'row', alignItems: 'center', marginTop: 16},
  sectionLabel: {fontSize: 20, color: '#000000', width: 70},
  tool: {
    flex: 1,
    height: 72,
    marginLeft: 10,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconRow: {flexDirection: 'row', alignItems: 'center'},
  bar: {height: 5, backgroundColor: '#000000'},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#000000'},
  fillBox: {
    width: 44,
    height: 44,
    borderWidth: 3,
    borderColor: '#000000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hatch: {
    position: 'absolute',
    width: 3,
    height: 80,
    backgroundColor: '#9d9d9d',
  },
  dim: {opacity: 0.4},
  match: {
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 24,
  },
  matchText: {fontSize: 22, color: '#000000'},
  message: {fontSize: 20, lineHeight: 30, color: '#000000', marginTop: 20},
});

export default App;
