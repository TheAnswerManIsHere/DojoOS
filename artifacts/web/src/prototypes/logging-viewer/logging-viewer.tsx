// PROTOTYPE — the logging viewer, second version (David's feedback, 2026-10-28): log one source in one watching pass
// from the keyboard. Every edit is a command sent to the server, which applies it with applyCommand and answers with the
// bricks and the command that reverses it; Esc sends that inverse back and Shift+Esc sends the undo's own inverse
// (redo). The arrows scrub; J/K/L set the speed; P opens a brick on its own, looping, to set its edges a word (or a
// frame) at a time. Bindings live in keymap.json; the questions live in questions.json and reach Jared through the rail.
import { useCallback, useEffect, useRef, useState } from 'react';
import { applySourceCommand, getPlayback, getSourceLog, getSourcePeaks, type LogBrick, type Peaks, type SourceLog } from '@workspace/api-client-react';
import { brickTags, framingPresets, snapToWord, stepToWord, type Command } from '@workspace/shared/commands';
import keymap from './keymap.json';

const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
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
/** The speeds J and L step through; K returns to 1×. Browsers cannot play video backwards, so J slows rather than reverses. */
const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const bindings = keymap.bindings as Record<string, string>;
const editorBindings = keymap.editor as Record<string, string>;

export function LoggingViewer({ sourceId }: { sourceId: string }) {
  const [log, setLog] = useState<SourceLog>();
  const [loadError, setLoadError] = useState('');
  const [bricks, setBricks] = useState<LogBrick[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<Command[]>([]);
  const [redo, setRedo] = useState<Command[]>([]);
  const [message, setMessage] = useState('');
  const [noting, setNoting] = useState<{ id: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [videoUrl, setVideoUrl] = useState<string>();
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [peaksFailed, setPeaksFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
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
  const seekTo = (ms: number) => { const v = video.current; if (v) v.currentTime = Math.max(0, Math.min(durationMs, ms)) / 1000; };
  /** What a key acts on: the brick you selected, or else the innermost open one. */
  const target = useCallback(() => bricks.find((b) => b.id === selected)
    ?? bricks.filter((b) => b.outMs === null).sort((a, b) => (b.openSeq ?? 0) - (a.openSeq ?? 0))[0], [bricks, selected]);

  /** One command at a time, in order: each waits for the last, so undo always reverses what is on screen. An ordinary
   * edit's inverse goes on the undo stack and clears redo; an undo's goes on redo, and a redo's back on undo. */
  const send = useCallback((command: Command | Omit<Extract<Command, { type: 'open' }>, 'id'>, kind: 'edit' | 'undo' | 'redo' = 'edit') => {
    busy.current = busy.current.then(async () => {
      try {
        const result = await applySourceCommand(sourceId, { command: command as Record<string, unknown> });
        setBricks(result.bricks);
        setMessage('');
        const inverse = result.inverse as Command;
        // What a key acts on next: the brick just opened, or — after O — the brick just closed.
        if (command.type === 'open' && inverse.type === 'delete') setSelected(inverse.id);
        if (command.type === 'close' && inverse.type === 'reopen') setSelected(inverse.id);
        if (kind === 'undo') setRedo((stack) => [...stack, inverse]);
        else { setUndo((stack) => [...stack, inverse]); if (kind === 'edit') setRedo([]); }
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : 'That did not apply.');
      }
    });
  }, [sourceId]);

  /** Moves one edge of a brick to the next word edge in a direction, or one frame with Shift. */
  const moveEdge = useCallback((b: LogBrick, edge: 'in' | 'out', direction: -1 | 1, byFrame: boolean) => {
    if (edge === 'out' && b.outMs === null) { setMessage('This brick is still open: press O to give it an out point first.'); return; }
    const from = edge === 'in' ? b.inMs : b.outMs!;
    const word = byFrame ? null : stepToWord(log?.words ?? null, from, edge, direction);
    const to = word ?? from + direction * frameMs;
    if (!byFrame && word === null && log?.words) setMessage('No more words that way; moved a frame instead.');
    send({ type: 'nudge', id: b.id, edge, deltaMs: Math.round(to - from) });
  }, [log, frameMs, send]);

  const runAction = useCallback((action: string, shift: boolean) => {
    const v = video.current;
    const t = target();
    switch (action) {
      case 'playPause': if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } return;
      case 'scrubBack': case 'scrubForward': {
        const step = shift ? 5000 : 10 * frameMs;
        seekTo(now() + (action === 'scrubForward' ? step : -step));
        return;
      }
      case 'slower': case 'normal': case 'faster': {
        const i = speeds.indexOf(speed);
        const next = action === 'normal' ? 1 : speeds[Math.max(0, Math.min(speeds.length - 1, (i < 0 ? 3 : i) + (action === 'faster' ? 1 : -1)))];
        setSpeed(next);
        if (v) v.playbackRate = next;
        setMessage(`Speed ${next}×`);
        return;
      }
      case 'markIn': send({ type: 'open', atMs: shift ? now() : snapToWord(log?.words ?? null, now(), 'in') }); return;
      case 'markOut': {
        const atMs = shift ? now() : snapToWord(log?.words ?? null, now(), 'out');
        // The selected brick, when it is an open one; otherwise the innermost open brick.
        const chosen = bricks.find((b) => b.id === selected && b.outMs === null);
        send(chosen ? { type: 'close', atMs, id: chosen.id } : { type: 'close', atMs });
        return;
      }
      case 'cycleAction': if (t) send({ type: 'setAction', id: t.id, ...nextAction(t) }); else setMessage('No brick to set an action on.'); return;
      case 'note': if (t) setNoting({ id: t.id, text: t.note ?? '' }); else setMessage('No brick to write a note on.'); return;
      case 'selectNext': {
        if (!bricks.length) return;
        const ordered = [...bricks].sort((a, b) => a.inMs - b.inMs);
        const i = ordered.findIndex((b) => b.id === t?.id);
        const next = shift ? (i <= 0 ? ordered.length - 1 : i - 1) : (i + 1) % ordered.length;
        setSelected(ordered[next].id);
        return;
      }
      case 'delete': {
        if (!t) return;
        if (!window.confirm(`Delete the brick ${clock(t.inMs)}–${t.outMs === null ? 'open' : clock(t.outMs)}${t.note ? ` (“${t.note}”)` : ''}? Esc undoes it.`)) return;
        send({ type: 'delete', id: t.id });
        return;
      }
      case 'undo': {
        if (shift) {
          const last = redo.at(-1);
          if (!last) { setMessage('Nothing to redo.'); return; }
          setRedo((stack) => stack.slice(0, -1));
          send(last, 'redo');
          return;
        }
        const last = undo.at(-1);
        if (!last) { setMessage('Nothing to undo.'); return; }
        setUndo((stack) => stack.slice(0, -1));
        send(last, 'undo');
        return;
      }
      case 'edit': {
        if (!t) { setMessage('Select a brick (Tab, or click it) to open it.'); return; }
        if (t.outMs === null) { setMessage('This brick is still open: press O to give it an out point, then P to open it.'); return; }
        v?.pause();
        setMessage('');
        setEditing(t.id);
        return;
      }
    }
  }, [bricks, selected, undo, redo, log, frameMs, speed, send, target]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey || editing) return;
      const action = bindings[event.code];
      if (!action) return;
      event.preventDefault();
      // A focused button would also take Space or Enter as a click; the key is the page's, not the button's.
      if (el?.tagName === 'BUTTON') el.blur();
      runAction(action, event.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction, editing]);

  // The playhead, read every frame while the page is open.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const v = video.current;
      if (v) setPlayhead(v.currentTime * 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

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
  const at = (clientX: number) => { const r = timeline.current!.getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * durationMs; };
  const words = log.words;
  const near = words?.filter((w) => w.end_ms >= playhead - 6000 && w.start_ms <= playhead + 6000) ?? [];
  const layout = log.spriteLayout;
  const tile = hover !== null && layout ? Math.min(layout.count - 1, Math.floor(hover / 1000 / layout.intervalSeconds)) : null;
  const t = target();
  const ordered = [...bricks].sort((a, b) => a.inMs - b.inMs);
  const editingBrick = bricks.find((b) => b.id === editing && b.outMs !== null);

  return <section className="logging-viewer" aria-label="Logging viewer">
    <div className="page-head">
      <span className="prototype-tag" title={`Build ${import.meta.env.VITE_BUILD_SHA ?? 'development'}`}>Prototype</span>
      <p className="eyebrow">Logging</p>
      <h1>{log.shootName}</h1>
    </div>
    <div className="media-card">
    {videoUrl
      ? <video ref={video} src={videoUrl} preload="auto" className="logging-video" data-testid="video-log" playsInline
          onError={() => { getPlayback(sourceId).then((p) => setVideoUrl(p.url), () => setMessage('The proxy could not be played.')); }} />
      : <p role="status" style={{ color: '#fff' }}>Loading the proxy…</p>}
    <div className="media-bar"><span data-testid="text-playhead">{clock(playhead)} / {clock(durationMs)}{speed !== 1 && <strong> · {speed}×</strong>}</span>
      <span>{bricks.length} brick{bricks.length === 1 ? '' : 's'}</span></div>
    </div>

    {/* Click or drag anywhere to scrub — mouse or finger; click a brick to select it. */}
    <div className="logging-timeline" data-testid="timeline" ref={timeline}
      onPointerDown={(e) => { if ((e.target as HTMLElement).dataset.brick) return; scrubbing.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekTo(at(e.clientX)); }}
      onPointerMove={(e) => { setHover(at(e.clientX)); if (scrubbing.current) seekTo(at(e.clientX)); }}
      onPointerUp={() => { scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; }}
      onPointerLeave={() => setHover(null)}>
      {peaks ? <canvas ref={canvas} width={1000} height={64} className="logging-wave" /> : <p className="subtle logging-absent">{!log.hasPeaks ? 'No waveform for this source.' : peaksFailed ? 'The waveform could not be loaded.' : 'Loading the waveform…'}</p>}
      {bricks.map((b) => <div key={b.id} data-brick={b.id} className={`logging-brick${b.outMs === null ? ' open' : ''}${b.id === t?.id ? ' target' : ''}`}
        style={{ left: pct(b.inMs), width: pct(Math.max(durationMs / 400, (b.outMs ?? playhead) - b.inMs)), top: `${8 + 10 * Math.min(2, depthOf(b, bricks, durationMs))}px` }}
        onPointerDown={(e) => { e.stopPropagation(); setSelected(b.id); }} title={b.note ?? undefined}
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
    <div className="keys" aria-label="Keys">
      <span><kbd>Space</kbd>play / pause</span><span><kbd>←</kbd><kbd>→</kbd>scrub 10 frames (Shift: 5 s)</span>
      <span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>slower · 1× · faster</span><span><kbd>I</kbd><kbd>O</kbd>in · out (Shift: exact)</span>
      <span><kbd>Tab</kbd>select</span><span><kbd>P</kbd>open the brick</span><span><kbd>N</kbd>note</span><span><kbd>E</kbd>action</span>
      <span><kbd>Delete</kbd>remove</span><span><kbd>Esc</kbd>undo (Shift: redo)</span>
    </div>

    {noting && <form className="plain-form" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      send({ type: 'setNote', id: noting.id, note: noting.text });
      setNoting(null);
    }}>
      <label>What is this brick? (a note for you, e.g. “psoas release, side-lying”)
        <input autoFocus value={noting.text} maxLength={500} onChange={(e) => setNoting({ ...noting, text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setNoting(null); } }} data-testid="input-note" />
      </label>
    </form>}
    {message && <p role="status" className="status-line" data-testid="text-log-message">{message}</p>}

    <div className="card" style={{ marginTop: 18 }}>
    <h2>Bricks</h2>
    {bricks.length === 0 && <p className="subtle">No bricks yet. Press I where a keep starts and O where it ends.</p>}
    <div className="table-scroll"><table className="plain-table" aria-label="Bricks">
      <thead><tr><th>In</th><th>Out</th><th>Note</th><th>Action</th><th>Labels</th></tr></thead>
      <tbody>{ordered.map((b) => <tr key={b.id} className={b.id === t?.id ? 'logging-row-target' : ''} onClick={() => setSelected(b.id)} data-testid={`row-brick-${b.id}`}>
        <td data-testid={`text-brick-in-${b.id}`}>{clock(b.inMs)}</td>
        <td data-testid={`text-brick-out-${b.id}`}>{b.outMs === null ? 'open' : clock(b.outMs)}</td>
        <td data-testid={`text-brick-note-${b.id}`}>{b.note ?? <span className="subtle">—</span>}</td>
        <td data-testid={`text-brick-action-${b.id}`}>{actionLabel(b)}</td>
        <td data-testid={`text-brick-tags-${b.id}`}><div className="tag-chips">{brickTags.map((tag) => <button key={tag} type="button"
          className={`chip${b.tags.includes(tag) ? ' on' : ''}`} aria-pressed={b.tags.includes(tag)} data-testid={`chip-${tag}-${b.id}`}
          onClick={(e) => { e.stopPropagation(); send({ type: 'setTags', id: b.id, tags: b.tags.includes(tag) ? b.tags.filter((x) => x !== tag) : [...b.tags, tag] }); }}>{tag}</button>)}
        </div></td>
      </tr>)}</tbody>
    </table></div>
    </div>

    {editingBrick && <BrickEditor brick={editingBrick} url={videoUrl} words={words} frameMs={frameMs} message={message}
      onMove={(edge, direction, byFrame) => moveEdge(editingBrick, edge, direction, byFrame)}
      onClose={() => { setEditing(null); seekTo(editingBrick.inMs); }} />}
  </section>;
}

/** One brick on its own (David, 2026-10-28): it plays on a loop from its in point to its out point, and A / D move the in
 * point and , / . the out point to the previous or next word edge — a frame with Shift. Esc closes it. */
function BrickEditor({ brick, url, words, frameMs, message, onMove, onClose }: {
  brick: LogBrick; url?: string; words: SourceLog['words']; frameMs: number; message: string;
  onMove: (edge: 'in' | 'out', direction: -1 | 1, byFrame: boolean) => void; onClose: () => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(brick.inMs);
  const inMs = brick.inMs, outMs = brick.outMs!;
  // Restart from the in point whenever an edge moves, so the change is heard at once.
  useEffect(() => { const v = player.current; if (v) { v.currentTime = inMs / 1000; void v.play().catch(() => {}); } }, [inMs, outMs]);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const v = player.current;
      if (v) {
        const ms = v.currentTime * 1000;
        setTime(ms);
        if (ms >= outMs || ms < inMs - frameMs) v.currentTime = inMs / 1000;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inMs, outMs, frameMs]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = editorBindings[event.code];
      if (!action) return;
      event.preventDefault();
      if (action === 'close') { onClose(); return; }
      if (action === 'playPause') { const v = player.current; if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } return; }
      const [edge, dir] = ({ inEarlier: ['in', -1], inLater: ['in', 1], outEarlier: ['out', -1], outLater: ['out', 1] } as const)[action as 'inEarlier'] ?? [];
      if (edge) onMove(edge, dir, event.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onMove, onClose]);
  const inside = words?.filter((w) => w.end_ms > inMs - 2000 && w.start_ms < outMs + 2000) ?? [];
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Brick editor" data-testid="brick-editor" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal card">
      <div className="card-head"><div><p className="eyebrow">Brick</p><h2>{clock(inMs)} – {clock(outMs)}</h2>
        {brick.note && <p className="subtle">{brick.note}</p>}</div>
        <button type="button" onClick={onClose} data-testid="button-close-editor">Done (Esc)</button></div>
      <div className="media-card">
        {url && <video ref={player} src={url} preload="auto" playsInline className="logging-video" data-testid="video-editor" />}
        <div className="media-bar"><span data-testid="text-editor-time">{clock(time)}</span><span>{((outMs - inMs) / 1000).toFixed(2)} s</span></div>
      </div>
      <p className="logging-words" data-testid="editor-words">{words ? inside.map((w, i) => <span key={i}
        className={w.start_ms < inMs || w.end_ms > outMs ? 'outside' : time >= w.start_ms && time < w.end_ms ? 'current' : ''}>{w.text} </span>) : 'No transcript: the keys move a frame at a time.'}</p>
      <div className="keys"><span><kbd>A</kbd><kbd>D</kbd>in point earlier · later</span><span><kbd>,</kbd><kbd>.</kbd>out point earlier · later</span>
        <span>by word (<kbd>Shift</kbd>: by frame)</span><span><kbd>Space</kbd>play / pause</span><span><kbd>Esc</kbd>done</span></div>
      <div className="editor-buttons">
        <button type="button" onClick={() => onMove('in', -1, false)} data-testid="button-in-earlier">◀ In</button>
        <button type="button" onClick={() => onMove('in', 1, false)} data-testid="button-in-later">In ▶</button>
        <button type="button" onClick={() => onMove('out', -1, false)} data-testid="button-out-earlier">◀ Out</button>
        <button type="button" onClick={() => onMove('out', 1, false)} data-testid="button-out-later">Out ▶</button>
      </div>
      {message && <p role="status" className="status-line">{message}</p>}
    </div>
  </div>;
}
