// PROTOTYPE — the logging viewer, first version (PLAN_LOGGING_VIEWER.md): log one source in one watching pass from the
// keyboard. Every edit is a command sent to the server, which applies it with applyCommand and answers with the bricks
// and the command that reverses it; Esc sends that inverse back. Bindings live in keymap.json; the questions it exists
// to answer live in questions.json and reach Jared through the rail.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applySourceCommand, getPlayback, getSourceLog, getSourcePeaks, type LogBrick, type Peaks, type SourceLog } from '@workspace/api-client-react';
import { framingPresets, innermostOpen, keepSpans, snapToWord, type Command } from '@workspace/shared/commands';
import keymap from './keymap.json';

const clock = (ms: number) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};
const actionLabel = (b: LogBrick) => (b.action === 'punch_in' ? `punch in · ${b.preset}` : 'keep');
/** keep → punch in at each preset in turn → keep. */
function nextAction(b: LogBrick): Pick<Extract<Command, { type: 'setAction' }>, 'action' | 'preset'> {
  if (b.action === 'keep') return { action: 'punch_in', preset: framingPresets[0] };
  const i = framingPresets.indexOf(b.preset as (typeof framingPresets)[number]);
  return i >= 0 && i < framingPresets.length - 1 ? { action: 'punch_in', preset: framingPresets[i + 1] } : { action: 'keep', preset: null };
}
/** How many other closed-or-open bricks contain this one: its nesting depth in the drawing. */
function depthOf(b: LogBrick, all: LogBrick[], durationMs: number) {
  const end = (x: LogBrick) => x.outMs ?? durationMs;
  return all.filter((o) => o.id !== b.id && o.inMs <= b.inMs && end(o) >= end(b) && (o.inMs < b.inMs || end(o) > end(b))).length;
}

