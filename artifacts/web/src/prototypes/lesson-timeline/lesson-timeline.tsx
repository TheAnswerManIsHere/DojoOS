// PROTOTYPE — the lesson timeline, second version (David's feedback, 2026-10-29): turn a shoot's logged bricks into a
// lesson — order by keyboard or by dragging, cut or dissolve, open a brick to fix its edges — preview it, and render
// it. Every lesson edit is a command sent to the server, which applies it with applyLessonCommand and answers with the
// lesson and the command that reverses it; Esc sends that inverse back. The preview plays the same ResolvedEDL the
// render reads: two players, alternating, so a cut lands on a player already cued and a dissolve fades one player over
// the other in picture and sound together. Two strips follow the playhead: the whole lesson, and the brick now playing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyLessonCommand, applySourceCommand, getLesson, getPlayback, getRenderDownload, getRenderFile, renderLesson, type Lesson,
  type LessonEntry, type LessonRender } from '@workspace/api-client-react';
import { activeAt, dissolveOut, regionTransform, type ResolvedEDL } from '@workspace/shared/edl';
import type { LessonCommand } from '@workspace/shared/lesson';
import { stepToWord, type Command } from '@workspace/shared/commands';
import { modifierOf, navigationTarget, nextSpeed, playerKeys, timecode, type Word } from '@workspace/shared/navigation';
import { BrickEditor } from '../../player/brick-editor';
import { Strip, usePeaks, type StripBand, type StripSegment } from '../../player/strip';
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
/** A tile's width: so many pixels a second, never narrower than the minimum (David, 2026-10-29). */
const tilePxPerSecond = 9, tileMinPx = 140;
const busyStates = new Set(['queued', 'claimed']);
type Words = Array<Word & { text: string }>;

