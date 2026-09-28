# Stroke Width — Supernote plugin

Lasso some strokes or shapes, tap **Stroke width** in the lasso toolbar, and pick a pen size (0.1 to 3.5) or one of the four system colours (black, dark gray, light gray, white). Every selected stroke and shape takes it at once, with no confirmation.

It is handy after resizing a shape or handwriting with the lasso. Text boxes, pictures and links in the selection are left untouched.

The panel also shows:

- **Selection summary:** how many strokes and shapes are selected, and their current width and colours.
- **Match active pen:** applies the width of the pen currently selected in Supernote.

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
   - **Anything else (strokes, several shapes):** `thickness` (and `geometry.penWidth` for shapes), or `stroke.penColor` / `geometry.penColor`, is set, then one `modifyPageElements` call applies the change. It needs file write access (**Always allow** on first use). The SDK offers no lasso operation for stroke width or colour, and `modifyPageElements` **clears the undo history**. The panel warns about it before you pick a size.

## Install and build

1. Download `StrokeWidth.snplg` from the [latest release](https://github.com/CharlesCheval/supernote-stroke-width/releases/latest) and copy it to the device's `MyStyle` folder (USB, Supernote Partner or Browse & Access).
2. Open **Settings → Apps → Plugins → Add plugin**.

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
