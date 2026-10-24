```plan-oracle
# Oracle — step 2, logging viewer, first version (prototype phase)

Agreed with David 2026-10-23 ("Go with your recommendations.") on the draft posted to DojoOS #1 that day.

Direction: architecture.md §5 (every edit is a command from a closed set; keymap as data), §8 (operator surface: logging viewer, keyboard-first, one pass per shoot), §9 step 2 (introduces the command set, the keymap and brick marking on any source; voice window placement is this plan's call; no flow A/B comparison).

1. Design question: can Jared log a real shoot in one watching pass from the keyboard alone — in, out, action and tags per keep-span — fast and accurately enough that logging stops being the slow part, and does the command set and key layout feel right?
2. Hypothesis: a keyboard-first viewer over the proxy, transcript under the playhead, every edit through applyCommand, with I/O snapping to the nearest Scribe word edge by default (Shift for the raw frame), lets him log near real time with edges he rarely revisits.
3. Surface: one page per ready source from the library — proxy player, peaks waveform and sprite scrubber, transcript strip, bricks as spans (nesting allowed) and a list; keymap table (space, J/K/L, I/O, A action, T tags, arrows nudge, Esc undo); "preview the keep" plays only marked spans; commands recorded in cut_events; the feedback rail carries this feature's questions file.
4. Leaves out: the voice window (v2, David agreed); the wake phrase and AI pre-pass; retake alternatives (asked, not built); timeline, assembly, templates, render; decks; flow A vs B; automatic subject location.

Decided by David: voice window in v2; word-edge snapping on by default; Jared logs "Banana and Wishbone" (13.4 min) first.

Increment test — makes true: open any ready source, mark/adjust/undo bricks by keyboard, bricks persist across reload, preview the kept spans. Bounded by: one source at a time, no cut assembled. Done when: after Jared logs one real lesson end to end, every question in the questions file has his answer.

Ceremony tier: prototype phase, regime main — short plan, Astra review, David's approval; then no code review; machine lanes scaled; merges on green CI.
```

# PLAN_LOGGING_VIEWER — step 2, logging viewer, first version (short plan, prototype phase)

Workstream: DojoOS #1. Registry: *Feature phases*, "Logging viewer with live preview (step 2)", `main` regime (#42).
The four items are the whole plan (`.agents/PLANS.md`); its product is the questions file.

## 1. The design question

Can Jared log a real shoot in **one watching pass, from the keyboard alone** — marking each keep-span with an in
point, an out point, an action and tags — fast and accurately enough that logging stops being the slow part of
making a lesson; and does the command set and key layout feel right in his hands?

## 2. The hypothesis

A keyboard-first viewer over the proxy, with the transcript under the playhead and every edit going through the
closed command set, lets him log at close to real time (1×–1.25× playback) with brick edges he rarely revisits —
chiefly because **I and O snap to the nearest word edge of the source's newest transcript by default** (Scribe v2,
chosen for its edges: `decisions.md`, 2026-10-23), and Shift+I / Shift+O marks the raw playhead when he wants it.

## 3. The surface

- **Where:** a "Log" action on each ready source in the library opens `/sources/:id/log`. One source at a time.
- **What he sees:** the proxy player; the peaks waveform as the timeline with the sprite as hover preview; a
  transcript strip with the word under the playhead highlighted; every brick of the source drawn as a span over the
  waveform (a brick inside another allowed, drawn nested) and listed beside it with its action and tags; the build's
  short SHA; the feedback rail with this feature's questions.
- **Keys** (a keymap table held as data in the feature's directory, so bindings change without code; key capture is
  suspended while a text field — the tag picker, the rail — has focus): space play / pause; J/K/L shuttle; I / O
  set in / out (word-snapped; Shift for raw); A cycles the target brick's action; T opens the tag picker (lesson,
  short, highlight reel, or typed); ←/→ nudge the target's nearer edge by a frame, Shift+←/→ by a second; Tab and
  Shift+Tab move the selection between bricks; Delete removes the selected brick; Esc undoes the last command
  (closing the picker first if it is open); P toggles **preview the keep**.
- **What a key acts on:** I opens a brick at the playhead; several may be open at once, nested, and O closes the
  most recently opened (innermost) one. A, T and the nudges act on the **open** brick if there is one, else on the
  **selected** brick; the target is outlined, and its action and tags show beside it.
