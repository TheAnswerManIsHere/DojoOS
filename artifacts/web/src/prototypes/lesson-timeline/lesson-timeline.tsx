// PROTOTYPE — the lesson timeline, first version (PLAN_LESSON_TIMELINE.md): turn a shoot's logged bricks into a lesson
// from the keyboard — order, trim, cut or dissolve — preview it, and render it. Every edit is a command sent to the
// server, which applies it with applyLessonCommand and answers with the lesson and the command that reverses it; Esc
// sends that inverse back. The preview plays the same ResolvedEDL the render reads: two players, alternating, so a cut
// lands on a player already cued and a dissolve fades one player over the other in picture and sound together.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyLessonCommand, getLesson, getPlayback, getRenderDownload, getRenderFile, renderLesson, type Lesson, type LessonEntry,
  type LessonRender } from '@workspace/api-client-react';
import { activeAt, dissolveOut, type ResolvedEDL } from '@workspace/shared/edl';
import type { LessonCommand } from '@workspace/shared/lesson';
import keymap from './keymap.json';

const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const reason = (cause: unknown) => (cause as { data?: { error?: string } })?.data?.error ?? (cause instanceof Error ? cause.message : 'That did not apply.');
const lengthOf = (e: LessonEntry) => (e.brickOutMs + e.trimOutMs) - (e.brickInMs + e.trimInMs);
/** How far a player may drift from the output clock before it is re-cued. */
const driftMs = 150;
const busyStates = new Set(['queued', 'claimed']);

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
  const players = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const clockRef = useRef(0);
  const busy = useRef(Promise.resolve());

  const loadUrl = useCallback(async (sourceId: string) => {
    const { url } = await getPlayback(sourceId);
    setUrls((u) => ({ ...u, [sourceId]: url }));
  }, []);

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
  const fpsOf = useCallback((sourceId: string) => lesson?.sources.find((s) => s.id === sourceId)?.fps || 30, [lesson]);

  /** Puts both players where the output clock says: each active segment on its player at its source time, its share
   * of picture and sound set; the idle player cued at the next segment it will play, so a cut needs no seek. */
  const place = useCallback((t: number, play: boolean) => {
    if (!edl) return;
    const active = activeAt(edl, t);
    players.forEach((ref, k) => {
      const v = ref.current;
      if (!v) return;
      const here = active.find((a) => a.index % 2 === k);
      const seg = here ? edl.picture[here.index] : edl.picture.find((p, i) => i % 2 === k && p.outStartMs > t);
      const url = seg && urls[seg.sourceId];
      if (!seg || !url) { v.pause(); v.style.opacity = '0'; v.volume = 0; return; }
      const wantMs = here ? here.sourceMs : seg.inMs;
      if (v.dataset.url !== url) {
        v.dataset.url = url; v.dataset.pending = String(wantMs); v.src = url;
      } else if (v.readyState >= 1 && Math.abs(v.currentTime * 1000 - wantMs) > driftMs) v.currentTime = wantMs / 1000;
      else if (v.readyState < 1) v.dataset.pending = String(wantMs);
      v.dataset.sourceId = seg.sourceId;
      v.dataset.segment = String(edl.picture.indexOf(seg));
      // The later of two overlapping segments sits on top and fades in; the one beneath stays opaque while it plays.
      const later = here && active.length === 2 && here.index === Math.max(...active.map((a) => a.index));
      v.style.zIndex = later ? '2' : '1';
      v.style.opacity = here ? String(later ? here.weight : 1) : '0';
      v.volume = here ? Math.min(1, Math.max(0, here.weight)) : 0;
      if (here && play && v.paused) void v.play().catch(() => {});
      if (!here || !play) v.pause();
    });
  }, [edl, urls]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((t: number) => {
    const total = lesson?.lengthMs ?? 0;
    clockRef.current = Math.max(0, Math.min(total, t));
    setOutMs(clockRef.current);
    place(clockRef.current, playing);
  }, [lesson, place, playing]);

  // The output clock follows the earliest playing segment's own player, so a stalled player stalls the preview rather
  // than letting the two drift apart.
  useEffect(() => {
    if (!playing || !edl) return;
    let frame = 0;
    const tick = () => {
      const active = activeAt(edl, clockRef.current);
      const first = active[0];
      if (!first) { setPlaying(false); place(clockRef.current, false); setMessage('Preview finished.'); return; }
      const seg = edl.picture[first.index];
      const v = players[first.index % 2].current;
      if (v && v.readyState >= 2 && !v.seeking && v.dataset.segment === String(first.index)) {
        clockRef.current = Math.max(clockRef.current, seg.outStartMs + (v.currentTime * 1000 - seg.inMs));
        if (clockRef.current >= seg.outEndMs - 1 && first.index === edl.picture.length - 1) clockRef.current = seg.outEndMs;
      }
      setOutMs(clockRef.current);
      place(clockRef.current, true);
      frame = requestAnimationFrame(tick);
    };
    place(clockRef.current, true);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, edl, place]); // eslint-disable-line react-hooks/exhaustive-deps

  // A change to the lesson re-cues the players where the clock stands.
  useEffect(() => { if (!playing) place(clockRef.current, false); }, [edl, urls, place, playing]);

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

  const render = useCallback(async () => {
    if (!lesson) return;
    try {
      const queued = await renderLesson(lesson.cutId);
      setMessage(`Render ${queued.number} queued.`);
      setRenders((await getLesson(shootId)).renders);
    } catch (cause) { setMessage(reason(cause)); }
  }, [lesson, shootId]);

  const runAction = useCallback((action: string, shift: boolean) => {
    if (!lesson || !edl) return;
    const entry = entries[index];
    const frame = entry ? Math.round(1000 / fpsOf(entry.sourceId)) : 33;
    const step = shift ? 1000 : frame;
    switch (action) {
      case 'selectPrevious': case 'selectNext': {
        if (!entries.length) return;
        const forward = action === 'selectNext';
        if (shift) {
          if (!entry) return;
          const to = index + (forward ? 1 : -1);
          if (to < 0 || to >= entries.length) { setMessage(forward ? 'Already the last brick.' : 'Already the first brick.'); return; }
          send({ type: 'move', id: entry.id, to });
          return;
        }
        const next = index < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, index + (forward ? 1 : -1)));
        setSelected(entries[next].id);
        if (!playing) seek(edl.picture[next]?.outStartMs ?? 0);
        return;
      }
      case 'remove': if (entry) send({ type: 'remove', id: entry.id }); else setMessage('No brick selected.'); return;
      case 'add': {
        const brick = lesson.available.find((b) => b.id === pick) ?? lesson.available[0];
        if (!brick) { setMessage('Every brick is already in the lesson.'); return; }
        send({ type: 'add', entry: { brickId: brick.id }, position: index < 0 ? entries.length : index + 1 });
        return;
      }
      case 'trimIn': case 'extendIn': case 'trimOut': case 'extendOut': {
        if (!entry) { setMessage('No brick selected.'); return; }
        const edge = action.endsWith('In') ? 'in' : 'out';
        const tighten = action.startsWith('trim');
        // Tightening moves the in point later and the out point earlier; extending moves them back out.
        const deltaMs = (edge === 'in') === tighten ? step : -step;
        send({ type: 'trim', id: entry.id, edge, deltaMs });
        return;
      }
      case 'toggleTransition': {
        if (!entry) { setMessage('No brick selected.'); return; }
        if (index === entries.length - 1) { setMessage('The last brick has nothing after it to dissolve into.'); return; }
        send({ type: 'setTransition', id: entry.id, transition: entry.transition === 'dissolve' ? 'cut' : 'dissolve' });
        return;
      }
      case 'playPause': {
        if (playing) { setPlaying(false); place(clockRef.current, false); return; }
        const seg = edl.picture[index];
        if (seg && !(clockRef.current >= seg.outStartMs && clockRef.current < seg.outEndMs)) clockRef.current = seg.outStartMs;
        if (clockRef.current >= (lesson.lengthMs ?? 0)) clockRef.current = 0;
        setMessage('');
        setPlaying(true);
        return;
      }
      case 'undo': {
        const last = undo.at(-1);
        if (!last) { setMessage('Nothing to undo.'); return; }
        setUndo((stack) => stack.slice(0, -1));
        send(last, { isUndo: true });
        return;
      }
      case 'render': void render(); return;
    }
  }, [lesson, edl, entries, index, pick, playing, undo, send, seek, place, render, fpsOf]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) && (el as HTMLInputElement).type !== 'range')) return;
      const action = (keymap.bindings as Record<string, string>)[event.code];
      if (!action || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      runAction(action, event.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction]);

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!lesson || !edl) return <p role="status">Loading the lesson…</p>;

  const playingNow = activeAt(edl, outMs).map((a) => a.index + 1);
  const spriteOf = (e: LessonEntry) => {
    const s = lesson.sources.find((x) => x.id === e.sourceId);
    const layout = s?.spriteLayout;
    if (!s?.spriteUrl || !layout) return undefined;
    const tile = Math.min(layout.count - 1, Math.floor((e.brickInMs + e.trimInMs) / 1000 / layout.intervalSeconds));
    return { width: layout.tileWidth, height: layout.tileHeight, backgroundImage: `url(${s.spriteUrl})`,
      backgroundPosition: `-${(tile % layout.columns) * layout.tileWidth}px -${Math.floor(tile / layout.columns) * layout.tileHeight}px` };
  };

  return <section className="lesson-timeline" aria-label="Lesson timeline">
    <p className="subtle">PROTOTYPE · {lesson.shootName} · build {import.meta.env.VITE_BUILD_SHA ?? 'development'}</p>
    <h1>Lesson: {lesson.shootName}</h1>

    <div className="lesson-preview" data-testid="preview" data-out-ms={Math.round(outMs)}>
      {players.map((ref, k) => <video key={k} ref={ref} className="lesson-player" preload="auto" playsInline data-testid={`video-preview-${k}`}
        onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.dataset.pending) { v.currentTime = Number(v.dataset.pending) / 1000; delete v.dataset.pending; } }}
        onError={(e) => { const id = e.currentTarget.dataset.sourceId; if (id) { e.currentTarget.dataset.url = ''; void loadUrl(id).catch(() => setMessage('A proxy could not be played.')); } }} />)}
      {!edl.picture.length && <p className="lesson-empty">No bricks in the lesson. Add one from “Not in the lesson” with A.</p>}
    </div>
    <p data-testid="text-preview-clock">{clock(outMs)} / {clock(lesson.lengthMs)}{playingNow.length ? ` · brick ${playingNow.join(' → ')}` : ''}{playing && <strong> · playing</strong>}</p>
    <input type="range" className="lesson-seek" aria-label="Preview position" min={0} max={lesson.lengthMs} step={1} value={Math.round(outMs)}
      onChange={(e) => seek(Number(e.target.value))} data-testid="input-preview-seek" />

    {message && <p role="status" data-testid="text-lesson-message">{message}</p>}

    <ol className="lesson-strip" aria-label="Lesson bricks" data-testid="strip">
      {entries.map((e, i) => <li key={e.id} className={`lesson-tile${e.id === selected ? ' selected' : ''}`} data-testid={`tile-${e.id}`}
        onClick={() => { setSelected(e.id); if (!playing) seek(edl.picture[i]?.outStartMs ?? 0); }}>
        <div className="lesson-thumb" style={spriteOf(e)} />
        <div><strong>{i + 1}</strong> · <span data-testid={`text-tile-length-${e.id}`}>{clock(lengthOf(e))}</span>{e.tags.length > 0 && <> · {e.tags.join(', ')}</>}</div>
        {i < entries.length - 1 && <div className="lesson-transition" data-testid={`text-transition-${e.id}`}>{e.transition === 'dissolve' ? `dissolve ${dissolveOut(edl.picture[i] ?? {}) / 1000 || 1} s` : 'cut'}</div>}
      </li>)}
    </ol>
    <p>Lesson length <strong data-testid="text-lesson-length">{clock(lesson.lengthMs)}</strong> · {entries.length} brick{entries.length === 1 ? '' : 's'}</p>

    <section className="plain-section">
      <h2>Not in the lesson</h2>
      {lesson.available.length === 0 ? <p className="subtle">Every logged brick is in the lesson.</p> :
        <ul className="lesson-available">{lesson.available.map((b) => <li key={b.id} className={b.id === pick ? 'selected' : ''} onClick={() => setPick(b.id)}
          data-testid={`available-${b.id}`}>{clock(b.inMs)}–{clock(b.outMs)}{b.tags.length > 0 && ` · ${b.tags.join(', ')}`}</li>)}</ul>}
    </section>

    <section className="plain-section">
      <h2>Renders</h2>
      <p><button type="button" onClick={() => void render()} disabled={!entries.length} data-testid="button-render">Render (R)</button></p>
      {renders.length === 0 ? <p className="subtle">Nothing rendered yet.</p> :
        <table className="plain-table"><thead><tr><th>#</th><th>Requested</th><th>Length</th><th>State</th><th /></tr></thead>
          <tbody>{renders.map((r) => <tr key={r.id} data-testid={`row-render-${r.number}`}>
            <td>{r.number}</td><td>{new Date(r.createdAt).toLocaleString()}</td><td>{clock(r.lengthMs)}</td>
            <td data-testid={`text-render-state-${r.number}`}>{r.state === 'claimed' ? 'rendering…' : r.state === 'queued' ? 'queued…' : r.state === 'failed' ? `failed: ${r.error ?? 'unknown error'}` : r.state}</td>
            <td>{r.state === 'ready' && <>
              <button type="button" onClick={async () => { try { setWatching({ number: r.number, url: (await getRenderFile(r.id)).url }); } catch (c) { setMessage(reason(c)); } }}
                data-testid={`button-play-render-${r.number}`}>Play</button>{' '}
              <button type="button" onClick={async () => { try { window.location.assign((await getRenderDownload(r.id)).url); } catch (c) { setMessage(reason(c)); } }}
                data-testid={`button-download-render-${r.number}`}>Download</button></>}</td>
          </tr>)}</tbody></table>}
      {watching && <figure><video src={watching.url} controls autoPlay className="lesson-render-player" data-testid="video-render" />
        <figcaption>Render {watching.number}</figcaption></figure>}
    </section>

    <details className="subtle"><summary>Keys</summary>
      <p>←/→ select a brick (Shift: move it) · X remove from the lesson · A add the picked brick from “Not in the lesson” · [ tighten the in point,
        ] tighten the out point, by a frame (Shift: a second) · , and . extend the in or out point back out · D cut or 1 s dissolve after the brick ·
        Space play/pause from the selected brick · Esc undo · R render.</p>
    </details>
  </section>;
}