export function LoggingViewer({ sourceId }: { sourceId: string }) {
  const [log, setLog] = useState<SourceLog>();
  const [loadError, setLoadError] = useState('');
  const [bricks, setBricks] = useState<LogBrick[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<Command[]>([]);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(false);
  const [tagging, setTagging] = useState<{ id: string; text: string } | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string>();
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [peaksFailed, setPeaksFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const busy = useRef(Promise.resolve());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const loaded = await getSourceLog(sourceId);
        if (!live) return;
        setLog(loaded); setBricks(loaded.bricks);
        setVideoUrl((await getPlayback(sourceId)).url);
        if (loaded.hasPeaks) getSourcePeaks(sourceId).then((p) => live && setPeaks(p), () => live && setPeaksFailed(true));
      } catch (cause) { if (live) setLoadError(cause instanceof Error ? cause.message : 'Could not load this source.'); }
    })();
    return () => { live = false; };
  }, [sourceId]);

  const durationMs = log?.durationMs ?? 0;
  const frameMs = 1000 / (log?.fps || 30);
  const now = () => Math.round((video.current?.currentTime ?? 0) * 1000);
  const target = useCallback(() => innermostOpen(bricks) ?? bricks.find((b) => b.id === selected), [bricks, selected]);
  const spans = useMemo(() => keepSpans(bricks), [bricks]);

  /** One command at a time, in order: each waits for the last, so undo always reverses what is on screen. */
  const send = useCallback((command: Command | Omit<Extract<Command, { type: 'open' }>, 'id'>, opts: { isUndo?: boolean } = {}) => {
    busy.current = busy.current.then(async () => {
      try {
        const result = await applySourceCommand(sourceId, { command: command as Record<string, unknown> });
        setBricks(result.bricks);
        setMessage('');
        // What a key acts on next: the brick just opened, or — after O — the brick just closed.
        if (command.type === 'open') {
          const opened = innermostOpen(result.bricks);
          if (opened) setSelected(opened.id);
        }
        const inverse = result.inverse as Command;
        if (command.type === 'close' && inverse.type === 'reopen') setSelected(inverse.id);
        if (!opts.isUndo) setUndo((stack) => [...stack, result.inverse as Command]);
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : 'That did not apply.');
      }
    });
  }, [sourceId]);

  const runAction = useCallback((action: string, shift: boolean) => {
    const v = video.current;
    const t = target();
    switch (action) {
      case 'playPause': if (v) { if (v.paused) void v.play(); else v.pause(); } return;
      case 'back': if (v) v.currentTime = Math.max(0, v.currentTime - 5); return;
      case 'pause': v?.pause(); return;
      case 'faster': if (v) { v.playbackRate = v.playbackRate >= 2 ? 1 : v.playbackRate + 0.25; setMessage(`Speed ${v.playbackRate}×`); } return;
      case 'markIn': send({ type: 'open', atMs: shift ? now() : snapToWord(log?.words ?? null, now(), 'in') }); return;
      case 'markOut': send({ type: 'close', atMs: shift ? now() : snapToWord(log?.words ?? null, now(), 'out') }); return;
      case 'cycleAction': if (t) send({ type: 'setAction', id: t.id, ...nextAction(t) }); else setMessage('No brick to set an action on.'); return;
      case 'tags': if (t) setTagging({ id: t.id, text: t.tags.join(', ') }); else setMessage('No brick to tag.'); return;
      case 'nudgeEarlier': case 'nudgeLater': {
        if (!t) { setMessage('No brick to nudge.'); return; }
        const p = now();
        const edge = t.outMs === null || Math.abs(p - t.inMs) <= Math.abs(p - t.outMs) ? 'in' : 'out';
        const step = shift ? 1000 : frameMs;
        send({ type: 'nudge', id: t.id, edge, deltaMs: Math.round(action === 'nudgeLater' ? step : -step) });
        return;
      }
      case 'selectNext': {
        if (!bricks.length) return;
        const i = bricks.findIndex((b) => b.id === selected);
        const next = shift ? (i <= 0 ? bricks.length - 1 : i - 1) : (i + 1) % bricks.length;
        setSelected(bricks[next].id);
        return;
      }
      case 'delete': {
        const s = bricks.find((b) => b.id === selected);
        if (s) send({ type: 'delete', id: s.id });
        return;
      }
      case 'undo': {
        const last = undo.at(-1);
        if (!last) { setMessage('Nothing to undo.'); return; }
        setUndo((stack) => stack.slice(0, -1));
        send(last, { isUndo: true });
        return;
      }
      case 'preview': setPreview((on) => !on); return;
    }
  }, [bricks, selected, undo, log, frameMs, send, target]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      const action = (keymap.bindings as Record<string, string>)[event.code];
      if (!action || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      runAction(action, event.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction]);

  // The playhead, read every frame while the page is open, and preview the keep: outside a kept span, jump to the next
  // one, and stop after the last.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        const t = v.currentTime * 1000;
        setPlayhead(t);
        if (preview && !v.paused) {
          const inside = spans.some((s) => t >= s.inMs && t < s.outMs);
          if (!inside) {
            const next = spans.find((s) => s.inMs > t);
            if (next) v.currentTime = next.inMs / 1000;
            else { v.pause(); setPreview(false); setMessage('Preview finished.'); }
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [preview, spans]);

  useEffect(() => {
    if (preview && video.current && spans.length) {
      const t = video.current.currentTime * 1000;
      if (!spans.some((s) => t >= s.inMs && t < s.outMs)) video.current.currentTime = (spans.find((s) => s.inMs > t) ?? spans[0]).inMs / 1000;
      void video.current.play();
    } else if (preview && !spans.length) { setPreview(false); setMessage('Nothing kept yet to preview.'); }
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !peaks) return;
    const g = c.getContext('2d')!;
    const w = c.width, h = c.height, pairs = peaks.length;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'currentColor';
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * pairs);
      const min = peaks.data[2 * i] ?? 0, max = peaks.data[2 * i + 1] ?? 0;
      g.fillRect(x, h / 2 - (max / 128) * (h / 2), 1, Math.max(1, ((max - min) / 128) * (h / 2)));
    }
  }, [peaks]);

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!log) return <p role="status">Loading the source…</p>;

  const pct = (ms: number) => `${(100 * ms) / durationMs}%`;
  const words = log.words;
  const near = words?.filter((w) => w.end_ms >= playhead - 6000 && w.start_ms <= playhead + 6000) ?? [];
  const layout = log.spriteLayout;
  const tile = hover !== null && layout ? Math.min(layout.count - 1, Math.floor(hover / 1000 / layout.intervalSeconds)) : null;
  const t = target();

  return <section className="logging-viewer" aria-label="Logging viewer">
    <p className="subtle">PROTOTYPE · {log.shootName} · build {import.meta.env.VITE_BUILD_SHA ?? 'development'}</p>
    <h1>Log: {log.shootName}</h1>
    {videoUrl
      ? <video ref={video} src={videoUrl} preload="auto" className="logging-video" data-testid="video-log"
          onError={() => { getPlayback(sourceId).then((p) => setVideoUrl(p.url), () => setMessage('The proxy could not be played.')); }} />
      : <p role="status">Loading the proxy…</p>}
    <p data-testid="text-playhead">{clock(playhead)} / {clock(durationMs)}{preview && <strong> · previewing the keep</strong>}</p>

    <div className="logging-timeline" data-testid="timeline"
      onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(((e.clientX - r.left) / r.width) * durationMs); }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (video.current) video.current.currentTime = (((e.clientX - r.left) / r.width) * durationMs) / 1000; }}>
      {peaks ? <canvas ref={canvas} width={1000} height={60} className="logging-wave" /> : <p className="subtle logging-absent">{!log.hasPeaks ? 'No waveform for this source.' : peaksFailed ? 'The waveform could not be loaded.' : 'Loading the waveform…'}</p>}
      {bricks.map((b) => <div key={b.id} className={`logging-brick${b.outMs === null ? ' open' : ''}${b.id === t?.id ? ' target' : ''}`}
        style={{ left: pct(b.inMs), width: pct((b.outMs ?? playhead) - b.inMs), top: `${4 + 10 * depthOf(b, bricks, durationMs)}px` }}
        data-testid={`span-brick-${b.id}`} />)}
      <div className="logging-playhead" style={{ left: pct(playhead) }} />
      {tile !== null && layout && log.spriteUrl && <div className="logging-sprite" style={{
        left: pct(hover!), width: layout.tileWidth, height: layout.tileHeight, backgroundImage: `url(${log.spriteUrl})`,
        backgroundPosition: `-${(tile % layout.columns) * layout.tileWidth}px -${Math.floor(tile / layout.columns) * layout.tileHeight}px`,
      }} />}
    </div>
    {!log.spriteUrl && <p className="subtle">No thumbnail sprite for this source.</p>}

    <p className="logging-words" data-testid="transcript-strip">
      {words ? near.map((w, i) => <span key={`${w.start_ms}-${i}`} className={playhead >= w.start_ms && playhead < w.end_ms ? 'current' : ''}>{w.text} </span>)
        : 'No transcript for this source: I and O mark the raw playhead.'}
    </p>

    {tagging && <form className="plain-form" onSubmit={(e) => {
      e.preventDefault();
      send({ type: 'setTags', id: tagging.id, tags: tagging.text.split(',') });
      setTagging(null);
    }}>
      <label>Tags, comma-separated (lesson, short, highlight reel…)
        <input autoFocus value={tagging.text} onChange={(e) => setTagging({ ...tagging, text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setTagging(null); } }} data-testid="input-tags" />
      </label>
    </form>}
    {message && <p role="status" data-testid="text-log-message">{message}</p>}

    <table className="plain-table" aria-label="Bricks">
      <thead><tr><th>In</th><th>Out</th><th>Action</th><th>Tags</th></tr></thead>
      <tbody>{bricks.map((b) => <tr key={b.id} className={b.id === t?.id ? 'logging-row-target' : ''} onClick={() => setSelected(b.id)} data-testid={`row-brick-${b.id}`}>
        <td data-testid={`text-brick-in-${b.id}`}>{clock(b.inMs)}</td>
        <td data-testid={`text-brick-out-${b.id}`}>{b.outMs === null ? 'open' : clock(b.outMs)}</td>
        <td data-testid={`text-brick-action-${b.id}`}>{actionLabel(b)}</td>
        <td data-testid={`text-brick-tags-${b.id}`}>{b.tags.join(', ')}</td>
      </tr>)}</tbody>
    </table>
    <details className="subtle"><summary>Keys</summary>
      <p>Space play/pause · J back 5 s · K pause · L faster · I in, O out (word-snapped; Shift for the raw playhead) · A action · T tags · ←/→ nudge
        the nearer edge a frame (Shift: a second) · Tab / Shift+Tab select · Delete remove · Esc undo · P preview the keep.</p>
    </details>
  </section>;
}
