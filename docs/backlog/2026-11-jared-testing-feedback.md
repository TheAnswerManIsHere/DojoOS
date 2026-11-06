# Backlog — feedback from testing with Jared (2026-11-06)

Working notes while David feeds the list item by item. Each entry: what he
asked for, what the code does today, the recommendation, open questions.

## 1. Bulk upload — pick or drop many files, start them in one go

**Asked:** open a folder, multi-select files, start the whole transfer at
once, without pressing "add a file" again for each one.

**Today:** `artifacts/web/src/components/upload-manager.tsx` reads only
`files?.[0]` from the picker and from a drop, and one *What is it?* role
(Camera A / Camera B / Audio) applies to the single file. The server already
allows any number of files per role on a shoot, so this is a browser-only
change (the uploader is in the Ingest feature, prototype phase).

**Recommendation:**
- Picker and drop zone accept many files (`multiple`).
- The chosen files appear as a list. Each row shows a role that is guessed
  and can be changed: an audio file → Audio, a video → Camera A. Then one
  **Upload all** button.
- Files go up one at a time, in order. Bandwidth is the limit, so running
  them in parallel would not finish the batch sooner, and it would hide
  which file is in flight. Each row shows its own progress and status.
- A file that stops does not stop the batch. The next file starts, and
  choosing the stopped files again continues them, as now.
- Not now: picking a whole folder (`webkitdirectory`). It brings camera
  sidecar files (.XML, .THM) along, and in a normal multi-select Jared
  can already press Ctrl/⌘-A inside the folder.

**Revised (David, 2026-11-06):** the Camera A / Camera B tagging is going to
be redone, so bulk upload does not design around roles. Build it so a role
per file can be added later. For now each file gets the role that is
picked once for the whole batch, as today.

## 2. The strip — naming it, zooming in and out like Premiere, and a scroll bar

**Name:** **the strip**. That is already its name in the code
(`artifacts/web/src/player/strip.tsx`) and its comments. "Timeline" is
already taken by the lesson timeline. It goes into the glossary.

**Today:** one shared component draws the strip under every player: the
logging viewer, the brick editor and the lesson timeline. It always fits its
whole range (the full source, the brick plus a margin, or the full lesson)
into the width of the window.

**Recommendation:** zoom lives in the shared strip, so all three get it.
- **Controls, Premiere's:** `=` and `-` zoom in and out around the playhead,
  `\` fits the whole range, and Ctrl/⌘ + scroll wheel (or a trackpad pinch)
  zooms around the pointer. All three keys are free in both keymaps today.
- **Scroll bar** under the strip, whenever the strip is zoomed past fit. As in
  Premiere, dragging its ends zooms too.
- **While it plays, the view follows the playhead**, a page at a time, so the
  playhead never runs off screen. Scrolling by hand stops the follow until
  the next play.
- **Limits:** zoomed all the way out shows the whole range. Zoomed all the way
  in is about 3 seconds across the window (decided below).

**A limit worth knowing (measured from the code):** the waveform data has
20 points per second (`lib/shared/src/media.ts:22`, one point per 50 ms). A
video frame is about 33 ms, so zoomed in to frame level the waveform turns
into blocks. Two ways to handle that:
1. **Cap the zoom** where the waveform still looks smooth, about 10 seconds
   across the window. No change to processing.
2. **Make a second, more detailed waveform** (about 200 points per second),
   loaded only when zoomed in deep. That is a worker change, and every
   existing source has to be processed again.

**Decided (David, 2026-11-06):** neither one. The waveform's detail is not a
concern. The deepest zoom only has to make frame-level edits easy, without
going to extremes. So the deepest zoom shows about 3 seconds across the
window, which makes one frame about 10 pixels wide on a laptop screen. At
that zoom the waveform looks blocky, and that is accepted. Waveform
processing does not change.

## 3. Remove the word ticks from the strip

**Today:** the strip shows the waveform and, under it, one tick per word.
They were stacked on purpose so the two could be compared "before one of
them goes" (strip.tsx, line 1). This is that decision: the waveform stays.

**Recommendation:** delete the ticks and the row they sit in. Word-by-word
navigation with the keys does not use the ticks, so it is unaffected.
Small; it rides in with item 2.

## 4. The transcript box — a fixed 3 lines (5 or full on request), turning a page at a time

**Asked:** by default the box is 3 lines high, and it can be expanded to 5
lines or to the full transcript. The box fills with as much text as fits, and
the first word is bold. During playback the lines stay where they are and
the bold moves forward word by word. When it reaches the end of the last
line, the next lines load and the bold starts again on their first word.
The aim is that a person can follow which word is playing.

**Today:** the logger and the lesson page show the words within ±6 s of the
playhead (`logging-viewer.tsx:253`, `lesson-timeline.tsx:409`). That window
slides every moment, so the text never stays still, which is the problem
being described. The brick editor shows every word of the brick and the
seconds around it, with no limit on height (`brick-editor.tsx:109`). All
three highlight the current word, but only while the playhead is inside it,
so during a pause between words nothing is highlighted.

**Recommendation:** one shared transcript box, used by the logger, the
brick editor and the lesson page.
- **Pages come from the box's real layout.** Pages are measured from where
  the browser actually breaks the lines at the box's current width. They
  run one after another and never overlap: page 2 starts on the word after
  page 1's last word. A narrower window means more pages, and resizing
  measures them again.
- **The highlight never changes a word's width.** Real bold text is wider
  than regular text, so making one word bold could push a word onto the
  next line, and the lines would jump with every word. That is exactly what
  the item is trying to stop. The current word gets the gold highlight it
  has today plus a bold look that takes up no extra space. Lines stay put.
- **Between words, the last word spoken stays highlighted** until the next
  one starts, so the highlight never disappears during a pause.
- **A seek or a word-key step goes to the page holding that word.** The
  highlight lands on that word, not on the page's first word.
- **The size control:** 3 lines / 5 lines / Full. The choice is remembered
  in this browser and applies to all three players.
- **Full** shows the whole transcript in a scrolling box and keeps the same
  rule: it stays still while the highlight moves, and jumps only when the
  highlight would leave the view, putting that line at the top.
- **The brick editor** keeps dimming the words outside the brick.

**Offered, not asked:** clicking a word moves the playhead to it. It is
cheap once the box exists. Included only if David wants it.
