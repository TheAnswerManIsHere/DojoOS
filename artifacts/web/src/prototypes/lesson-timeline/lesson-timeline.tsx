// PROTOTYPE — the Edited view of the one editor, third version of the lesson timeline (David and Jared, 2026-11-06:
// "Because we're getting rid of the separate lesson generation screen, we need a way to see what the edit of bricks
// looks like"). The lesson is the shoot's bricks with the gaps between them gone, derived by the server every time it is
// read (editEntries); here it plays, each join is a cut or a dissolve of a length you set — by typing it, or by dragging
// the dissolve's band on the strip — and it renders. Every join edit is a command sent to the server, which applies it
// with applyLessonCommand and answers with the lesson and the command that reverses it; Esc sends that inverse back. The preview plays the same ResolvedEDL the
// render reads: two players, alternating, so a cut lands on a player already cued and a dissolve fades one player over
// the other in picture and sound together. Two strips follow the playhead: the whole lesson, and the brick now playing.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { applyLessonCommand, getLesson, getPlayback, getRenderDownload, getRenderFile, renderLesson, type Lesson,
  type LessonEntry, type LessonRender } from '@workspace/api-client-react';
import { activeAt, dissolveOut, regionTransform, type ResolvedEDL } from '@workspace/shared/edl';
import { dissolveMs as defaultDissolveMs, maxDissolveMs, minDissolveMs, type LessonCommand } from '@workspace/shared/lesson';
import { modifierOf, navigationTarget, nextSpeed, playerKeys, timecode, type Word } from '@workspace/shared/navigation';
import { Strip, usePeaks, useStripZoom, type StripBand, type StripSegment } from '../../player/strip';
import { TranscriptBox } from '../../player/transcript-box';
import { useLocation } from 'wouter';
import keymap from './keymap.json';

/** The lesson's own frame rate: the render's (renderDefaults on the server). */
const lessonFps = 30;
const clock = (ms: number) => timecode(ms, lessonFps);
const reason = (cause: unknown) => (cause as { data?: { error?: string } })?.data?.error ?? (cause instanceof Error ? cause.message : 'That did not apply.');
const lengthOf = (e: LessonEntry) => (e.brickOutMs + e.trimOutMs) - (e.brickInMs + e.trimInMs);
const brickName = (e: { brickNumber?: number | null; number?: number | null }) => `Brick ${e.brickNumber ?? e.number ?? '?'}`;
/** How far a player may drift from the output clock before it is re-cued: tight while paused, loose while playing,
 * where re-seeking a player that is only starting is what stalled the dissolve on the iPad (David, 2026-10-29). */
const driftMs = 150;
const playingDriftMs = 450;
/** A player just started is left alone this long before it is judged to have drifted. */
const startGraceMs = 900;
/** The incoming player of a cut or dissolve is started this far ahead, muted and hidden, so it is already running. */
const prerollMs = 350;
const busyStates = new Set(['queued', 'claimed']);
type Words = Array<Word & { text: string }>;

/** Where the Edited view opens, and where it hands back to the Original view: a moment of one file. */
export type FilePlace = { sourceId: string; ms: number };

