# Inkwell — Supernote plugin

Formerly **Stroke Width**.

Lasso some strokes or shapes, tap **Inkwell** in the lasso toolbar, and pick a pen size (0.1 to 3.5) or one of the four system colours (white, light gray, dark gray, black). Every selected stroke and shape takes it at once, with no confirmation.

It is handy after resizing a shape or handwriting with the lasso. Text boxes, pictures and links in the selection are left untouched.

The panel also shows:

- **Selection summary** (at the bottom): how many strokes and shapes are selected, and their current width and colours.
- **Match active pen:** applies the width of the pen currently selected in Supernote.

## Lines and fills

Two rows under the colours act on the selection at once:

- **Line**: dashed, long dashes, dotted, and centre line (long dash, dot). Dash lengths grow with the line width, and dashes follow curves.
  - A **stroke stays one element**: its gaps are hidden through its per-point draw flags (`stroke.flagDraw`, the mechanism a partial eraser appears to use), then it is saved with `modifyPageElements`, which clears the undo history. The panel summary shows `hidden points: off/total` for the selected strokes, to check this on the device.
  - A **shape** has no such flags: it is replaced by one geometry per dash (deleted by element number).
- **Fill**: diagonal hatching, cross-hatching, light gray fill, solid fill (in the shape's colour). Lines are **added** inside every closed stroke or shape (ends less than 20% of its size apart), which stays; concave shapes and holes are handled (even-odd rule). Hatching uses the shape's pen, at most 0.4 wide; fills use 12 px lines 8 px apart, kept off the outline. Adding geometries keeps the undo history.

Supernote has no dashed or filled style, so both are made of plain geometries (`GEO_polygon` polylines): a solid fill is a zigzag of lines closer than their width. Geometry is in `src/patterns.ts` (unit-tested), SDK calls in `src/effects.ts`.

## Width units

The SDK does not document the unit of `thickness` / `penWidth`, and it is not linear. The table in `src/widths.ts` was measured on a Manta by drawing with each pen size:

| Pen size | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 | 1.5 | 2.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Internal | 200 | 300 | 400* | 500* | 600 | 700 | 900 | 1000 | 1100 | 1200 | 1800 | 2400 |

\* interpolated. The panel also offers **2.5** (3000), **3.0** (3600) and **3.5** (4200), beyond the pen menu, extrapolated from the 1.5→2.0 step.

Colours are the SDK's `penColor` values: `0x00` black, `0x9D` dark gray, `0xC9` light gray, `0xFE` white (`src/style.ts`).

The panel shows the selection's raw widths (`thickness` for strokes, `penWidth` for shapes) to help compare both scales.

## How it works

1. `getLassoElements` reads the selection.
2. The width or colour is applied by one of two routes:
   - **A single shape:** `getLassoGeometries` + `modifyLassoGeometry`. This is a lasso operation, so Supernote's undo history is kept.
   - **Anything else (strokes, several shapes):** `thickness` (and `geometry.penWidth` for shapes), or `stroke.penColor` / `geometry.penColor`, is set, then one `modifyPageElements` call applies the change. It needs file write access (**Always allow** on first use). The SDK offers no lasso operation for stroke width or colour, and `modifyPageElements` **clears the undo history**.

## Install and build

1. Download `StrokeWidth.snplg` from the [latest release](https://github.com/CharlesCheval/supernote-stroke-width/releases/latest) and copy it to the device's `MyStyle` folder (USB, Supernote Partner or Browse & Access).
2. Open **Settings → Apps → Plugins → Add plugin**. It replaces Stroke Width in place.

```bash
npm install
npm run build   # -> build/outputs/StrokeWidth.snplg
npx jest
```

## Releasing

Bump `versionName` **and** `versionCode` in `PluginConfig.json` (the device only upgrades when `versionCode` increases), commit, then push a matching tag:

```bash
git tag v<versionName>
git push origin v<versionName>
```

GitHub Actions runs the tests, builds `StrokeWidth.snplg` and attaches it to the release.

## License

[MIT](LICENSE) © Charles Cheval. Not affiliated with Ratta / Supernote.
