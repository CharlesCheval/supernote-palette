/**
 * Panel opened by the lasso toolbar button: pick a pen size, and every selected
 * stroke and shape takes that width.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {DeviceEventEmitter, Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {Summary, applyWidth, readSummary} from './src/selection';
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
  return `${parts.join(' · ')}  —  current width ${s.range} mm`;
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
        setSummary({strokes: 0, shapes: 0, others: 0, range: '—', penWidth: null, undoable: false, error: String(e?.message ?? e)}),
      );
  }, []);

  useEffect(() => {
    refresh();
    const sub = DeviceEventEmitter.addListener(REFRESH_EVENT, refresh);
    return () => sub.remove();
  }, [refresh]);

  const apply = async (width: number) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await applyWidth(width);
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
        <Text style={styles.title}>Stroke width</Text>
        <Pressable onPress={() => PluginManager.closePluginView()} style={styles.close}>
          <Text style={styles.title}>✕</Text>
        </Pressable>
      </View>
      <Text style={styles.info}>{describe(summary)}</Text>

      <View style={styles.grid}>
        {PRESETS_MM.map(mm => (
          <Pressable key={mm} style={[styles.size, busy && styles.dim]} onPress={() => apply(toInternal(mm))}>
            <View style={[styles.sample, {height: Math.max(2, Math.round(mm * 8))}]} />
            <Text style={styles.sizeText}>{mm.toFixed(1)}</Text>
          </Pressable>
        ))}
      </View>

      {pen ? (
        <Pressable style={[styles.match, busy && styles.dim]} onPress={() => apply(pen)}>
          <Text style={styles.matchText}>Match active pen ({formatMm(pen)} · raw {pen})</Text>
        </Pressable>
      ) : null}

      {summary && !summary.error && !summary.undoable ? (
        <Text style={styles.message}>
          ⚠ Changing strokes clears Supernote's undo history (only a single shape can be changed undoably).
        </Text>
      ) : null}

      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 36, backgroundColor: '#ffffff'},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  title: {fontSize: 30, fontWeight: '700', color: '#000000'},
  close: {padding: 8},
  info: {fontSize: 20, lineHeight: 30, color: '#000000', marginTop: 12, marginBottom: 24},
  grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between'},
  size: {
    width: '31%',
    height: 120,
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sample: {width: '60%', backgroundColor: '#000000', borderRadius: 4, marginBottom: 14},
  sizeText: {fontSize: 28, color: '#000000'},
  dim: {opacity: 0.4},
  match: {borderWidth: 2, borderColor: '#000000', borderRadius: 12, paddingVertical: 18, alignItems: 'center', marginTop: 8},
  matchText: {fontSize: 22, color: '#000000'},
  message: {fontSize: 20, lineHeight: 30, color: '#000000', marginTop: 20},
});

export default App;