export function LessonTimeline({ shootId }: { shootId: string }) {
  const [lesson, setLesson] = useState<Lesson>();
  const [renders, setRenders] = useState<LessonRender[]>([]);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [undo, setUndo] = useState<LessonCommand[]>([]);
  const [message, setMessage] = useState('');
  const [playing, setPlaying] = useState(false);
  const [outMs, setOutMs] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [watching, setWatching] = useState<{ number: number; url: string } | null>(null);
  const [speed, setSpeed] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  // The lesson is the cut, so it plays with each brick's action by default; S shows the footage as shot instead.
  const [showAction, setShowAction] = useState(true);
  const showActionRef = useRef(true);
  showActionRef.current = showAction;
  const [brickUndo, setBrickUndo] = useState<Array<{ sourceId: string; command: Command }>>([]);
  const [brickRedo, setBrickRedo] = useState<Array<{ sourceId: string; command: Command }>>([]);
  const [drag, setDrag] = useState<{ id: string; x: number; startX: number; to: number } | null>(null);
  const speedRef = useRef(1);
  const players = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const clockRef = useRef(0);
  const shownRef = useRef(0);
  const busy = useRef(Promise.resolve());
  const tileRefs = useRef(new Map<string, HTMLLIElement>());
  const previewRef = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);

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
  const fpsOf = useCallback((sourceId: string) => sourceOf(sourceId)?.fps || 30, [sourceOf]);
  const wordsOf = useCallback((sourceId: string) => (sourceOf(sourceId)?.words ?? null) as Words | null, [sourceOf]);
  const peaks = usePeaks(lesson?.sources.map((s) => ({ id: s.id, hasPeaks: s.hasPeaks })) ?? []);
  const wordsBySource = useMemo(() => Object.fromEntries((lesson?.sources ?? []).map((s) => [s.id, (s.words ?? null) as Word[] | null])), [lesson]);
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
    return next && next.outStartMs < p.outEndMs ? [{ fromMs: next.outStartMs, toMs: p.outEndMs, className: 'dissolve', label: 'dissolve', testid: `band-dissolve-${i}` }] : [];
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
      if (v.style.transform !== frame.transform) { v.style.transform = frame.transform; v.style.transformOrigin = frame.transformOrigin; }
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
        if (command.type === 'add' && inverse.type === 'remove') { setSelected(inverse.id); setPick(null); }
        if (command.type === 'remove') {
          const at = Math.min(index, result.lesson.entries.length - 1);
          setSelected(result.lesson.entries[at]?.id ?? null);
        }
        if (!opts.isUndo) setUndo((stack) => [...stack, inverse]);
      } catch (cause) {
        setMessage(reason(cause));
      }
    });
  }, [lesson, index]);

  /** A brick edit from the brick editor: a command on the brick itself, on its own file, so the lesson and the log
   * show the same edges. Its inverse goes on the editor's own history; the lesson is read again after it. */
  const sendBrick = useCallback((sourceId: string, command: Command, kind: 'edit' | 'undo' | 'redo' = 'edit') => {
    busy.current = busy.current.then(async () => {
      try {
        const result = await applySourceCommand(sourceId, { command: command as unknown as Record<string, unknown> });
        const inverse = { sourceId, command: result.inverse as unknown as Command };
        if (kind === 'undo') setBrickRedo((s) => [...s, inverse]);
        else { setBrickUndo((s) => [...s, inverse]); if (kind === 'edit') setBrickRedo([]); }
        setMessage('');
        await reload();
      } catch (cause) { setMessage(reason(cause)); }
    });
  }, [reload]);

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
      case 'moveEarlier': case 'moveLater': {
        if (!entry) { setMessage('No brick selected.'); return; }
        const forward = action === 'moveLater';
        const to = index + (forward ? 1 : -1);
        if (to < 0 || to >= entries.length) { setMessage(forward ? 'Already the last brick.' : 'Already the first brick.'); return; }
        send({ type: 'move', id: entry.id, to });
        return;
      }
      case 'remove': if (entry) send({ type: 'remove', id: entry.id }); else setMessage('No brick selected.'); return;
      case 'add': {
        const brick = lesson.available.find((b) => b.id === pick) ?? lesson.available[0];
        if (!brick) { setMessage('Every brick is already in the lesson.'); return; }
        send({ type: 'add', entry: { brickId: brick.id }, position: index < 0 ? entries.length : index + 1 });
        return;
      }
      case 'edit': {
        if (!entry) { setMessage('Select a brick (Tab, or tap it) to open it.'); return; }
        if (playing) { setPlaying(false); place(clockRef.current, false); }
        setBrickUndo([]); setBrickRedo([]); setMessage('');
        setEditing(entry.id);
        return;
      }
      case 'toggleTransition': {
        if (!entry) { setMessage('No brick selected.'); return; }
        if (index === entries.length - 1) { setMessage('The last brick has nothing after it to dissolve into.'); return; }
        send({ type: 'setTransition', id: entry.id, transition: entry.transition === 'dissolve' ? 'cut' : 'dissolve' });
        return;
      }
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
  }, [lesson, edl, entries, index, pick, playing, undo, send, seek, place, render, lessonWords, speed, togglePlay, show]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editing) return; // the brick editor has the keys while it is open
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) && (el as HTMLInputElement).type !== 'range')) return;
      const action = (keymap.bindings as Record<string, string>)[event.code] ?? playerKeys[event.code];
      if (!action || event.metaKey || event.ctrlKey || (event.altKey && action !== 'back' && action !== 'forward')) return;
      event.preventDefault();
      runAction(action, event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction, editing]);

  /** Dragging a tile: once the pointer has moved a few pixels it is a drag, the tile follows it, and the gap it would
   * drop into is marked; letting go moves the brick there. A tap without a drag selects it. */
  const dropIndex = (x: number, id: string) => {
    let to = 0;
    entries.forEach((e) => {
      if (e.id === id) return;
      const r = tileRefs.current.get(e.id)?.getBoundingClientRect();
      if (r && x > r.left + r.width / 2) to++;
    });
    return to;
  };

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!lesson || !edl) return <p role="status">Loading the lesson…</p>;

  const playingNow = activeAt(edl, outMs);
  const current = playingNow.length ? edl.picture[playingNow[playingNow.length - 1].index] : edl.picture[Math.max(0, index)];
  const currentIndex = current ? edl.picture.indexOf(current) : -1;
  const currentEntry = currentIndex >= 0 ? entries[currentIndex] : undefined;
  const near = lessonWords?.filter((w) => w.end_ms >= outMs - 6000 && w.start_ms <= outMs + 6000) ?? [];
  const editingEntry = entries.find((e) => e.id === editing);
  const editingSource = editingEntry ? sourceOf(editingEntry.sourceId) : undefined;
  const spriteOf = (e: LessonEntry) => {
    const s = sourceOf(e.sourceId);
    const layout = s?.spriteLayout;
    if (!s?.spriteUrl || !layout) return undefined;
    const tile = Math.min(layout.count - 1, Math.floor((e.brickInMs + e.trimInMs) / 1000 / layout.intervalSeconds));
    return { width: layout.tileWidth, height: layout.tileHeight, backgroundImage: `url(${s.spriteUrl})`,
      backgroundPosition: `-${(tile % layout.columns) * layout.tileWidth}px -${Math.floor(tile / layout.columns) * layout.tileHeight}px` };
  };
  const brickBands: StripBand[] = edl.picture.map((p, i) => ({ fromMs: p.outStartMs, toMs: p.outEndMs, className: `segment${i === currentIndex ? ' current' : ''}`,
    label: entries[i] ? brickName(entries[i]) : undefined }));

  return <section className="lesson-timeline" aria-label="Lesson timeline">
    <div className="page-head">
      <span className="prototype-tag" title={`Build ${import.meta.env.VITE_BUILD_SHA ?? 'development'}`}>Prototype</span>
      <p className="eyebrow">Lesson</p>
      <h1>{lesson.shootName}</h1>
    </div>

    <div className="media-card">
      <div className="lesson-preview" data-testid="preview"
        ref={(el) => { previewRef.current = el; el?.setAttribute('data-out-ms', String(Math.round(clockRef.current))); }}>
        {players.map((ref, k) => <video key={k} ref={ref} className="lesson-player" preload="auto" playsInline data-testid={`video-preview-${k}`}
          onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.dataset.pending) { v.currentTime = Number(v.dataset.pending) / 1000; delete v.dataset.pending; } }}
          onError={(e) => { const id = e.currentTarget.dataset.sourceId; if (id) { e.currentTarget.dataset.url = ''; void loadUrl(id).catch(() => setMessage('A proxy could not be played.')); } }} />)}
        {!edl.picture.length && <p className="lesson-empty">No bricks in the lesson. Add one from “Not in the lesson” with A.</p>}
      </div>
      <div className="media-bar">
        <span data-testid="text-preview-clock">{clock(outMs)} / {clock(lesson.lengthMs)}{currentEntry ? ` · ${brickName(currentEntry)}` : ''}{playing && <strong> · playing</strong>}{speed !== 1 && <strong> · {speed}×</strong>}
          <strong className="action-badge" data-testid="text-lesson-actions"> · {showAction ? 'with actions' : 'as shot'}{showAction && currentEntry?.action === 'punch_in' ? ` (punch in, ${currentEntry.preset})` : ''}</strong></span>
        <button type="button" onClick={togglePlay} className="button-primary" data-testid="button-play-preview">{playing ? 'Pause' : 'Play'}</button>
      </div>
    </div>
    <input type="range" className="lesson-seek sr-only" aria-label="Preview position" min={0} max={lesson.lengthMs} step={1} value={Math.round(outMs)}
      onChange={(e) => seek(Number(e.target.value))} data-testid="input-preview-seek" />

    {/* The whole lesson, then the brick now playing — waveform and word ticks, one playhead between them. */}
    <p className="strip-caption">The lesson</p>
    <Strip fromMs={0} toMs={Math.max(1, lesson.lengthMs)} segments={segments} peaks={peaks} words={wordsBySource} playhead={() => clockRef.current}
      onSeek={seek} bands={[...brickBands, ...dissolves]} testid="lesson-strip" />
    {current && <>
      <p className="strip-caption" data-testid="text-current-brick">{currentEntry ? brickName(currentEntry) : 'Brick'} · {clock(current.outEndMs - current.outStartMs)}</p>
      <Strip fromMs={current.outStartMs} toMs={current.outEndMs} segments={segments} peaks={peaks} words={wordsBySource} playhead={() => clockRef.current}
        onSeek={seek} bands={dissolves} testid="brick-strip" />
    </>}
    <p className="logging-words" data-testid="lesson-words">
      {lessonWords ? near.map((w, i) => <span key={`${w.start_ms}-${i}`} className={outMs >= w.start_ms && outMs < w.end_ms ? 'current' : ''}>{w.text} </span>)
        : 'No transcript for these files.'}
    </p>

    {message && <p role="status" className={`status-line${/doesn't fit|could not|not /i.test(message) ? ' error' : ''}`} data-testid="text-lesson-message">{message}</p>}

    <ol className="lesson-strip" aria-label="Lesson bricks" data-testid="strip">
      {entries.map((e, i) => {
        const width = Math.max(tileMinPx, (lengthOf(e) / 1000) * tilePxPerSecond);
        const isDragging = !!drag && Math.abs(drag.x - drag.startX) > 6;
        const others = drag ? entries.filter((x) => x.id !== drag.id) : [];
        const dropMark = isDragging && drag!.id !== e.id ? (others[drag!.to]?.id === e.id ? ' drop-before' : drag!.to === others.length && others.at(-1)?.id === e.id ? ' drop-after' : '') : '';
        return <li key={e.id} ref={(el) => { if (el) tileRefs.current.set(e.id, el); else tileRefs.current.delete(e.id); }}
          className={`lesson-tile${e.id === selected ? ' selected' : ''}${isDragging && drag!.id === e.id ? ' dragging' : ''}${dropMark}`}
          style={{ width, ...(isDragging && drag!.id === e.id ? { transform: `translateX(${drag!.x - drag!.startX}px)` } : {}) }} data-testid={`tile-${e.id}`}
          onPointerDown={(ev) => {
            // A finger drags from the thumbnail, so a swipe elsewhere still scrolls the row; a mouse drags from anywhere.
            if (ev.pointerType === 'touch' && !(ev.target as HTMLElement).closest('.lesson-thumb')) return;
            ev.currentTarget.setPointerCapture(ev.pointerId); setDrag({ id: e.id, x: ev.clientX, startX: ev.clientX, to: i });
          }}
          onPointerMove={(ev) => { if (drag?.id === e.id) setDrag({ ...drag, x: ev.clientX, to: dropIndex(ev.clientX, e.id) }); }}
          onPointerUp={() => {
            if (drag?.id !== e.id) return;
            const moved = Math.abs(drag.x - drag.startX) > 6;
            setDrag(null);
            if (moved) { dragged.current = true; if (drag.to !== i) send({ type: 'move', id: e.id, to: drag.to }); }
          }}
          onClick={() => { if (dragged.current) { dragged.current = false; return; } setSelected(e.id); if (!playing) seek(edl.picture[i]?.outStartMs ?? 0); }}
          onPointerCancel={() => setDrag(null)} title={e.tags.join(', ')}>
          <div className="lesson-thumb" style={spriteOf(e)} title="Drag to move" />
          <div className="lesson-tile-title"><span data-testid={`text-tile-name-${e.id}`}>{brickName(e)}</span><span data-testid={`text-tile-length-${e.id}`}>{clock(lengthOf(e))}</span></div>
          <div className="lesson-tile-tags">{e.tags.length ? e.tags.join(', ') : <span className="subtle">No labels</span>}</div>
          {e.action === 'punch_in' && <div className="lesson-tile-action" data-testid={`text-tile-action-${e.id}`}>punch in · {e.preset}</div>}
          {i < entries.length - 1 && <div className="lesson-tile-next"><span className={`pill lesson-transition${e.transition === 'dissolve' ? ' dissolve' : ''}`} data-testid={`text-transition-${e.id}`}>
            {e.transition === 'dissolve' ? `dissolve ${dissolveOut(edl.picture[i] ?? {}) / 1000 || 1} s →` : 'cut →'}</span></div>}
        </li>;
      })}
    </ol>
    <p className="lesson-facts"><span>Lesson length <strong data-testid="text-lesson-length">{clock(lesson.lengthMs)}</strong></span><span>{entries.length} brick{entries.length === 1 ? '' : 's'}</span></p>
    <div className="keys" aria-label="Keys">
      <span><kbd>Space</kbd>play / pause</span><span><kbd>←</kbd><kbd>→</kbd>word (Shift: 5 s · Option: frame)</span><span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>slower · 1× · faster</span>
      <span><kbd>Tab</kbd>select</span><span>drag, or <kbd>-</kbd><kbd>=</kbd>, to move</span><span><kbd>P</kbd>open the brick</span><span><kbd>X</kbd>remove</span><span><kbd>A</kbd>add the picked brick</span>
      <span><kbd>D</kbd>dissolve out of the selected brick, into the next</span><span><kbd>S</kbd>actions on · off</span><span><kbd>Esc</kbd>undo</span><span><kbd>R</kbd>render</span>
    </div>

    <div className="two-col">
      <section className="card">
        <h2>Not in the lesson</h2>
        {lesson.available.length === 0 ? <p className="subtle">Every logged brick is in the lesson.</p> :
          <ul className="lesson-available">{lesson.available.map((b) => <li key={b.id} className={b.id === pick ? 'selected' : ''} onClick={() => setPick(b.id)}
            data-testid={`available-${b.id}`}>{brickName(b)} · {clock(b.inMs)}–{clock(b.outMs)}{b.tags.length > 0 && ` · ${b.tags.join(', ')}`}</li>)}</ul>}
      </section>

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

    {editingEntry && editingSource && <BrickEditor brick={{ inMs: editingEntry.brickInMs, outMs: editingEntry.brickOutMs, number: editingEntry.brickNumber,
      action: editingEntry.action, preset: editingEntry.preset }} showAction={showAction} onShowAction={setShowAction}
      sourceId={editingEntry.sourceId} words={wordsOf(editingEntry.sourceId)} fps={editingSource.fps} durationMs={editingSource.durationMs ?? editingEntry.brickOutMs + 10_000}
      peaks={peaks} message={message} setMessage={setMessage}
      onMoveTo={(edge, toMs) => {
        const from = edge === 'in' ? editingEntry.brickInMs : editingEntry.brickOutMs;
        const deltaMs = Math.round(toMs - from);
        if (deltaMs) sendBrick(editingEntry.sourceId, { type: 'nudge', id: editingEntry.brickId, edge, deltaMs }); else setMessage(`The ${edge} point is already there.`);
      }}
      onStep={(edge, direction, byFrame) => {
        const from = edge === 'in' ? editingEntry.brickInMs : editingEntry.brickOutMs;
        const word = byFrame ? null : stepToWord(wordsOf(editingEntry.sourceId), from, edge, direction);
        const deltaMs = Math.round((word ?? from + direction * (1000 / fpsOf(editingEntry.sourceId))) - from);
        if (deltaMs) sendBrick(editingEntry.sourceId, { type: 'nudge', id: editingEntry.brickId, edge, deltaMs });
      }}
      onUndo={(redoing) => {
        const stack = redoing ? brickRedo : brickUndo;
        const last = stack.at(-1);
        if (!last) { setMessage(redoing ? 'Nothing to redo.' : 'Nothing to undo.'); return; }
        (redoing ? setBrickRedo : setBrickUndo)((s) => s.slice(0, -1));
        sendBrick(last.sourceId, last.command, redoing ? 'redo' : 'undo');
      }}
      onClose={() => { setEditing(null); const i = entries.findIndex((e) => e.id === editingEntry.id); if (i >= 0) seek(edl.picture[i]?.outStartMs ?? 0); }} />}
  </section>;
}
