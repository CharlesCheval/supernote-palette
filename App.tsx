/**
 * Panel opened by the lasso toolbar button: pick a pen size or a colour, and every
 * selected stroke and shape takes it at once.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {DeviceEventEmitter, Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {Summary, applyStyle, readSummary} from './src/selection';
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
  const parts = [`${s.strokes} stroke${s.strokes === 1 ? '' : 's'}`, `${s.shapes} shape${s.shapes === 1 ? '' : 's'}`];
  if (s.others) {
    parts.push(`${s.others} other (unchanged)`);
  }
  return `${parts.join(' · ')}  —  width ${s.range} mm · ${s.colors}`;
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

  const apply = async (change: StyleChange) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await applyStyle(change);
      if (res.ok) {
        PluginManager.closePluginView();
      } else {
        setMessage(res.message);
      }
    } catch (e: any) {
      setMessage(`Error: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const pen = summary?.penWidth;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Inkwell</Text>
        <Pressable onPress={() => PluginManager.closePluginView()} style={styles.close}>
          <Text style={styles.title}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.grid}>
        {PRESETS_MM.map(mm => (
          <Pressable key={mm} style={[styles.size, busy && styles.dim]} onPress={() => apply({width: toInternal(mm)})}>
            <View style={[styles.sample, {height: Math.max(2, Math.round(mm * 8))}]} />
            <Text style={styles.sizeText}>{mm.toFixed(1)}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.colors}>
        {PEN_COLORS.map(c => (
          <Pressable key={c.value} style={[styles.color, busy && styles.dim]} onPress={() => apply({color: c.value})}>
            <View style={[styles.swatch, {backgroundColor: c.swatch}]} />
            <Text style={styles.colorText}>{c.name}</Text>
          </Pressable>
        ))}
      </View>

      {pen ? (
        <Pressable style={[styles.match, busy && styles.dim]} onPress={() => apply({width: pen})}>
          <Text style={styles.matchText}>Match active pen ({formatMm(pen)} · raw {pen})</Text>
        </Pressable>
      ) : null}

      {/* At the bottom: the selection is read asynchronously, so nothing above moves when it arrives. */}
      <Text style={styles.info}>{describe(summary)}</Text>
      {summary?.raw ? <Text style={styles.raw}>raw width: {summary.raw}</Text> : null}

      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 36, backgroundColor: '#ffffff'},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20},
  title: {fontSize: 30, fontWeight: '700', color: '#000000'},
  close: {padding: 8},
  info: {fontSize: 20, lineHeight: 30, color: '#000000', marginTop: 24, marginBottom: 8},
  raw: {fontSize: 15, color: '#444444', marginBottom: 20, fontFamily: 'monospace'},
  grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between'},
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
  sample: {width: '60%', backgroundColor: '#000000', borderRadius: 4, marginBottom: 14},
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
  swatch: {width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: '#000000'},
  colorText: {fontSize: 18, color: '#000000', marginTop: 8},
  dim: {opacity: 0.4},
  match: {borderWidth: 2, borderColor: '#000000', borderRadius: 12, paddingVertical: 18, alignItems: 'center', marginTop: 24},
  matchText: {fontSize: 22, color: '#000000'},
  message: {fontSize: 20, lineHeight: 30, color: '#000000', marginTop: 20},
});

export default App;
