# DojoOS — product brief

Drafted 2026-09-27 from David's brief (2026-09-25), the rule-based video editor
brief (claude.ai thread, Aug 29–Sep 25) and the grilling of 2026-09-25/27
(Q1–Q31). Settled means David decided it in words; a recommendation of mine he
overrode is marked *over dissent* so the next session neither re-raises it nor
mistakes it for a first-principles conclusion.

## What DojoOS is

DojoOS supports the business of Dr. Jared Cooper, DPT, a physical therapist
who produces NCBTMB-approved continuing-education content for massage
therapists under the name **Bodywork Dojo** (bodyworkdojo.com; NCBTMB
Approved Provider #1708). Today the business runs on Kajabi, a generic
course platform carrying his LMS, CMS, CRM, payments, certificates and
marketing automation. DojoOS replaces Kajabi with a purpose-built platform
that does exactly what Jared needs and nothing else, and adds the one thing
Kajabi cannot: a video-production pipeline built around how he shoots.

**The user is Jared, alone.** David uses it for testing. The platform is
optimised so that Jared pays nobody to edit, publish or operate it, which
makes ease of use the product requirement rather than a preference. It is
single-tenant, bespoke, and never needs large-scale deployment.

Business owner: Jared Cooper. Product manager: David. Engineer: Claude Code,
with Codex reviewing and Replit hosting, under the AI-Handbook contract.

## Facts (looked up 2026-09-25; not decisions)

- bodyworkdojo.com: per-course purchase with lifetime access, a free mobile
  app, live and on-demand formats, some courses APTA-approved for PTs, "over
  7,824 therapists have completed courses".
- NCBTMB provider FAQ: "One hour of video or audio equals 1 CE." A
  certificate must carry the participant's name, the exact course title,
  completion date, course type, provider number, CE count, provider name and
  signature. "All certificates, class rosters, and student attendance
  records be kept for six (6) years."
- The existing Repl "Bodywork Dojo CE Platform" is a throwaway proof of
  concept; nothing in it persists (David, 2026-09-25). The DojoOS GitHub
  repository is empty.

## Modules, and the order they come

Logical modules of one application, built in phases; never microservices
(Q3). Each gets its own grilling when its increment comes (Q31); the
paragraphs below are the boundary, not the design.

1. **Video production pipeline** — increment 1, and the business's current
   bottleneck. Everything under *Increment 1* below.
2. **LMS** — the second core. A curriculum with a recommended order that
   learners may ignore; courses organised by modality (trigger point,
   deep tissue, myofascial release, IASTM, myofascial stretching, cupping),
   by clinical assessment per body region, by advanced bodywork per body
   region, and by pathology. Each course opens with a liability waiver,
   awards CEs by NCBTMB rules, ends with a quiz, and issues a certificate
   (name, course, licence number, date) the learner can email, text or
   print. Progress is saved; badges or awards are a candidate. Kajabi
   migration of learners and completions is an LMS question.
3. **CMS** — the public site, currently Kajabi pages.
4. **Marketing automation and CRM** — modelled on standard tools; may be an
   integration (HubSpot or similar) or a small native module, decided when
   the requirement set is known.
5. **Payments and certificate tracking** — with the LMS.
6. **Publishing** — upload, sharing and tracking of finished videos to
   Kajabi, YouTube and social platforms, so DojoOS becomes the one-stop
   shop (Q8). Later; increment 1 stops at files.
7. **B-roll library** — a bounded tool that brings stock footage, stock
   photos and bricks from other shoots into the library (Q23). Later.

## Increment 1 — the video production pipeline

### Product intent

Take Jared from a shoot to a complete, upload-ready video as quickly and
simply as possible (Q8), starting with the footage he has already shot,
which is the business's current blocker (Q24, *over dissent*: I recommended
the backlog as increment 2 and David ruled it the top priority). Kajabi
stays live throughout.

### How it works (settled)

- **The human logs, the machine assembles** (Q14, *over dissent*: I
  recommended AI-first segmentation with human correction). Jared watches
  every raw shoot start to finish in a viewer with buttons: mark in, mark
  out, an action (cut, punch in, insert b-roll, …) and tags (for example
  "highlight reel"). The result is a human-judged EDL at ingest, like
  documentary footage cataloguing with edit decisions attached. The AI
  pre-pass — auto-tagging sections, flagging defects, reading in-video
  instructions Jared speaks to a wake word ("Editor, punch in now") — is
  wanted and is **not** built up front (Q21): the manual watch ships first
  and the pre-pass is layered on where it measurably saves him time.