- **Open bricks:** I creates a persisted **unfinished** brick — its in point, action and tags survive a reload,
  with the nesting order needed to resume marking; it is drawn visibly open and is **excluded from preview**. O
  supplies the out point and completes the innermost open brick; undoing O restores it to unfinished, back in its
  place among the open ones. A reload keeps every brick's state and starts a fresh undo stack.
- **Walkthrough, one pass:** at 0:40 he presses I (brick 1 opens, snapped to the word at 0:40.12). At 2:10 he
  presses I again (brick 2 opens inside brick 1), T, types "short", Enter. At 2:25, O closes brick 2. At 6:05, O
  closes brick 1; A sets its action to punch in, preset "lower third". Shift+Tab selects brick 2; → nudges its
  out point one frame later. Esc undoes that nudge. He reloads: both bricks, their tags and actions are there.
- **Actions in v1:** keep (default) and punch in with a named framing preset — recorded, shown, persisted and
  undoable, with **no visual effect** in the preview (D2, for David).
- **Preview the keep** plays the chronological **union** of the source's bricks — overlapping material once, gaps
  skipped (D1, for David).
- **Any ready source:** with no transcript, I/O mark the raw playhead and the strip says so; a missing sprite or
  peaks file is shown as absent rather than blocking the page. Brick times are stored in source milliseconds and
  never re-derived from a transcript, so a newer transcript moves no edit.
- **Commands:** the closed set in `lib/shared/src/commands.ts` gains the members this surface exercises — open,
  close, nudge edge, set action, set tags, delete — and `applyCommand(state, command)` is the only path by which a
  source's bricks change; each applied command carries what reverses it. Bricks stay in the existing `bricks` table
  (action in `attributes`, tags in `tags`), and are authoritative.
- **Events:** `cut_events` gains source-owned events — a row names a cut or a source, exactly one — by one small
  migration; each applied command writes its brick change and its event in one transaction. The journal is a usage
  record and is never replayed (`architecture.md` §5). Undo reverses the last command within the session.
- **Wiring:** the page is registered in client routing and the server's page allow-list; the feedback rail accepts
  this feature and page and loads its questions; the sprite and peaks are served to the page by signed URL like the
  proxy.
- **Questions file:** `artifacts/web/src/prototypes/logging-viewer/questions.json`, rendered by the existing rail:
  1. How long did logging this lesson take, against its length? (choice: under 1×, 1–1.5×, 1.5–2×, over 2×)
  2. How often did you fix a brick's edge after marking it? (scale 1–5)
  3. Did snapping to word edges help or get in the way? (choice: helped, neutral, got in the way)
  4. Which keys felt wrong, and what would you press instead? (free text)
  5. Did you want to mark retakes as alternatives of one moment? (choice: yes, no, sometimes)
  6. Would you rather say commands than press keys? (scale 1–5)
- **Ledger of shortcuts** beside the questions file, one line each as taken.

## 4. What it leaves out

- The voice window — version 2 (David, 2026-10-23).
- The wake phrase and any AI pre-pass (brief, Q21).
- Retake alternatives of one beat (asked, question 5, not built).
- Insert b-roll as an action: it needs a picker for a second source, which is the brick timeline's (step 3).
- The brick timeline, assembly, templates, render (step 3); decks (3′); flow A vs B (step 4); automatic subject
  location (framing presets only, `architecture.md` §5).

## Increment test

- **Makes true:** Jared can open any ready source, mark, adjust, tag and undo bricks by keyboard, see them persist
  across a reload, and preview only the kept spans.
- **Bounded by:** one source at a time; no cut is assembled; no paid call.
- **Recognised when:** after Jared logs *Banana and Wishbone* (13.4 min) end to end, every question in
  `questions.json` has his answer through the rail. Before he is asked, the machine lanes show:
  - `ci`: unit tests of `applyCommand` (open, close, nudge, action, tags, delete, and each one's undo, including
    undoing O back to an open brick) and of word snapping; typecheck.
  - `scripted`, on a **playable fixture served locally** (the step-1 journey's unreachable bucket proves signed-URL
    wiring, not moving media): ordinary and Shift I/O store the expected source times; marking works on a source
    with no transcript; the walkthrough above runs through the real command route, writing source-owned events with
    no cut; an open brick survives a reload and is excluded from preview; preview skips a gap and plays overlapping
    material once.
  - `live`, read-only, on *Banana and Wishbone* in the Repl: the proxy plays and moves, its sprite and peaks load,
    the transcript highlight follows the playhead, and the feature's questions render on the page.
