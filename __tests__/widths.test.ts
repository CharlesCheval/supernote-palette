import {PEN_SIZES, describeRange, formatMm, toInternal} from '../src/widths';

test('pen sizes map to the widths measured on the device', () => {
  expect(toInternal(0.1)).toBe(200);
  expect(toInternal(0.5)).toBe(600);
  expect(toInternal(0.7)).toBe(900);
  expect(toInternal(1.0)).toBe(1200);
  expect(toInternal(2.0)).toBe(2400);
  expect(toInternal(3.0)).toBe(3600);
  expect(toInternal(1.25)).toBe(1500); // interpolated
});

test('internal widths read back as the pen size', () => {
  for (const s of PEN_SIZES) {
    expect(formatMm(s.internal)).toBe(s.mm.toFixed(1));
  }
  expect(formatMm(650)).toBe('≈0.5');
});

test('ranges', () => {
  expect(describeRange([400, 400])).toBe('0.3');
  expect(describeRange([1000, 400, 0])).toBe('0.3–0.8');
  expect(describeRange([])).toBe('—');
});