export function LessonTimeline({ shootId, startAt, onOriginal, placeHandle }: {
  shootId: string;
  /** Open at the output moment that plays this moment of footage, or the next brick after it. */
  startAt?: FilePlace;
  /** Back to the Original view, at the footage under the playhead (V, or the switch). */
  onOriginal?: (at: FilePlace) => void;
  /** Filled with a reader of the footage under the playhead, for a switch outside this view. */
  placeHandle?: { current: (() => FilePlace | null) | null };
}) {
  const [lesson, setLesson] = useState<Lesson>();
  const [renders, setRenders] = useState<LessonRender[]>([]);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<LessonCommand[]>([]);
  const [message, setMessage] = useState('');
  const [playing, setPlaying] = useState(false);
  const [outMs, setOutMs] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [watching, setWatching] = useState<{ number: number; url: string } | null>(null);
  const [speed, setSpeed] = useState(1);
  // The lesson is the cut, so it plays with each brick's action by default; S shows the footage as shot instead.
  const [showAction, setShowAction] = useState(true);
  const showActionRef = useRef(true);
  showActionRef.current = showAction;
  /** A dissolve being dragged on the strip: the entry before the join, and the length it would have. */
  const [dissolveDrag, setDissolveDrag] = useState<{ id: string; ms: number } | null>(null);
  const [lengthText, setLengthText] = useState('');
  const speedRef = useRef(1);
  const players = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const clockRef = useRef(0);
  const shownRef = useRef(0);
  const busy = useRef(Promise.resolve());
  const previewRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const loadUrl = useCallback(async (sourceId: string) => {
    const { url } = await getPlayback(sourceId);
    setUrls((u) => ({ ...u, [sourceId]: url }));
  }, []);
  const reload = useCallback(async () => { const l = await getLesson(shootId); setLesson(l); setRenders(l.renders); return l; }, [shootId]);

  useEffect(() => {
    let live = true;
    getLesson(shootId).then((l) => {
      if (!live) return;
      setLesson(l); setRenders(l.renders);
      setSelected(l.entries[0]?.id ?? null);
      for (const s of l.sources) if (s.hasProxy) void loadUrl(s.id).catch(() => live && setMessage('A proxy could not be loaded.'));
    }, (cause) => live && setLoadError(reason(cause)));
    return () => { live = false; };
  }, [shootId, loadUrl]);

  // While a render is queued or running, its state is read again every few seconds (async-ui-status.md).
  useEffect(() => {
    if (!renders.some((r) => busyStates.has(r.state))) return;
    const timer = setTimeout(() => { getLesson(shootId).then((l) => setRenders(l.renders), () => {}); }, 3000);
    return () => clearTimeout(timer);
  }, [renders, shootId]);

  const edl = lesson?.resolved as ResolvedEDL | undefined;
  const entries = useMemo(() => lesson?.entries ?? [], [lesson]);
  const index = entries.findIndex((e) => e.id === selected);
  const sourceOf = useCallback((sourceId: string) => lesson?.sources.find((s) => s.id === sourceId), [lesson]);
  const wordsOf = useCallback((sourceId: string) => (sourceOf(sourceId)?.words ?? null) as Words | null, [sourceOf]);
  const peaks = usePeaks(lesson?.sources.map((s) => ({ id: s.id, hasPeaks: s.hasPeaks })) ?? []);
  const zoom = useStripZoom(0, Math.max(1, lesson?.lengthMs ?? 1));
  /** The lesson's own transcript, in output time: each segment's words where the segment plays them, so ← / → step
   * through the lesson word by word, as on every player (@workspace/shared/navigation), and the words show as it plays. */
  const lessonWords = useMemo(() => {
    if (!edl) return null;
    const out: Words = [];
    for (const seg of edl.picture) for (const w of wordsOf(seg.sourceId) ?? [])
      if (w.start_ms >= seg.inMs && w.start_ms < seg.outMs) out.push({ text: w.text, start_ms: seg.outStartMs + (w.start_ms - seg.inMs), end_ms: seg.outStartMs + (w.end_ms - seg.inMs) });
    return out.sort((a, b) => a.start_ms - b.start_ms);
  }, [edl, wordsOf]);
  /** The strip's pieces: each segment of the lesson, showing its own source. */
  const segments: StripSegment[] = useMemo(() => edl?.picture.map((p) => ({ startMs: p.outStartMs, endMs: p.outEndMs, sourceId: p.sourceId, sourceInMs: p.inMs })) ?? [], [edl]);
  /** Where two segments overlap, a dissolve: shaded and labelled on both strips. */
  const dissolves: StripBand[] = useMemo(() => (edl?.picture ?? []).flatMap((p, i, all) => {
    const next = all[i + 1];
    return next && next.outStartMs < p.outEndMs ? [{ fromMs: next.outStartMs, toMs: p.outEndMs, className: 'dissolve', label: `${((p.outEndMs - next.outStartMs) / 1000).toFixed(1)} s`, testid: `band-dissolve-${i}` }] : [];
  }), [edl]);

  /** Puts both players where the output clock says: each active segment on its player at its source time, its share
   * of picture and sound set; the idle player cued at the next segment it will play — and, just before that segment
   * starts, already running, muted and hidden, so the join needs no seek and no start-up. */
  const place = useCallback((t: number, play: boolean) => {
    if (!edl) return;
    const active = activeAt(edl, t);
    const now = performance.now();
    players.forEach((ref, k) => {
      const v = ref.current;
      if (!v) return;
      const here = active.find((a) => a.index % 2 === k);
      const seg = here ? edl.picture[here.index] : edl.picture.find((p, i) => i % 2 === k && p.outStartMs > t);
      const url = seg && urls[seg.sourceId];
      if (!seg || !url) { v.pause(); v.style.opacity = '0'; v.volume = 0; return; }
      // Never earlier than the footage before the in point allows: a brick from the very start of its file starts cold,
      // rather than running ahead of the clock (Codex, PR #60).
      const preroll = !here && play && seg.outStartMs - t <= Math.min(prerollMs, seg.inMs);
      const wantMs = here ? here.sourceMs : preroll ? seg.inMs - (seg.outStartMs - t) : seg.inMs;
      const since = Number(v.dataset.since || 0);
      const running = play && !v.paused;
      const tolerance = running ? playingDriftMs : driftMs;
      if (v.dataset.url !== url) {
        v.dataset.url = url; v.dataset.pending = String(Math.max(0, wantMs)); v.src = url;
      } else if (v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime * 1000 - wantMs) > tolerance && !(running && now - since < startGraceMs)) {
        v.currentTime = Math.max(0, wantMs) / 1000;
      } else if (v.readyState < 1) v.dataset.pending = String(Math.max(0, wantMs));
      v.dataset.sourceId = seg.sourceId;
      v.dataset.segment = String(edl.picture.indexOf(seg));
      // The segment's framing — a punch-in — as the render will crop it, unless S has turned actions off.
      const frame = regionTransform(showActionRef.current ? seg.framing?.[0]?.region : undefined);
      // Scale and anchor are set apart: two punch-ins at different presets share a scale, not an anchor (Codex, PR #67).
      if (v.style.transform !== frame.transform) v.style.transform = frame.transform;
      if (v.dataset.origin !== frame.transformOrigin) { v.dataset.origin = frame.transformOrigin; v.style.transformOrigin = frame.transformOrigin; }
      if (v.playbackRate !== speedRef.current) v.playbackRate = speedRef.current;
      // The later of two overlapping segments sits on top and fades in; the one beneath stays opaque while it plays.
      const later = here && active.length === 2 && here.index === Math.max(...active.map((a) => a.index));
      v.style.zIndex = later ? '2' : '1';
      v.style.opacity = here ? String(later ? here.weight : 1) : '0';
      v.volume = here ? Math.min(1, Math.max(0, here.weight)) : 0;
      if ((here || preroll) && play && v.paused) {
        v.dataset.since = String(now);
        void v.play().catch((cause: Error) => {
          // Never silent (David, 2026-10-29): a refused play is said, and the player is given a fresh link.
          if (cause?.name === 'AbortError') return;
          setMessage(cause?.name === 'NotAllowedError' ? 'Safari would not start playback without a tap. Tap Play once, then Space works.' : 'A player would not start; fetching a fresh link.');
          v.dataset.url = ''; void loadUrl(seg.sourceId).catch(() => setMessage('A proxy could not be loaded.'));
        });
      }
      if ((!here && !preroll) || !play) v.pause();
    });
  }, [edl, urls]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The clock as the page shows it: the strips read clockRef every frame themselves, so the page is only redrawn when
   * the shown time has moved a tenth of a second — redrawing it every frame is what an iPad could not keep up with. */
  const show = useCallback((t: number, force = false) => {
    // The exact clock goes on the preview every frame, for anything that reads it there; the page redraws less often.
    previewRef.current?.setAttribute('data-out-ms', String(Math.round(t)));
    if (force || Math.abs(t - shownRef.current) >= 100) { shownRef.current = t; setOutMs(t); }
  }, []);
  const seek = useCallback((t: number) => {
    const total = lesson?.lengthMs ?? 0;
    clockRef.current = Math.max(0, Math.min(total, t));
    show(clockRef.current, true);
    place(clockRef.current, playing);
  }, [lesson, place, playing, show]);

  /** The footage under the playhead: the segment playing, or else the next one. */
  const placeNow = useCallback((): FilePlace | null => {
    if (!edl) return null;
    const t = clockRef.current;
    const here = activeAt(edl, t).at(-1);
    const seg = here ? edl.picture[here.index] : edl.picture.find((p) => p.outStartMs >= t) ?? edl.picture.at(-1);
    return seg ? { sourceId: seg.sourceId, ms: here ? here.sourceMs : seg.inMs } : null;
  }, [edl]);
  if (placeHandle) placeHandle.current = placeNow;
  /** Back to the Original view, at the footage under the playhead. */
  const toOriginal = useCallback(() => {
    const at = placeNow();
    if (!at || !onOriginal) return;
    if (playing) { setPlaying(false); place(clockRef.current, false); }
    onOriginal(at);
  }, [placeNow, onOriginal, playing, place]);

  // Opened from the Original view: the output moment that plays the footage under its playhead, or else the next
  // brick after it (David, 2026-11-06: flipping keeps your place).
  useEffect(() => {
    if (!edl || started.current) return;
    started.current = true;
    if (!startAt) return;
    const order = lesson?.sources.map((x) => x.id) ?? [];
    const rank = order.indexOf(startAt.sourceId);
    const seg = edl.picture.find((p) => p.sourceId === startAt.sourceId && startAt.ms >= p.inMs && startAt.ms < p.outMs);
    const next = seg ?? edl.picture.find((p) => (p.sourceId === startAt.sourceId && p.inMs > startAt.ms) || order.indexOf(p.sourceId) > rank);
    const t = seg ? seg.outStartMs + (startAt.ms - seg.inMs) : next ? next.outStartMs : 0;
    seek(t);
    zoom.reveal(t);
    const i = edl.picture.indexOf(seg ?? next ?? edl.picture[0]);
    if (i >= 0 && entries[i]) setSelected(entries[i].id);
  }, [edl]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sets the selected join's dissolve to a length typed in seconds. */
  const setLength = (id: string, seconds: string) => {
    const ms = Math.round(Number(seconds.replace(',', '.')) * 1000);
    if (!Number.isFinite(ms) || ms <= 0) { setMessage('Type a length in seconds, such as 1.5.'); return; }
    send({ type: 'setJoin', id, transition: 'dissolve', dissolveMs: Math.max(minDissolveMs, Math.min(maxDissolveMs, ms)) });
  };

  // The output clock follows the earliest playing segment's own player, so a stalled player stalls the preview rather
  // than letting the two drift apart.
  useEffect(() => {
    if (!playing || !edl) return;
    let frame = 0;
    const tick = () => {
      const active = activeAt(edl, clockRef.current);
      const first = active[0];
      if (!first) { setPlaying(false); place(clockRef.current, false); show(clockRef.current, true); setMessage('Preview finished.'); return; }
      const seg = edl.picture[first.index];
      const v = players[first.index % 2].current;
      if (v && v.readyState >= 2 && !v.seeking && v.dataset.segment === String(first.index)) {
        clockRef.current = Math.max(clockRef.current, seg.outStartMs + (v.currentTime * 1000 - seg.inMs));
        if (clockRef.current >= seg.outEndMs - 1 && first.index === edl.picture.length - 1) clockRef.current = seg.outEndMs;
      }
      show(clockRef.current);
      place(clockRef.current, true);
      frame = requestAnimationFrame(tick);
    };
    place(clockRef.current, true);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, edl, place]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each dissolve that plays through counts the frames the screen actually showed, and a slow one is said with its
  // rate (David, 2026-10-29: on the iPad it "falls to just a few frames per second") — so whether the live preview
  // is enough, or a pre-rendered transition is needed, is read off the device rather than guessed.
  useEffect(() => {
    if (!playing || !edl) return;
    const windows = edl.picture.flatMap((p, i, all) => (all[i + 1] && all[i + 1].outStartMs < p.outEndMs ? [{ from: all[i + 1].outStartMs, to: p.outEndMs, frames: 0, done: false }] : []));
    if (!windows.length) return;
    let live = true;
    const vids = players.map((r) => r.current).filter((v): v is HTMLVideoElement => !!v && 'requestVideoFrameCallback' in v);
    const count = (v: HTMLVideoElement) => v.requestVideoFrameCallback(() => {
      if (!live) return;
      const t = clockRef.current;
      for (const w of windows) if (t >= w.from && t < w.to && Number(v.style.opacity) > 0.05) w.frames++;
      count(v);
    });
    vids.forEach(count);
    const timer = setInterval(() => {
      for (const w of windows) if (!w.done && clockRef.current >= w.to && w.frames > 0) {
        w.done = true;
        // Two pictures show through a dissolve, each at the footage's rate; the rate is frames per picture per second.
        const fps = Math.round(w.frames / 2 / ((w.to - w.from) / 1000));
        if (fps < 20) setMessage(`That dissolve played at about ${fps} frames a second on this device.`);
      }
    }, 250);
    return () => { live = false; clearInterval(timer); };
  }, [playing, edl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turning actions on or off reframes the players at once.
  useEffect(() => { place(clockRef.current, playing); }, [showAction]); // eslint-disable-line react-hooks/exhaustive-deps

  // A change to the lesson re-cues the players where the clock stands.
  useEffect(() => { if (!playing) place(clockRef.current, false); }, [edl, urls, place, playing]);

  // Shown again after the iPad froze or unloaded the page, a player that can no longer play gets a fresh link (the
  // links last five minutes), and the players are re-cued where the clock stands — as every player does (player/proxy-video).
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      for (const ref of players) {
        const v = ref.current, id = v?.dataset.sourceId;
        if (v && id && (v.error || v.readyState < 1)) { v.dataset.url = ''; void loadUrl(id).catch(() => setMessage('A proxy could not be loaded.')); }
      }
      for (const s of lesson?.sources ?? []) if (s.hasProxy) void loadUrl(s.id).catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('pageshow', check); };
  }, [lesson, loadUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One command at a time, in order: each waits for the last, so undo always reverses what is on screen. */
  const send = useCallback((command: LessonCommand | { type: 'add'; entry: { brickId: string }; position: number }, opts: { isUndo?: boolean } = {}) => {
    if (!lesson) return;
    busy.current = busy.current.then(async () => {
      try {
        const result = await applyLessonCommand(lesson.cutId, { command: command as unknown as Record<string, unknown> });
        setLesson(result.lesson); setRenders(result.lesson.renders);
        setMessage('');
        const inverse = result.inverse as unknown as LessonCommand;
        if (!opts.isUndo) setUndo((stack) => [...stack, inverse]);
      } catch (cause) {
        setMessage(reason(cause));
      }
    });
  }, [lesson, index]);

  const render = useCallback(async () => {
    if (!lesson) return;
    try {
      const queued = await renderLesson(lesson.cutId);
      setMessage(`Render ${queued.number} queued.`);
      setRenders((await getLesson(shootId)).renders);
    } catch (cause) { setMessage(reason(cause)); }
  }, [lesson, shootId]);

  const togglePlay = useCallback(() => {
    if (!lesson) return;
    if (playing) { setPlaying(false); place(clockRef.current, false); show(clockRef.current, true); return; }
    // Space plays from the playhead, wherever it is (David, 2026-10-29); only at the very end does it start again.
    if (clockRef.current >= (lesson.lengthMs ?? 0) - 1) clockRef.current = 0;
    setMessage('');
    setPlaying(true);
  }, [lesson, playing, place, show]);

  const runAction = useCallback((action: string, event: { shiftKey: boolean; altKey: boolean }) => {
    if (!lesson || !edl) return;
    const shift = event.shiftKey;
    const entry = entries[index];
    const frame = 1000 / lessonFps;
    switch (action) {
      case 'back': case 'forward': {
        const to = navigationTarget(lessonWords, clockRef.current, action === 'forward' ? 1 : -1, modifierOf(event), frame, lesson.lengthMs);
        if (playing) { clockRef.current = to; show(to, true); place(to, true); } else seek(to);
        return;
      }
      case 'slower': case 'normal': case 'faster': {
        const to = nextSpeed(speed, action);
        setSpeed(to); speedRef.current = to;
        players.forEach((ref) => { if (ref.current) ref.current.playbackRate = to; });
        setMessage(`Speed ${to}×`);
        return;
      }
      case 'selectNext': {
        // Tab and Shift+Tab pick a brick, as on the logging page; the arrows belong to the player.
        if (!entries.length) return;
        const next = index < 0 ? 0 : (index + (shift ? -1 : 1) + entries.length) % entries.length;
        setSelected(entries[next].id);
        if (!playing) seek(edl.picture[next]?.outStartMs ?? 0);
        return;
      }
      case 'toggleTransition': {
        if (!entry) { setMessage('No brick selected.'); return; }
        if (index === entries.length - 1) { setMessage('The last brick has nothing after it to dissolve into.'); return; }
        send({ type: 'setJoin', id: entry.id, transition: entry.transition === 'dissolve' ? 'cut' : 'dissolve', dissolveMs: entry.dissolveMs ?? defaultDissolveMs });
        return;
      }
      case 'zoomIn': zoom.zoomIn(clockRef.current); return;
      case 'zoomOut': zoom.zoomOut(clockRef.current); return;
      case 'zoomFit': zoom.fit(); return;
      case 'original': toOriginal(); return;
      case 'playPause': togglePlay(); return;
      case 'showAction': setShowAction((on) => !on); return;
      case 'undo': {
        const last = undo.at(-1);
        if (!last) { setMessage('Nothing to undo.'); return; }
        setUndo((stack) => stack.slice(0, -1));
        send(last, { isUndo: true });
        return;
      }
      case 'render': void render(); return;
    }
  }, [lesson, edl, entries, index, playing, undo, send, seek, place, render, lessonWords, speed, togglePlay, show, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) && (el as HTMLInputElement).type !== 'range')) return;
      const action = (keymap.bindings as Record<string, string>)[event.code] ?? playerKeys[event.code];
      if (!action || event.metaKey || event.ctrlKey || (event.altKey && action !== 'back' && action !== 'forward')) return;
      event.preventDefault();
      runAction(action, event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction]);

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!lesson || !edl) return <p role="status">Loading the lesson…</p>;

  const playingNow = activeAt(edl, outMs);
  const current = playingNow.length ? edl.picture[playingNow[playingNow.length - 1].index] : edl.picture[Math.max(0, index)];
  const currentIndex = current ? edl.picture.indexOf(current) : -1;
  const currentEntry = currentIndex >= 0 ? entries[currentIndex] : undefined;
  const selectedEntry = index >= 0 ? entries[index] : undefined;
  const joinable = !!selectedEntry && index < entries.length - 1;
  const brickBands: StripBand[] = edl.picture.map((p, i) => ({ fromMs: p.outStartMs, toMs: p.outEndMs, className: `segment${i === currentIndex ? ' current' : ''}`,
    label: entries[i] ? brickName(entries[i]) : undefined }));

  /** Dragging a dissolve's band: it stays centred on the join, so its length is twice the distance from the centre. */
  const dragDissolve = (i: number, centreMs: number, msAt: (x: number) => number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const entry = entries[i];
    if (!entry) return;
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setSelected(entry.id);
    let latest = dissolveOut(edl.picture[i] ?? {}) || defaultDissolveMs;
    const frame = 1000 / lessonFps;
    const move = (ev: PointerEvent) => {
      latest = Math.max(minDissolveMs, Math.min(maxDissolveMs, Math.round((2 * Math.abs(msAt(ev.clientX) - centreMs)) / frame) * frame));
      setDissolveDrag({ id: entry.id, ms: latest });
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      setDissolveDrag(null);
      if (Math.round(latest) !== (entry.dissolveMs ?? defaultDissolveMs)) send({ type: 'setJoin', id: entry.id, transition: 'dissolve', dissolveMs: Math.round(latest) });
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const joinMs = selectedEntry ? (selectedEntry.transition === 'dissolve' ? dissolveOut(edl.picture[index] ?? {}) || selectedEntry.dissolveMs || defaultDissolveMs : 0) : 0;

  return <section className="lesson-timeline" aria-label="Edited view">
    <div className="media-card">
      <div className="lesson-preview" data-testid="preview"
        ref={(el) => { previewRef.current = el; el?.setAttribute('data-out-ms', String(Math.round(clockRef.current))); }}>
        {players.map((ref, k) => <video key={k} ref={ref} className="lesson-player" preload="auto" playsInline data-testid={`video-preview-${k}`}
          onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.dataset.pending) { v.currentTime = Number(v.dataset.pending) / 1000; delete v.dataset.pending; } }}
          onError={(e) => { const id = e.currentTarget.dataset.sourceId; if (id) { e.currentTarget.dataset.url = ''; void loadUrl(id).catch(() => setMessage('A proxy could not be played.')); } }} />)}
        {!edl.picture.length && <p className="lesson-empty">No bricks yet: mark some in the Original view, and the edit is them with the gaps gone.</p>}
      </div>
      <div className="media-bar">
        <span data-testid="text-preview-clock">{clock(outMs)} / {clock(lesson.lengthMs)}{currentEntry ? ` · ${brickName(currentEntry)}` : ''}{playing && <strong> · playing</strong>}{speed !== 1 && <strong> · {speed}×</strong>}
          <strong className="action-badge" data-testid="text-lesson-actions"> · {showAction ? 'with actions' : 'as shot'}{showAction && currentEntry?.action === 'punch_in' ? ` (punch in, ${currentEntry.preset})` : ''}</strong></span>
        <button type="button" onClick={togglePlay} className="button-primary" data-testid="button-play-preview">{playing ? 'Pause' : 'Play'}</button>
      </div>
    </div>
    <input type="range" className="lesson-seek sr-only" aria-label="Preview position" min={0} max={lesson.lengthMs} step={1} value={Math.round(outMs)}
      onChange={(e) => seek(Number(e.target.value))} data-testid="input-preview-seek" />

    <div className="strip-zoom">
      <button type="button" className="button-quiet" onClick={() => zoom.zoomOut(clockRef.current)} aria-label="Zoom out">−</button>
      <button type="button" className="button-quiet" onClick={() => zoom.zoomIn(clockRef.current)} aria-label="Zoom in">+</button>
      <button type="button" className="button-quiet" onClick={zoom.fit} disabled={!zoom.zoomed}>Fit</button>
      <span>{zoom.zoomed ? `Showing ${clock(zoom.view.fromMs)}–${clock(zoom.view.toMs)}` : 'Showing the whole edit'}</span>
    </div>
    <Strip fromMs={0} toMs={Math.max(1, lesson.lengthMs)} segments={segments} peaks={peaks} playhead={() => clockRef.current} zoom={zoom}
      onSeek={seek} bands={brickBands} testid="lesson-strip" className="edited-strip">
      {(g) => edl.picture.map((p, i, all) => {
        const next = all[i + 1];
        if (!next || i >= entries.length - 1) return null;
        const live = dissolveDrag?.id === entries[i].id ? dissolveDrag.ms : next.outStartMs < p.outEndMs ? p.outEndMs - next.outStartMs : 0;
        const centre = live ? (next.outStartMs + p.outEndMs) / 2 : p.outEndMs;
        if (!live) return <div key={i} className={`join-mark${entries[i].id === selected ? ' selected' : ''}`} data-noscrub="" style={{ left: g.pct(centre) }}
          title="A cut: tap to pick this join" onPointerDown={(e) => { e.stopPropagation(); setSelected(entries[i].id); }} data-testid={`join-${i}`} />;
        return <div key={i} className={`dissolve-band${entries[i].id === selected ? ' selected' : ''}`} data-noscrub="" data-testid={`band-dissolve-${i}`}
          style={{ left: g.pct(centre - live / 2), width: g.width(live) }} onPointerDown={dragDissolve(i, centre, g.msAt)}>
          <span className="strip-band-label">{(live / 1000).toFixed(1)} s · {Math.round(live / (1000 / lessonFps))} f</span>
        </div>;
      })}
    </Strip>
    <TranscriptBox words={lessonWords} playheadMs={outMs} onSeek={seek} testid="lesson-words" empty="No transcript for these files." />

    {message && <p role="status" className={`status-line${/doesn't fit|could not|not /i.test(message) ? ' error' : ''}`} data-testid="text-lesson-message">{message}</p>}

    {joinable && <div className="join-panel card" data-testid="join-panel">
      <strong>After {brickName(selectedEntry!)}</strong>
      <div className="tag-chips">
        <button type="button" className={`chip${selectedEntry!.transition === 'cut' ? ' on' : ''}`} aria-pressed={selectedEntry!.transition === 'cut'} data-testid="button-join-cut"
          onClick={() => { if (selectedEntry!.transition !== 'cut') send({ type: 'setJoin', id: selectedEntry!.id, transition: 'cut', dissolveMs: selectedEntry!.dissolveMs ?? defaultDissolveMs }); }}>Cut</button>
        <button type="button" className={`chip${selectedEntry!.transition === 'dissolve' ? ' on' : ''}`} aria-pressed={selectedEntry!.transition === 'dissolve'} data-testid="button-join-dissolve"
          onClick={() => { if (selectedEntry!.transition !== 'dissolve') send({ type: 'setJoin', id: selectedEntry!.id, transition: 'dissolve', dissolveMs: selectedEntry!.dissolveMs ?? defaultDissolveMs }); }}>Dissolve</button>
      </div>
      {selectedEntry!.transition === 'dissolve' && <form className="join-length" onSubmit={(e) => { e.preventDefault(); if (!lengthText.trim()) return; setLength(selectedEntry!.id, lengthText); setLengthText(''); (document.activeElement as HTMLElement | null)?.blur(); }}>
        <label>Length <input type="text" inputMode="decimal" size={5} value={lengthText} placeholder={(joinMs / 1000).toFixed(2)}
          onChange={(e) => setLengthText(e.target.value)} data-testid="input-dissolve-length" /> s</label>
        <span className="subtle">{Math.round(joinMs / (1000 / lessonFps))} frames · or drag the band's ends</span>
      </form>}
    </div>}
    <p className="lesson-facts"><span>Edited length <strong data-testid="text-lesson-length">{clock(lesson.lengthMs)}</strong></span><span>{entries.length} brick{entries.length === 1 ? '' : 's'}</span></p>
    <div className="keys" aria-label="Keys">
      <span><kbd>Space</kbd>play / pause</span><span><kbd>←</kbd><kbd>→</kbd>word (Shift: 5 s · Option: frame)</span><span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>slower · 1× · faster</span>
      <span><kbd>Tab</kbd>select a brick</span><span><kbd>D</kbd>cut or dissolve after it</span><span><kbd>=</kbd><kbd>-</kbd><kbd>{'\\'}</kbd>zoom</span>
      <span><kbd>S</kbd>actions on · off</span><span><kbd>Esc</kbd>undo</span><span><kbd>R</kbd>render</span><span><kbd>V</kbd>back to Original</span>
    </div>

    <div className="two-col">
      <section className="card">
        <div className="card-head"><h2>Renders</h2>
          <button type="button" className="button-primary" onClick={() => void render()} disabled={!entries.length} data-testid="button-render">Render (R)</button></div>
        {renders.length === 0 ? <p className="subtle">Nothing rendered yet. A render makes a full-quality file from the original footage.</p> :
          <div className="table-scroll"><table className="plain-table"><thead><tr><th>#</th><th>Requested</th><th>Length</th><th>State</th><th /></tr></thead>
            <tbody>{renders.map((r) => <tr key={r.id} data-testid={`row-render-${r.number}`}>
              <td>{r.number}</td><td>{new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>{clock(r.lengthMs)}</td>
              <td><span className={`pill ${r.state === 'ready' ? 'ready' : r.state === 'failed' ? 'failed' : 'busy'}`} data-testid={`text-render-state-${r.number}`}>{r.state === 'claimed' ? 'rendering…' : r.state === 'queued' ? 'queued…' : r.state === 'failed' ? `failed: ${r.error ?? 'unknown error'}` : r.state}</span></td>
              <td className="source-actions">{r.state === 'ready' && <>
                <button type="button" onClick={async () => { try { setWatching({ number: r.number, url: (await getRenderFile(r.id)).url }); } catch (c) { setMessage(reason(c)); } }}
                  data-testid={`button-play-render-${r.number}`}>Play</button>
                <button type="button" onClick={async () => { try { window.location.assign((await getRenderDownload(r.id)).url); } catch (c) { setMessage(reason(c)); } }}
                  data-testid={`button-download-render-${r.number}`}>Download</button></>}</td>
            </tr>)}</tbody></table></div>}
        {watching && <figure style={{ margin: '14px 0 0' }}><video src={watching.url} controls autoPlay playsInline className="lesson-render-player" data-testid="video-render" />
          <figcaption className="subtle">Render {watching.number}</figcaption></figure>}
      </section>
    </div>

  </section>;
}

/** The edit on a page of its own (the library's "Open the edit"): V, or a file's name, goes to that file's Original view. */
export function LessonPage({ shootId }: { shootId: string }) {
  const [, navigate] = useLocation();
  return <>
    <div className="page-head">
      <span className="prototype-tag" title={`Build ${import.meta.env.VITE_BUILD_SHA ?? 'development'}`}>Prototype</span>
      <p className="eyebrow">Edited view</p>
      <h1>The edit</h1>
    </div>
    <LessonTimeline shootId={shootId} onOriginal={(at) => navigate(`/sources/${at.sourceId}/log?t=${Math.round(at.ms)}`)} />
  </>;
}