- **Bricks** (Q23). A brick is a keep-span of one source with in and out
  points, a transcript slice and attributes. Anything not inside a brick
  is cut, so dead-space removal is the absence of a brick. A retake is
  several bricks marked as alternatives of one beat with one chosen.
  Punch-in is an attribute. Tags name which cuts a brick belongs to.
  Transitions belong to the assembled cut, between two bricks. **B-roll is
  a brick whose source is not the shoot** — stock footage, a stock photo,
  or a brick from another shoot — never derived from the raw footage.
- **Assembly and review** (Q22). The machine assembles a cut from the
  bricks, tags and template; Jared reviews it before render on a brick
  timeline: bricks in order, transitions between them, a precise in/out
  trim tool per brick, reorder possible but rare since his content is
  shot in order, duration shown by rough magnitude rather than true scale,
  live scrub preview with the edits applied and no render wait, then a
  final render pass. Simplicity first, power behind a click, never a
  multi-track NLE. The GUI is expected to iterate.
- **Two cuts from the same bricks** (Q6): the lesson (16:9, long form,
  chaptered) built first, and the short (vertical, captioned, punched in).
  Both publishable as approved, with no outside finishing (Q8); the short
  carries whatever social formats need, captions included.
- **Templates, not fixed presets** (Q26). A template holds what a cut
  applies on top of the bricks: caption style, default transition,
  punch-in scale, lower thirds, bumpers, sound effects, loudness. Jared
  can build new templates and modify both a template and a cut after it is
  applied; templates are data from day one; a template-editing screen
  follows the first two templates; iteration must be easy.
- **Files out, no LMS objects** (Q2). A rendered cut is a downloadable file
  with metadata (title, chapters, duration, CE minutes) and a stable
  identifier the LMS attaches to later. Jared uploads to Kajabi, YouTube
  and socials by hand; publishing APIs are a later module (Q13).
- **Footage** (Q10). A shoot is 30–60 minutes of content. Future shoots are
  standardised on 4K, single camera, camera audio; the input model allows
  a second camera and a separate audio file from day one, but two-camera
  work and external-audio sync are *next* (Q18, Q27). The existing library
  is whatever it is, and increment 1 handles it as first-class, with
  punch-in on lower-resolution originals accepted as softer.
- **Storage and compute** (Q11). Originals cold and proxies hot in
  S3-compatible object storage — **Backblaze B2**, with Cloudflare R2 as the
  fallback; the comparison of ten options is in
  [`architecture.md`](architecture.md) and the decision in
  [`decisions.md`](decisions.md). A browser resumable uploader; a media
  worker that transcodes, makes proxies, transcribes and renders, pulling
  originals only at ingest and render. Sizing: 22–45 GB per hour of 4K
  original at the worst case, about 6 GB per hour for today's files,
  ~2.7 GB per hour of 1080p proxy.
- **Operator** (Q4). Jared, with David for testing; no roles beyond the
  tester tier the handbook's prototype phase requires.
- **Publishing is David's** (Q30). Claude merges to `main` and stops; David
  tests in the development environment and publishes when he chooses.

### Must not change

- Jared never touches a timeline in the NLE sense; the brick timeline is
  the most he sees.
- A cut Jared approves is the file that ships; anything he would have to
  fix elsewhere is a defect.
- One logging pass per shoot serves every cut; bricks are never copied
  per output.
- Kajabi keeps running until the LMS replaces it.

### Now / next / never

- **Now**: manual logging viewer; brick model; lesson and short cuts;
  templates as data with per-cut overrides; object storage, uploader,
  worker, proxies, live preview, render; ingest of the existing library;
  feedback rail and tester tier (prototype phase requirements).
- **Next**: AI pre-pass (auto-tags, defect flags, wake-word instructions);
  external-audio sync; two-camera shoots; a desktop or watch-folder
  uploader if the browser path proves fragile for 20–45 GB files; template
  editing screen; b-roll library tool; thumbnails, titles and written
  derivatives.
- **Never** (for this module): a multi-track NLE; publishing APIs inside the
  pipeline (they are the publishing module); AI choosing which bricks go in.

### Jared's answers (Q25, relayed by David 2026-09-29)

