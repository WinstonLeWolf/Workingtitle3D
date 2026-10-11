# Workingtitle3D

An offline 3D modeller that runs in the browser. Drop shapes on a plate, make some of them
holes, group them, and export one clean, closed solid for printing. Nothing is uploaded:
the whole app is one HTML file.

## Features

- Shapes: box, cylinder, cone, sphere, torus, wedge, tube, inside-corner fillet, each with
  a facet count.
- Solid and hole parts, groups and intersect groups, built with exact mesh booleans
  ([Manifold](https://github.com/elalish/manifold)), so joined parts stay closed solids.
- Tool steps on a part: fillet, chamfer or cove round the edge of a flat part; hollow to a
  set wall, optionally opened through one face. Steps stay editable and removable.
- Per-part history: roll back one part without touching the rest. Undo and redo.
- Projects live in a folder you pick; every step is written there as you work.
- Import STL, 3MF, OBJ (repaired on the way in). Export STL, 3MF, OBJ, checked as a
  closed solid and read back after writing.
- Colour-blind friendly interface: no state is shown by hue alone.

## Run

Build once, then open `dist/Workingtitle3D.html` in a Chromium-based browser (Edge,
Vivaldi, Chromium; in Brave, enable `brave://flags/#file-system-access-api` to save
projects).

    npm install
    npm run build

## Tests

    node tests/kernel.mjs        shapes, groups, tool steps, joined export
    node tests/doc.mjs           history, rollback, project folder and crash recovery
    node tests/edgeshaper.mjs    edge profiles on test plates
    node tests/hollower.mjs      hollowing, closed and opened
    node tests/browser.mjs       the built page, headless (set PUPPETEER_DIR and CHROME_DIR)

## Keys

| Key | Action |
|---|---|
| Right drag / middle drag / wheel | orbit / pan / zoom |
| Ctrl + left drag | orbit |
| Left drag on a part / empty space | move on the plate / select box |
| Shift + click | add to selection |
| Arrows, Ctrl + Up/Down | nudge 1 mm (Shift: 10 mm), following the view; raise/lower |
| Alt + drag | drag a copy |
| F | fit the selection |
| H / S | hole / solid |
| D | drop to the plate |
| M | mirror X (Shift: Y, Alt: Z) |
| Ctrl + G / Ctrl + Shift + G / Ctrl + I | group / ungroup / intersect |
| Ctrl + D | duplicate (repeats the last offset) |
| Ctrl + C / X / V | copy / cut / paste |
| Ctrl + H / Ctrl + Shift + H | hide / show hidden |
| Ctrl + L | lock |
| Ctrl + Z / Ctrl + Y | undo / redo |
| Ctrl + E | export |
| Delete, Esc | delete, clear selection |

## Licence

Source-available: Apache License 2.0 with the Commons Clause. Use it for anything, commercial
work included; the models you make are yours to sell; fork it with credit under the same
terms; do not sell it or a fork of it. Full terms in [LICENSE](LICENSE).

Bundled libraries keep their own licences (MIT, Apache-2.0, ISC, Boost 1.0), listed in
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and carried inside the built HTML file.
