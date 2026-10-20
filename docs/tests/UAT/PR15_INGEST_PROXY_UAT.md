# PR #15 — Uploaded footage becomes a watchable proxy — UAT

**Workstream:** #1

After a file uploads, the worker now makes a small, seekable proxy of it, a strip of thumbnails and a waveform, and the library plays the proxy in the browser. This is the first part of step 1; transcription and decks come in their own PRs. Everything a machine can check is checked by one; the one step left for you is whether Jared's own footage looks and sounds right as a proxy.

## Setup

- [claude] Confirm the Repl is synced to this PR's merge commit and the worker restarted after the sync.
- [claude] Upload Jared's "Adductor Stretch.mov" (from his shared Drive folder) into Test Shoot 1 through the app's own multipart API as the tester account, and wait for its source to reach `ready`.
- [restore] Nothing: the uploaded source is the step-0 acceptance file and stays in Test Shoot 1.

## Steps

### 1. A ready source offers Play and plays its proxy through a short-lived signed link

**Do:** Sign in, open the library, and press Play proxy on a ready source that has a proxy.
**Expect:** A video player appears whose address is the source's proxy (never its original), signed, valid for five minutes; a source still `proxying` shows no Play button.
**Lane:** ci
**Check:** `artifacts/web/server/journeys/step1-browser.test.ts`

### 2. The proxy, thumbnails and waveform are made correctly

**Do:** Make the proxy, sprite and peaks from generated landscape, portrait, larger-than-1080p and audio-only clips.
**Expect:** H.264/AAC proxy at the source's size up to 1920×1080, orientation kept, index first; one sprite image sized exactly as the shared layout says; one waveform pair per 50 ms at the audio's real level; no audio means an empty waveform.
**Lane:** ci
**Check:** `artifacts/worker/src/media.test.ts`

### 3. A long encode is not killed when it outlasts its lease

**Do:** Run a job five leases long while its worker renews the lease; separately, refuse a renewal, and answer a renewal only after its job has finished.
**Expect:** The long job completes once with no reclaim attempt; the job whose renewal is refused stops and is not completed; a late answer arms nothing and causes no extra claim. A failed attempt is queued again until the third, then left failed with its error.
**Lane:** ci
**Check:** `artifacts/worker/src/runner.test.ts`

### 4. The library follows a source through ingest without a reload

**Do:** Open the library while a source is `proxying`, then let it finish.
**Expect:** The state changes to `ready` and Play proxy appears on its own, within a few seconds; the page stops refreshing once nothing is in ingest.
**Lane:** ci
**Check:** `artifacts/web/server/journeys/step1-browser.test.ts`

### 5. A failed source shows its error and can be processed again

**Do:** Open the library with a source whose ingest failed, and press Process again.
**Expect:** The failure's error text is shown beside the state; Process again puts the source back to `uploaded` with one ingest queued, and the button does not offer a second retry while that one is queued. A source marked ready before ingest made proxies (step 0's) offers Process again too.
**Lane:** ci
**Check:** `artifacts/web/server/journeys/step1.test.ts`

### 6. Playback that cannot continue leaves a way to try again

**Do:** Play a proxy whose link cannot be loaded.
**Expect:** The player fetches a fresh link once on its own; when that also fails it says "The proxy could not be played. Press Play to try again." and shows Play again.
**Lane:** ci
**Check:** `artifacts/web/server/journeys/step1-browser.test.ts`

### 7. Jared's file is ingested on the Repl with its measurements recorded

**Do:** Read the Adductor Stretch source row and its completed ingest job through the connector.
**Expect:** The source is `ready` with a proxy, sprite and peaks key; the job's result shows the original's size and bitrate, probe time, and the proxy's wall time and peak memory.
**Lane:** live
**Check:** `psql "$DATABASE_URL" -c "select s.ingest_state, s.proxy_key is not null as has_proxy, s.sprite_key is not null as has_sprite, s.peaks_key is not null as has_peaks, j.result from sources s join jobs j on j.payload->>'sourceId' = s.id where j.kind = 'source.probe' and j.state = 'completed' order by j.created_at desc limit 1"` (read-only, run in the Repl's shell through the connector)

### 8. Jared's footage looks and sounds right as a proxy

**Do:** In the library, press Play proxy on Adductor Stretch and watch a minute from the start and a minute from the middle (drag the playhead there).
**Expect:** The picture is clear enough to judge a stretch by, the sound is Jared's voice at a normal level and in step with his lips, and seeking to the middle starts playing within a couple of seconds.
**Lane:** human
**Judgement:** whether the proxy is good enough to log footage from is yours: picture clarity and sound are what Jared will work from.

## Regression

### R1. Step 0 still holds: sign-in, the feedback rail, and the server's gates

**Do:** Run the step-0 journeys over HTTP and in the browser.
**Expect:** All pass: signed-out refusal, single-use links, tiers, the rail stored and read back, cross-origin refusal.
**Lane:** ci
**Check:** `artifacts/web/server/journeys/step0.test.ts`

## Not bugs

- No transcript and no deck pages yet: both are the next parts of step 1.
- Sources ingested before this PR (the step-0 phone clip) are `ready` with no proxy: they show no Play button until Process again has run them through ingest.
