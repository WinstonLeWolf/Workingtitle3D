# Workingtitle3D

![Workingtitle3D](box.png)

Workingtitle3D is a new and yet familiar 3D modeler. Runs in your browser no network connection required. 
No login, no telemetry. no forced cloud model inspection. Nothing leaves the machine. 

It's new and it will have flaws but it's stable enough and feature rich so it's already my daily driver.
Designed with 3D printing as the primary goal your parts will snap to grid in even divisions of standard printer nozzle sizes (0.05mm is the exception), 
this helps guide the user to design printer friendly models and that means later on having fewer rounding errors made by the slicer.

Did i mention its free? Now and for as long as it exists no sub, no paid anything ever. 
The whole app lives in an HTML page you can edit and add anything you want to it. 

Dedicated add-on module tab is coming so you'll be able to add custom shape tools and share them with each other easily.

There are no automatic or in-app updates. New tools and fixes arrive as new versions, check back often until i add the menu item "check for updates",
which will display any newer version then the current and change logs so you dont have to leave the app to see whats new. 

As for those tools and features if you find its missing something commonly used in 3D modeling and you think its a good fit here, 
submit a request and it likely will be there for the next update. 

I'm just one Man and a silly coding bot in a trenchcoat. If you vehemently hate ai code thats fine, 
don't use it and really don't feel obligated to tell me or anyone else just go enjoy your day. 

## Features
- Shapes, holes, groups and intersects, joined with exact mesh booleans
  (https://github.com/elalish/manifold).
  
- New shapes follow the pointer and sit flat on whatever face they land on. Parts stay on a
  0.05 mm lattice, so parts that meet really meet and you don't end up with un-joined slivers.
  
- Parametric: Change a hole after grouping it and the group rebuilds. Every part keeps its recipe.
- Undo: Roll back a single part of a group and it rebuilds the group with the updated shape (feature not seen before) one part and leave the rest alone.
- Supports STL, 3MF and OBJ, repaired automagically during import. Repairing does not always fully close a mesh but,
- it load the model in anyway and you can continue on no complaints no forced repair first. Export has its own set of repair options,
- which will(should) take care of any remaining manifold issues.
- 
- "Show faults": check box lets you see where model defects are by highlighting them.
- Repair: weld gaps, fill holes, or rebuild the mesh as one solid.
- Simplify: Quadratic edge collapse decimation with topology preserve, fewer triangles and a smaller file.
- Edge shaper: fillet, chamfer, cove on flat parts.
- Hollow, optionally opened through a
  face.
- Save file writes the whole project as one .wt3d file. Parts stay editable, imported meshes
  stay exact, so nothing degrades on a round trip the way it does through STL.
- tooltips: View menu - toggle tooltips, Helpful messages when you hover oven an item to help you get started without RTFM.
- Interface Theme: includes multiple color scheme presets to help with different types of colorblindness. Rememeber its HTML,
- you can make your own color scheme to suite your needs very easily amd submit it to be added officially. See ACCESSIBILITY.md.

## Run
Download the latest release - open Workingtitle3D.html in a Chromium-based browser (Chromium itself is preferred,
Vivaldi and Brave also good options). There is no install no bloat. Firefox is not supported due to how it handles file saving,
it requires a workaround which would in turn break for chromium.

Brave keeps folder access switched off by default. to enable open this, in brave address bar go to - brave://flags/#file-system-access-api and enable,
This allows autosaving and believe me you want that, you can instead manually save its an option you are not forced to enable anything.

To build it yourself:

    npm install
    npm run build

## Keys
| Key | Action |
|---|---|
| Right drag / middle drag / wheel | orbit / pan / zoom to the pointer |
| Ctrl + left drag | orbit |
| Left drag on a part / empty space | move on the plate / select box |
| Shift + click | add to selection |
| Arrows, Ctrl + Up/Down | nudge 1 mm (Shift: 10 mm) following the view, raise / lower |
| Alt + drag | drag a copy |
| Hold R | rotate rings |
| Shift + F, click a face | slide the selected part along that face with the arrows |
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

## Tests
    node tests/kernel.mjs         shapes, groups, tool steps, joined export
    node tests/doc.mjs            history, rollback, project folder, crash recovery
    node tests/tools_repair.mjs   repair, make solid, open meshes in groups and cuts
    node tests/simplify.mjs       simplify stays within its surface limit
    node tests/walk.mjs           every function of the built page, headless
    node tests/browser.mjs        the built page, headless

The two browser tests need PUPPETEER_DIR and CHROME_DIR set.

## Licence
Source-available: Apache License 2.0 with the Commons Clause. Use it for personal and
commercial work alike. The models you make are yours alone to keep, sell or otherwise do as you please. 
Forking and making derivatives does not give you any right to sell this software or any derivative, add any paid subscriptions or features. 
Workingtitle3D is free, forever. Full terms in LICENSE.

Bundled libraries keep their own licences (MIT, Apache-2.0, ISC, Boost 1.0), listed in
THIRD-PARTY-NOTICES.txt and carried inside the built HTML file.

## Acknowledgements
Designed by Bootdsc, encabulated by Claude.

## Cyberdeck Cafe
Built at the Cyberdeck Cafe Workshop.
https://cyberdeck.cafe/
