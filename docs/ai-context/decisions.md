# DojoOS — settled decisions and why

One entry per decision that should neither be re-raised nor mistaken for a
first-principles conclusion. **Settled** means David decided it in words;
**technical** means the builder settled it in the planning loop, revisable
with new evidence; **over dissent** records whose recommendation was
overruled. Newest last. Product truth that is not a decision lives in
[`product-brief.md`](product-brief.md); the design is
[`architecture.md`](architecture.md).

## Product

- **Q3 — modular monolith** (settled, 2026-09-25). One codebase, one
  Postgres; modules built in phases; the media worker is the only separate
  process. Never microservices.
- **Q14 — the human logs, the machine assembles** (settled, *over
  dissent*). Claude recommended AI-first segmentation with human
  correction; David ruled manual logging first, with the AI pre-pass
  layered on later where it measurably saves Jared time.
- **Q24 — the existing library is the top priority** (settled, *over
  dissent*). Claude recommended the backlog as increment 2; David ruled it
  the current blocker, so increment 1 consumes it.
- **Q32, Q34, Q35** (settled, 2026-09-27). Narration continues under b-roll
  by default; framing controls per brick per output now, with an
  always-visible vertical crop box; a simple caption editor now.
- **The AI rule** (settled, 2026-09-29; extended 2026-10-03). AI may
  propose bricks, tags and retake choices; only Jared's acceptance puts a
  brick in a cut. A spoken editing request is classified into a closed
  command taxonomy; the model never interprets an open-ended edit.
- **Overlapping bricks** (settled, 2026-09-30). A brick has no exclusive
  claim on source time; dead space is per cut.
- **Two flows from shoot to short, both built** (settled, 2026-09-30, David's
  own proposal). Flow A logs once for both cuts; flow B re-logs the
  rendered lesson for the short. Jared's feedback at step 4 picks the
  default; the other stays available.
- **A short from a finished lesson uses the short's template** (settled,
  2026-09-30, "Option 1"). Lesson graphics replaced, bumpers omitted,
  picture and narration kept exactly as composed, shown before approval.
  Keeping the lesson's presentation was the declined alternative.
- **Deck mode in three layouts, decks as b-roll** (settled, 2026-10-03).
- **Keyboard-first editing with a voice command window** (settled,
  2026-10-03).
- **Both course modes are blocked in similar measure** (settled,
  2026-10-03, "3"). Viewer first, then deck editor or brick timeline per
  course.
- **Publishing is David's, every time** (settled, Q30).

## Technical (settled in the architecture loop, 2026-09-29 to 2026-10-03)

- **One Reserved VM, two processes under one supervisor.** A Repl carries
  one deployment (measured 2026-09-29) and a second Repl does not share the
  first's managed database. The job queue is the boundary, so the worker
  can split out later without changing a caller.
- **Postgres job queue with no idle timer.** Replit bills database compute
  per active hour and keeps a database active five minutes after each
  request; a ten-minute poll would cost about $58 a month and the original
  two-second poll about $115. The worker is nudged over localhost on every
  enqueue, drains at startup, polls every six hours as a safety net, and
  schedules a claim only at the lease expiry of interrupted work.
- **Backblaze B2, R2 as fallback.** Compared against eight other stores on
  2026-09-30 (table in `architecture.md`): cheapest at both Jared's current
  and worst-case sizes, S3 API, egress allowance of three times stored
  volume covers preview and render. R2 is the fallback because its egress
  is free without a cap. The storage client speaks S3 only.
- **ffmpeg for probe, proxy and render; MLT the fallback.** Compared on
  2026-09-30 against MLT, GStreamer Editing Services, hosted render APIs
  and Node wrappers: every credible option is ffmpeg or wraps it, and the
  hosted alternative costs more than the machine and caps resolution.
- **The resolved EDL is the centre.** One pure resolver produces the one
  artefact both preview and render consume, on one output clock; an
  approved cut is an immutable revision that snapshots the resolved EDL and
  template values.
- **Render-backed bricks clip a revision's composition** (Astra, round 3).
  Picture and narration independently, partial transitions kept, original
  source coordinates retained for reframing.
- **Slide cues anchor to narration, not to the output clock** (Astra,
  round 4), so a trim before a cue never moves the page off its words.
- **Undo reverses one operation within the records it owns** (Astra,
  round 4); the command journal is a usage record and is never replayed,
  because a replay would restore stale shared bricks.
- **A spoken framing hint names a preset region.** Whether the system
  should locate the subject automatically is David's question, deferred
  to the logging viewer's first-version plan.

## Process

- **The architecture went through the full planning loop**; the Replit
  scaffold built on 2026-09-29 before that loop ran was a process error
  (the approval ask omitted the loop step), parked, then reconciled to the
  approved plan on 2026-10-03 rather than discarded.
- **Built on Fable** at David's say-so (2026-10-03), then switched to Opus
  by David before the reconcile was sent.
