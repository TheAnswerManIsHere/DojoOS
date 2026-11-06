# Logging viewer — ledger of shortcuts (prototype phase)

One line per shortcut, as it was taken. At the flip to production this list is the hardening PR's scope.

- The rail shows every question as a free-text box; the choices are written into the prompt rather than rendered as buttons.
- Undo lives in the page for the session only; a reload starts a fresh undo history (as planned).
- Two browser tabs on one source can interleave commands; the server serialises them per source, the second tab's view is stale until reload.
- The peaks file is relayed through the web server in one read, with no caching.
- The framing presets (lower third, centre, upper third) are a fixed list in `lib/shared/src/commands.ts`, not read from a template.
- Tags are lowercased and capped at 20 per brick, 40 characters each.
- J jumps back 5 s and L steps the speed up to 2× and back to 1×: browsers cannot play video backwards, so there is no reverse shuttle.
- The rail's answers carry only the feature in their state, not the page's bricks.
- The waveform is drawn at a fixed 1000-pixel width for the window shown and stretched to fit; zoomed in deep it turns blocky (20 points a second), which David accepted (2026-11-06).
- Lanes are recomputed from every brick on each render, with no memo.
- The one editor (2026-11-06): the strip's zoom lives in page state only; a reload opens at fit.
- The view follows the playhead only when playback carries it off the right edge from inside the view; there is no follow setting.
- A pinch is read from two pointers on the strip; iPad Safari's own gesture events are not used.
- An edge drag sends one nudge when it lets go; nothing is saved while dragging, so a dropped connection mid-drag loses the drag.
- The transcript box measures its lines from the rendered words at its width; a font that loads late can leave one page misjudged until the next resize.
- Automatic note creation and the transcript size are remembered per browser in localStorage, not per account.
- Label colours are fixed in the page (lesson blue, short orange, highlight purple), not read from a template.
