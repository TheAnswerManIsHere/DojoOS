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
  is free without a cap. The storage client speaks S3 only. The comparison
  missed the account's **daily download cap**, which at its free setting
  (1 GB a day) is smaller than one recording; David raised it to $1/day on
  2026-10-22 (`architecture.md`, storage).
- **AssemblyAI for transcription, as its own job after ingest** (2026-10-22,
  Claude's recommendation; the plan left the provider to the build).
  Compared on word timings, cost per audio hour and domain vocabulary:
  AssemblyAI Universal-3.5 Pro ($0.21/h, keyterms +$0.05/h, word times in
  ms), Deepgram Nova-3 (about $0.26/h by third-party listings), ElevenLabs
  Scribe v2 ($0.22/h), OpenAI `whisper-1` ($0.36/h, a 25 MB upload limit,
  and the only OpenAI model with word timestamps). All are within cents an
  hour, so the deciders were millisecond word times (the unit `transcripts`
  stores) and keyterm prompting for anatomy vocabulary. The interface makes
  a second provider one more implementation. The job reads the proxy's
  speech track, not the original, because of the daily download cap.
- **ElevenLabs Scribe v2 with keyterms, replacing AssemblyAI** (2026-10-23,
  decided by the paired pilot David ruled on 2026-10-22; issue #1). Six
  configurations — AssemblyAI Universal-3.5 Pro (`disfluencies` on), Scribe
  v2 and Scribe v2 Medical, each with and without a 30-term list from the
  lessons — on four of Jared's real takes, 32 minutes, $0.77. Terms: a tie;
  without the list each provider heard 64 of 70 occurrences both providers
  agreed on (all six misses were "under-hook"/"over-hook", most likely written
  as one word, so a matcher artefact), and with it every configuration heard
  all 70. Fillers: Scribe v2 kept 35 (28 timed), AssemblyAI 10 (7 timed), so
  `disfluencies` on 3.5 Pro keeps only a fraction. Word edges, judged against
  the audio's energy: median error 40–50 ms for Scribe against 49–75 ms for
  AssemblyAI on every lesson; the threshold is uncalibrated, so the ordering is
  the evidence, not the sizes. Verbatim: adjudicating every occurrence only one
  provider heard, Scribe's were real speech AssemblyAI dropped (an exchange
  with the partner, a background line), and AssemblyAI rewrote "hammy" as
  "hamstring" and "kinda" as "kind of". The term tie is partly by
  construction — under the every-provider rule a one-sided hearing is
  disputed, not a miss — so the term comparison is that adjudication:
  AssemblyAI had 1 disputed hearing, Scribe v2 4, all real speech. A rerun
  without `disfluencies` kept 4 fillers against 10 with it, so the flag
  works on 3.5 Pro but keeps far fewer than Scribe's 35. Scribe v2 Medical
  added nothing. Decided before the wake phrase could be tested (the footage
  does not contain it), on Claude's recommendation: the pilot's cache makes
  the undo one take that says it a dozen times, scored for about $0.10.
  Re-scored after the matcher learned that "underhook" is "under-hook"
  (#40): both providers heard all 70 occurrences without the list, so on
  these lessons the list changed no recognition (Scribe v2 Medical alone went
  from 68 to 70 with it); `TRANSCRIPTION_KEYTERMS` stays worth setting for
  rarer words, not for these. The
  four lessons were re-transcribed on Scribe v2 the same day, so no brick
  anchors to the losing provider's timings. Same price
  within cents. AssemblyAI stays implemented; `TRANSCRIPTION_PROVIDER=assemblyai`
  goes back.
- **No sign-in while in prototype phase** (David, 2026-10-24, overriding
  `architecture.md` §7's magic-link sign-in for now: *"This is ridiculous.
  We're building a prototype. No signing in. Remove it. If you need to keep
  track of who is doing what, it's fine to ask which user I am, David or
  Jared but no password or anything, just let me in. Once we're ready to go
  live and there's actual data that we care about, we can add a password."*).
  The development app asks who you are and lets you in: Jared as the tester
  account (the rail), David as the operator account (the Feedback page).
  On Claude's recommendation, taken and reported: the change applies to the
  development app only, and a published build keeps the emailed link, so a
  publish cannot expose Jared's lessons before the password David names
  arrives. Said once, beside the build: Jared's four real lessons are in the
  library, so anyone holding the development URL can watch them. Revisit at
  go-live, when the password replaces both.
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