- About 30 hours exist; 1 to 5 hours are added per month.
- Most is 1080p; new material is 4K. A shoot is 5 to 10 files of 10 to 60
  minutes, "a few gig" each.
- Audio was captured on camera with a lav mic.
- Both unproduced courses and uncut marketing are blocked; generating
  courses is the current priority.

### Adopted from the Astra exchange (2026-09-27; technical, mine to settle)

- **Bricks are shared references; trims, framing and retake choices are
  cut-specific overrides.** Editing a short or a template never silently
  changes an approved lesson.
- **An approved cut is an immutable revision**, and its rendered file and
  metadata belong to that revision; a later edit makes a new revision.
- **Picture and audio are composed independently inside the renderer**,
  behind the same brick interface, so b-roll can replace picture while
  narration continues (the default behaviour is David's call, below).
- **Framing is a region, not a scale**: a brick's punch-in stores the
  region that must stay visible, per output orientation, and may change
  over time.
- **All source media, transcripts and exports are behind authenticated
  operator access** from day one; public distribution is the publishing
  module's job.
- **Proxy creation reads the original once at ingest**; "originals only at
  render time" is the rule after that.
- **Transcription runs through a hosted provider called from the worker**;
  the provider is a plan decision.

### Settled by David after the Astra exchange (2026-09-27)

- **Q32** — when b-roll is inserted, Jared's narration continues underneath
  by default.
- **Q34** — framing controls per brick per output are in increment 1,
  simple, with an always-visible vertical crop box.
- **Q35** — a simple caption editor Jared can click on is in increment 1.

### Added by David during architecture planning (2026-09-29 to 2026-10-03)

- **The AI rule, precisely**: AI may propose bricks, tags and retake
  choices; only Jared's acceptance puts a brick in a cut. A spoken editing
  request is classified into a closed command taxonomy, never interpreted
  as an open-ended edit.
- **Overlapping bricks**: a 30-second lesson brick and a 3-second short
  brick may cover the same source moment; a brick belongs only to the cuts
  that include it.
- **Two flows from shoot to short**, both built: one logging pass for both
  cuts, or the rendered lesson re-logged for the short. A short from a
  finished lesson uses the short's own template.
- **Deck mode**: PowerPoint-based lessons with Jared's voice over the
  slides, in three layouts (voice-over only, video on the right, a small
  corner overlay), and decks as b-roll.
- **Keyboard-first editing with voice**: space plays and pauses, Enter
  opens a spoken editing request, arrows and brackets adjust.
- **Both course modes are blocked** in similar measure: the logging viewer
  comes first, then the deck editor or brick timeline per course.

### Risks Astra named that the brief did not

- The backlog may stay blocked by Jared's own time: the manual-first
  decision accepts a watch of every hour plus review of two cuts each.
- A crop can remove the hands or the contact point even at acceptable
  sharpness; framing regions are the mitigation.
- A shared edit could invalidate an earlier approval; immutable revisions
  are the mitigation.

### Technical premises (mine, stated so they can be checked)

- The live preview plays a low-resolution proxy in the browser; the render
  uses originals.
- "AI assembles" means deterministic assembly from the EDL and template,
  with AI used for captions, titles, chapter names and suggestions, never
  for choosing bricks. (Settled precisely by David on 2026-09-29; see
  above.)
- A Repl carries one deployment (measured 2026-09-29), so web and worker
  run as two processes under one supervisor in one Reserved VM; see
  [`architecture.md`](architecture.md).

## Vocabulary

**Shoot** — one capture session, one or more source files. **Brick** — a
keep-span of a source with attributes. **Cut** — an assembled output
(lesson cut, short). **Template** — what a cut applies on top of bricks.
**Library** — all bricks across shoots, including b-roll. "Project" is
avoided because it would mean two things.

## Process decisions carried from the handbook

- The first product feature is a **prototype** of the logging viewer and
  the live preview (Q17), in prototype phase under the handbook's
  per-feature phase rule: its first version runs the short planning loop
  with Astra and David's approval; no code review, no tests, feedback
  through the feedback rail, David publishes. DojoOS has nothing downstream
  of `main`, so prototype-phase features live on `main`.
- The architecture went through the full planning loop (scope plus four
  Astra exchanges) and was approved by David on 2026-10-03; it is
  [`architecture.md`](architecture.md). The scaffold was built by Replit
  Agent from a constraints brief and reconciled to the approved plan the
  same day.
