# Lesson timeline — ledger of shortcuts (prototype phase)

One line per shortcut, as it was taken. At the flip to production this list is the hardening PR's scope.

- The rail shows every question as a free-text box; the choices are written into the prompt rather than rendered as buttons.
- Undo lives in the page for the session only; a reload starts a fresh undo history (as in step 2).
- Two tabs on one lesson can interleave commands; the server serialises them per cut, the other tab's view is stale until reload.
- Every command answers with the whole lesson, re-read and re-resolved, rather than a diff.
- Trimming outward uses `,` and `.` (extend the in and out point); `[` and `]` only tighten. The plan named `[ ]` alone, which gives one direction per edge.
- A brick shortened or deleted in the logging viewer after it joined the lesson: a deleted or reopened one drops out of the lesson silently; a shortened one keeps its trim deltas, clamped to the new span, and a dissolve that no longer fits is shortened by the resolver to fit rather than refused (only new edits are refused).
- The render's settings (1920×1080, 30 fps, H.264 CRF 20 veryfast, AAC 160k) are fixed in code (`renderDefaults`, `renderSize`), not read from a template.
- The worker downloads every original the lesson uses in full before rendering, one at a time; disk use is the sum of those originals.
- A source with no picture renders black, one with no sound renders silence; the preview just shows nothing for them.
- Preview proxy links expire after five minutes; a player that errors fetches a fresh link and re-cues, which can hitch once.
- The preview's output clock follows the playing player's own time, so a stall stalls the preview; a hard cut can show one extra proxy frame of the outgoing brick.
- Render progress is polled every 3 s while a render is queued or running (the library every 5 s); there is no percentage.
- The lesson's name is the shoot's name plus "— lesson"; one lesson per shoot, made on first open.
- Download is a signed link with an attachment filename; the file is named after the lesson and render number.
- The Edited view (2026-11-06): the lesson's entries are re-derived from the bricks on every read, command and render (`syncEdit`), with no cache and no event recorded for the derivation.
- Reordering, adding and removing bricks are gone from the page; their commands still exist in `lib/shared/src/lesson.ts` and the route still accepts them.
- In the Edited view a brick's edges are not editable; edges move in the Original view, and the edit follows.
- The "kept" length on the switch is this file's bricks only, before dissolves; the Edited view shows the whole shoot's length.
- Going back to Original from a brick on another file opens that file's page, losing this page's undo history.
- A dissolve drag does not scroll a zoomed strip.
