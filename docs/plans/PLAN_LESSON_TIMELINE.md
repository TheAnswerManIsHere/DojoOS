```plan-oracle
# Oracle — step 3, brick timeline and lesson render, first version (prototype phase)

Agreed with David 2026-10-25 at the scope gate ("Go with your recommendations."); his words that opened it: "Let's keep building because I won't know how best to give you direction until we've gotten a bit further with the functionality for putting bricks together and seeing how they play. What's next?" On step 2: "directionally correct … uploading a file and setting in and out points to build bricks seems to be working well."

Direction: architecture.md §5 (the resolved EDL is the centre: one pure resolveCut → ResolvedEDL that both the browser preview and the ffmpeg render consume; one output clock; a transition of d overlaps two picture segments by d and the narration is cross-faded over the same d; a revision snapshots the resolved EDL), §6 (cuts, cut_bricks with per-cut overrides; a brick belongs only to the cuts that include it), §8 (brick timeline: order, transitions, per-brick trim, live preview, render; no multi-track view), §9 step 3 (brick timeline and lesson render; the preview-versus-export comparison on the worked example). Deck editor (3′) waits for one of Jared's real decks.

1. Design question: once a shoot's bricks are logged, can Jared turn them into a lesson he can watch — put them in order, trim, choose cut or dissolve between them — and see it play the way it will export, quickly enough that assembly stops being the slow part? And does what plays in the browser match the rendered file?
2. Hypothesis: a single strip of the lesson's bricks, defaulting to every closed brick of the shoot in source order, reorderable and trimmable by keyboard with a cut or a 1 s dissolve between each pair, played by a preview that reads the same ResolvedEDL the render reads, gets a logged shoot to a watchable lesson in minutes, and the render matches the preview.
3. Surface: a "Lesson" page per shoot: one lesson cut (16:9, camera mode) created on first open; the strip; add/remove a brick from the cut; reorder; trim overrides (cut-specific, the brick itself unchanged); transition per pair (cut / 1 s dissolve); live preview of the resolved lesson; Render → a worker job that builds an ffmpeg filtergraph from the same ResolvedEDL, renders from the originals, stores the file privately and writes a revision snapshot; the rendered file plays and downloads by signed URL; the feedback rail carries this feature's questions.
4. Leaves out: deck editor and deck render (3′); b-roll; punch-in visual effects (logged intent only, as agreed for step 2); retake alternatives; captions; templates beyond a fixed default (step 5); the short and 9:16 (step 4); multi-shoot lessons; approval locking beyond the revision snapshot; the voice window.

Decided by David: the strip starts with every closed brick of the shoot in source order; transitions are a hard cut and a 1 s dissolve; the render reads the originals.

Increment test — makes true: from a shoot with logged bricks, Jared builds a lesson, previews it, renders it, and plays the file. Bounded by: one shoot, one lesson cut per shoot, camera mode, 16:9, no paid AI call. Done when: the machine lanes show preview and render agree on the worked example's output clock (segment boundaries, dissolve overlap, total length), and Jared has built and rendered one lesson from Banana and Wishbone and answered the feature's questions.

Ceremony tier: prototype phase, regime main — short plan, Astra review, David's approval; then no code review; machine lanes scaled; merges on green CI.
```

# PLAN_LESSON_TIMELINE — step 3, brick timeline and lesson render, first version (short plan, prototype phase)

Workstream: DojoOS #1. Registry: *Feature phases*, "Brick timeline and lesson render (step 3)", `main` regime (#48).
The four items are the whole plan (`.agents/PLANS.md`); its product is the questions file.

## 1. The design question

Once a shoot's bricks are logged, can Jared turn them into a lesson he can watch — in order, trimmed, with a cut or
a dissolve between each pair — and see it play the way it will export, quickly enough that assembly stops being the
slow part? And does what plays in the browser match the rendered file?

## 2. The hypothesis

One strip of the lesson's bricks — starting as every closed brick of the shoot in the order it was filmed — edited by
keyboard and played by a preview that reads the same `ResolvedEDL` the render reads, gets a logged shoot to a
watchable lesson in minutes, and the rendered file matches the preview cut for cut.

## 3. The surface

- **Where:** a "Lesson" link on each shoot in the library opens `/shoots/:id/lesson`.
- **Membership:** the shoot's one lesson cut (kind lesson, mode camera, 16:9) is created on first open, holding
  every closed brick of the shoot as its own entry — overlapping bricks and short-tagged ones included, never
  merged, deduplicated or filtered by tag — ordered by file (the order the files were added), then by in point,
  ties broken by brick id (D1, for David). That selection is saved and kept on every later open; bricks logged
  afterwards are listed under "Not in the lesson", one key to add. The logging viewer's "play overlaps once" union
  plays no part here: a lesson plays its entries in the order he chose.
- **What he sees:** the strip — one tile per brick in output order, each showing its sprite frame, its trimmed
  length and its tags, with the transition after it (cut, or dissolve 1 s); the lesson's total length; a preview
  player; the render list (each render's number, time, length and a play/download link, its state shown while it
  runs); the feedback rail with this feature's questions.
