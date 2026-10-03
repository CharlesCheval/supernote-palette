# Palette — Supernote plugin

Formerly **Stroke Width** (then Inkwell during testing).

Lasso some strokes or shapes, tap **Palette** in the lasso toolbar, and restyle them at once: pen size, colour, dashed lines, hatching or a solid fill. No confirmation; the panel closes when the change is done.

Text boxes, pictures and links in the selection are left untouched.

## Panel

A centred dialog sized to its content (`regionType` 1, 1440×1240 px; if the host refuses those keys, the panel opens full screen):

- **Sizes**: a 4-column grid from 0.1 to 3.5, plus **= pen**, the size of the pen currently selected in Supernote.
- **Colour**: white, light gray, dark gray, black.
- **Line**: dashed, long dashes, dotted, centre line (long dash, dot).
- **Hatch**: "/" or "\\", black or dark gray, with its density (`− 50% +`, 10 to 100 %) under the label.
- **Fill**: solid white, light gray, dark gray or black.
- A one-line **summary** of the selection: strokes, shapes, current widths and colours.

Tap outside the panel to close it. While a long action runs (a large fill takes seconds on the device), a small **Working…** box shows; an action is stopped after 120 s. Errors show in a bubble that fades after 4 s.

The hatch density is saved across restarts (as a folder name in the plugin directory, `src/settings.ts`: the SDK cannot write text files).

## Width and colour

- **A single shape**: `getLassoGeometries` + `modifyLassoGeometry`, a lasso operation, which keeps Supernote's undo history.
- **Anything else** (strokes, several elements): the width (`thickness`, `geometry.penWidth`) or colour (`stroke.penColor`, `geometry.penColor`) is set, then one `modifyPageElements` call applies it. It needs file write access (**Always allow** on first use) and **clears the undo history** (the SDK has no lasso operation for strokes).

## Dashed lines

Strokes and shapes are redrawn as dashes (plain geometries; strokes as fineliner dashes along their visible parts), whose length grows with the line width and which follow curves. An arrow drawn by Snap keeps a solid head. The dashes are inserted **first**, then the originals deleted: through the lasso when it holds exactly them, else by element number.

## Fills and hatching

Supernote has no fill style: fills and hatching are made of plain lines added inside every closed stroke or shape, which stays as it is.

- **The area** is found on a grid of 2 to 3 px cells (finer for small shapes): the outlines are drawn into it, what cannot be reached from outside is the inside. Shapes closed by several strokes (sides crossing at the corners, ends that nearly meet), erased and joined shapes, concave shapes and holes are handled.
- **Strokes**: the fill stops at the stroke's real edge, taken from its drawn contour (`contoursSrc`, pressure included). After a width change the host keeps the old contour, so a contour whose width does not match the pen is ignored and the pen width is used instead.
- **A lone perfect shape** (circle, ellipse, rectangle or any closed convex polygon) is filled from its exact geometry instead of the grid: the outer edge of the fill lies exactly on the inner edge of the outline.
- **Solid fill**: a ring along the edge plus rows closer than their width, chained into a few continuous paths (usually one per enclosed part), so that the lasso takes the fill whole and the host inserts few elements. Narrow tips get a finer pass.
- **Hatching**: line ends placed square to the outline, overlapping its inner edge by about 1 px, on thin and thick outlines alike. Geometries are drawn **above** hand strokes (measured), so the lines never run onto them.
- All the lines are inserted in a single `insertPageElements` call (one by one if the host refuses the batch).

Fill geometry is in `src/inkfill.ts` and `src/exactfill.ts`, patterns in `src/patterns.ts` (all unit-tested), SDK calls in `src/effects.ts`.

## Moved or resized selections

Right after a lasso move or resize, the host keeps the transform pending: it still hands out the old elements and the old box, while `generateLassoPreview` already returns the new box. When the two differ, Palette saves the note (which applies the move and lets the lasso go), lassoes the new box, and finds the same elements again by kind, point count and position, ignoring any neighbours caught by the new lasso. If an element cannot be recognised for sure, nothing is changed. A rotated selection must be lassoed again by hand.

The native element cache is cleared before every read of the lasso (it could hand out stale elements).

## PDFs

In PDF documents, elements deleted or modified through the SDK do not stay that way (measured: they come back later, sometimes elsewhere on the page). Palette therefore only offers what adds lines or goes through the lasso: **fills, hatching, and the width or colour of a single shape**. Dashes and changes to strokes or several elements show *Not available in PDFs (unstable behavior).*

## Width units

The SDK does not document the unit of `thickness` / `penWidth`, and it is not linear. The table in `src/widths.ts` was measured on a Manta by drawing with each pen size:

| Pen size | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 | 1.5 | 2.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Internal | 200 | 300 | 400* | 500* | 600 | 700 | 900 | 1000 | 1100 | 1200 | 1800 | 2400 |

\* interpolated. **2.5** (3000), **3.0** (3600) and **3.5** (4200) go beyond the pen menu, extrapolated from the 1.5→2.0 step.

Colours are the SDK's `penColor` values: `0x00` black, `0x9D` dark gray, `0xC9` light gray, `0xFE` white (`src/style.ts`).

Read back from the page, a circle's or ellipse's radius fields hold **twice** the drawn radius (measured), unlike what `insertGeometry` takes: they are halved before any page write.

## Install and build

1. Download `Palette.snplg` from the [latest release](https://github.com/CharlesCheval/supernote-palette/releases/latest) and copy it to the device's `MyStyle` folder (USB, Supernote Partner or Browse & Access).
2. Open **Settings → Apps → Plugins → Add plugin**. It replaces Stroke Width in place, settings included.

```bash
npm install
npm run build   # -> build/outputs/StrokeWidth.snplg (the plugin key stays StrokeWidth)
npx jest
```

## Releasing

Bump `versionName` **and** `versionCode` in `PluginConfig.json` (the device only upgrades when `versionCode` increases), commit, then push a matching tag:

```bash
git tag v<versionName>
git push origin v<versionName>
```

GitHub Actions runs the tests, builds the plugin and attaches it to the release as `Palette.snplg`.

## License

[MIT](LICENSE) © Charles Cheval. Not affiliated with Ratta / Supernote.
