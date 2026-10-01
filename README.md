# Inkwell — Supernote plugin

Formerly **Stroke Width**.

Lasso some strokes or shapes, tap **Inkwell** in the lasso toolbar, and pick a pen size (0.1 to 3.5) or one of the four system colours (white, light gray, dark gray, black). Every selected stroke and shape takes it at once, with no confirmation.

It is handy after resizing a shape or handwriting with the lasso. Text boxes, pictures and links in the selection are left untouched.

The panel also shows:

- **Selection summary** (at the bottom): how many strokes and shapes are selected, and their current width and colours.
- **Match active pen:** applies the width of the pen currently selected in Supernote.

## Panel

Compact: a 4-column grid of sizes (with "= pen", the active pen's size), then one row per tool, a label and four choices: **Colour**, **Line**, **Hatch** (with its density `− 50% +` under the label) and **Fill**, and a one-line selection summary. It opens as a centred dialog sized to its content (`regionType` 1, 1440×1240 px, keys from the SDK's native side, not documented for JavaScript; if the host refuses them, the button is registered as before, full screen). Errors show in a bubble over the panel and fade after 4 s; an action is stopped after 30 s so the panel can never stay stuck.

## Lines and fills

Two rows under the colours act on the selection at once:

- **Line**: dashed, long dashes, dotted, and centre line (long dash, dot). Dash lengths grow with the line width, and dashes follow curves.
  - A **stroke stays one element**: its gaps are hidden through its per-point draw flags (`stroke.flagDraw`, the mechanism a partial eraser appears to use), then it is saved with `modifyPageElements`, which clears the undo history. The panel summary shows `hidden points: off/total` for the selected strokes, to check this on the device.
  - A **shape** has no such flags: it is replaced by one geometry per dash (deleted by element number).
- **Hatch**: "/" or "\\", in black or dark gray (one row of four). **Fill**: solid, in white, light gray, dark gray or black. Both are **added** inside every closed stroke or shape (ends less than 20% of its size apart), which stays; concave shapes and holes are handled (even-odd rule). Hatching uses the shape's pen, at most 0.4 wide; the **Density** row sets how close the lines are, 10 to 100 % in steps of 10 (100 % = a base gap of 14 px, or 3 line widths for thick pens; 50 % by default = twice that gap; saved across restarts, like ShapeSnap settings: as a folder name in the plugin directory, `src/settings.ts`); fills use 12 px lines at most 8 px apart, from edge to edge, kept off the outline.
- **Speed**: all the lines are created at once and inserted in a single `insertPageElements` call, instead of one `insertGeometry` (and one page redraw) per line. If the host refuses the batch, the lines are inserted one by one as before. The single insertion may clear the undo history (to confirm on the device); one-by-one insertion keeps it.
- **Shapes closed by several strokes** (a triangle drawn in three strokes, sides crossing at the corners, ends that almost meet) are filled too: the strokes that are not closed on their own are drawn together on a 2 px grid, thickened by 16 px so that nearly meeting ends join; whatever cannot be reached from outside is enclosed, then grown back to the real lines (`src/regions.ts`, unit-tested). Gaps wider than about 30 px stay open.
- **Erased and joined shapes**: a partial eraser keeps one element. Hidden points (draw flags) are dropped; a stroke cut by eraser strokes (`eraseLineTrailNums`) still stores its erased parts, so its outline is not trusted as closed. When the pieces are not all closed on their own, or any is erased, all of them are taken together as the walls of the area to fill: two shapes cut with the eraser and joined up fill as their union. An erased element, or one whose centre line cannot be read, is taken from its drawn contour (`contoursSrc`: the outline of its ink as shown, eraser cuts included; in page pixels or pen coordinates, told apart by their range). If nothing closed is found, the message lists what was seen (pieces, closed, erased, from contours, and what an unreadable element holds), and the panel summary shows `erased by N`.
- Read back from the page, a circle's or ellipse's radius fields hold **twice** the drawn radius (measured on a Manta), unlike what `insertGeometry` takes: outlines halve them.
- The panel closes as soon as the selection is read, so the page shows while it is edited; it reopens only to report a failure.

Supernote has no dashed or filled style, so all of them are made of plain geometries (`GEO_polygon` polylines): a solid fill is a zigzag of lines closer than their width. Geometry is in `src/patterns.ts` (unit-tested), SDK calls in `src/effects.ts`.

## Reliability of width and colour changes

Right after a lasso move or resize, while the shape is still selected, the host keeps the transform pending in the lasso: it hands out the old elements, and page changes only show once the lasso is let go and made again. Before every action, Inkwell compares the lasso box (`getLassoRect`) with the ink of the elements it reads. A lasso drawn by hand always encloses its ink, however loosely; only when the ink sticks out of the box (a shrink or move still pending) does it let the lasso go (`setLassoBoxState(2)`, which commits the transform as tapping elsewhere does) and lasso the same rectangle again (`lassoElements`), then act only on the elements selected before, should the rectangle catch neighbours. Otherwise the lasso is left alone (an enlarge still pending cannot be told from a loose lasso, so it is not handled). Every lasso call is bounded to 3 s; if one fails, the lasso is not touched.


Right after a lasso resize, the host may accept `modifyPageElements` but modify none of the elements (it answers success with an empty list), which left the change to a second try. The result is now checked (every element updated, and the selection read back shows the new value); otherwise the selection is read again and the change applied again, up to three times.

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
