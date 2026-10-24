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
- The waveform is drawn once at a fixed 1000-pixel width and stretched to fit.
- Brick nesting is drawn by containment depth only; partly overlapping bricks share a row offset by how many contain them.