- **Keys** (a keymap table held as data, as in step 2; capture suspended while a text field has focus): ←/→ select
  a brick; Shift+←/→ move it earlier or later; X remove it from the lesson (the brick itself is untouched); A add the
  selected brick from "Not in the lesson"; [ and ] trim the selected brick's in or out by a frame, Shift by a second;
  D toggle the transition after it between cut and dissolve; Space play / pause the preview from the selected brick;
  Esc undo; R render.
- **Every edit is a command** of the closed set (`architecture.md` §5): add, remove, move, trim, set transition,
  and their inverses, applied by `applyCommand` on the cut's state and recorded as `cut_events` rows owned by the
  cut. Trims and transitions are overrides on the lesson's `cut_bricks` rows, never edits to the brick. A trim never
  widens an entry past its brick's own span and always leaves a positive playable length. A transition belongs to
  its outgoing entry and applies to whatever entry follows it in the current order; the last entry's has no effect.
  **A dissolve must fit**: after every edit — trim, transition, remove, add or move — each dissolve's 1 s lies inside
  both neighbours, and the dissolves on either side of an entry never overlap inside it. An edit that would break
  that is refused with one line saying why, and the lesson stays as it was; Jared turns the dissolve into a cut and
  retries (D2, for David).
- **The resolver:** `resolveCut` in `shared`, pure, takes the cut's ordered entries with their overrides and the
  bricks they point at (its scaffold signature changes to say so), and produces the lesson's `ResolvedEDL` — picture and narration
  segments with their source spans and their output placement on one output clock, a 1 s dissolve overlapping its two
  neighbours by 1 s in picture and narration alike, total length = sum of spans − overlaps (`architecture.md` §5's
  worked example is its first test). Chapters, captions, slides and template layers are empty in this version.
- **Preview:** plays the `ResolvedEDL` from the proxies — two players, alternating, so a cut lands without a gap and
  a dissolve cross-fades picture and sound over its second. The preview shows the output time and which brick is
  playing.
- **Render:** R (or the button) freezes the lesson at that moment — the web server resolves it and writes a
  revision (number, the resolved EDL and the template defaults as they stood, digest) — and queues a `cut.render`
  job for that revision, so editing while a render waits cannot change what it produces. The worker renders the
  revision's snapshot, never the live cut: it reads each original it needs once
  (`architecture.md` §4; the download cap, §3), builds one ffmpeg filtergraph from the same `ResolvedEDL` — trims,
  cuts, a picture and audio cross-fade per dissolve, fit to 1920×1080 — renders H.264/AAC, stores the file under
  `renders/<revision id>.mp4`, and records its length, size and timings on the revision. The library page and the
  lesson page show the job's state while it runs (`async-ui-status.md`). The file plays and downloads by signed URL.
- **Questions file:** `artifacts/web/src/prototypes/lesson-timeline/questions.json`:
  1. How long did it take to get from logged bricks to a lesson you'd watch? (under 5 min, 5–15, 15–30, over 30)
  2. Did the preview play the way the rendered file plays? (yes / mostly / no — what differed?)
  3. Did starting with every brick in filmed order help, or would you rather start empty? (free text)
  4. Was cut-or-dissolve enough, or what transition did you reach for? (free text)
  5. What did you want to do on the strip that you couldn't? (free text)
- **Ledger of shortcuts** beside the questions file, one line each as taken.

## 4. What it leaves out

- The deck editor and deck render (3′), waiting for one of Jared's real decks.
- B-roll; the punch-in's visual effect (logged intent only, as agreed for step 2); retake alternatives.
- Captions; templates beyond fixed defaults (step 5); bumpers, lower thirds, loudness normalisation.
- The short and 9:16 (step 4); `clipRevision`; lessons drawn from more than one shoot.
- Approving and locking a revision beyond its snapshot; the voice window.

## Increment test

- **Makes true:** from a shoot with logged bricks, Jared builds a lesson, previews it, renders it and plays the file.
- **Bounded by:** one shoot, one lesson per shoot, camera mode, 16:9; no paid AI call.
- **Recognised when:** Jared has built and rendered one lesson from *Banana and Wishbone* and answered the questions.
  Before he is asked, the machine lanes show:
  - `ci`: unit tests of `resolveCut` on the worked example (B1 0–88 s, B3 87–332 s after the 1 s dissolve, B4
    332–382 s, total 382 s) and of every cut command and its undo, a trim at its brick's edge, and a dissolve refused — on a transition, and on a removal or move that changes its neighbours — with the lesson left unchanged.
  - `scripted`, on generated fixture sources — two files in one shoot — whose picture and tone identify which
    source and second is showing, arranged in the worked example's camera-only shape (three bricks, a 1 s dissolve
    then a hard cut, one transition crossing from one file to the other): the render has the resolver's length to
    within one frame, and at each segment boundary, inside the dissolve and either side of the hard cut, the
    sampled frame and tone are the sources the resolved EDL says; a browser journey builds the lesson by keyboard,
    plays the preview through the dissolve and the cut, seeks into the dissolve, and reads at the same output times
    the same sources playing, picture and sound; an edit made while a render is queued does not change the render.
  - `live`, read-only, on *Banana and Wishbone* in the Repl: the lesson page opens with every closed brick in filmed
    order and the preview plays.
