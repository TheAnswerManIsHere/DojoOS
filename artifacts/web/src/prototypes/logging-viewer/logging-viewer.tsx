// PROTOTYPE — the logging viewer, third version (David's feedback, 2026-10-28 and 2026-10-29): log one source in one
// watching pass from the keyboard. Every edit is a command sent to the server, which applies it with applyCommand and
// answers with the bricks and the command that reverses it; Esc sends that inverse back and Shift+Esc the undo's own
// inverse (redo). The player moves by the rules every player shares (@workspace/shared/navigation): ← / → by word,
// Shift 5 s, Option a frame, J/K/L the speed. P opens a brick on its own: it plays exactly the brick, its strip shows a
// few seconds either side, and its edges move by word or frame, or to the playhead. A file's log is not started, in
// progress, or done — done by the operator's word, and still editable. Bindings live in keymap.json; the questions live
// in questions.json and reach Jared through the rail.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'wouter';
import { applySourceCommand, getSourceLog, getSourcePeaks, markLogDone, markLogInProgress, type LogBrick, type LogStatus, type NextToLog,
  type Peaks, type SourceLog } from '@workspace/api-client-react';
import { brickTags, framingPresets, snapToWord, stepToWord, type Command } from '@workspace/shared/commands';
import { modifierOf, navigationTarget, nextSpeed, playerKeys } from '@workspace/shared/navigation';
import { useProxyVideo } from '../../player/proxy-video';
import { describeTarget, noteKey, reportKeyProblem } from '../../player/key-log';
import keymap from './keymap.json';

const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};
const roles: Record<string, string> = { camera_a: 'Camera A', camera_b: 'Camera B', audio: 'Audio' };
const statusLabel: Record<LogStatus, string> = { not_started: 'Not started', in_progress: 'In progress', done: 'Done' };
const reason = (cause: unknown) => (cause as { data?: { error?: string } })?.data?.error ?? (cause instanceof Error ? cause.message : 'That did not apply.');
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
const bindings = keymap.bindings as Record<string, string>;
const editorBindings = keymap.editor as Record<string, string>;
const typing = (el: Element | null) => !!el && ((el as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** Click or drag along a strip to move the playhead — mouse or finger — between `fromMs` and `toMs`. */
function useScrub(seek: (ms: number) => void, fromMs: number, toMs: number) {
  const dragging = useRef(false);
  const at = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return fromMs + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (toMs - fromMs);
  };
  return {
    at,
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if ((e.target as HTMLElement).dataset.brick) return;
        dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seek(at(e));
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (dragging.current) seek(at(e)); },
      onPointerUp: () => { dragging.current = false; },
      onPointerCancel: () => { dragging.current = false; },
    },
  };
}

export function LoggingViewer({ sourceId }: { sourceId: string }) {
  const [log, setLog] = useState<SourceLog>();
  const [loadError, setLoadError] = useState('');
  const [bricks, setBricks] = useState<LogBrick[]>([]);
  const [status, setStatus] = useState<LogStatus>('not_started');
  const [next, setNext] = useState<NextToLog>(null);
  const [openWarning, setOpenWarning] = useState<number[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<Command[]>([]);
  const [redo, setRedo] = useState<Command[]>([]);
  const [message, setMessage] = useState('');
  const [noting, setNoting] = useState<{ id: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [peaksFailed, setPeaksFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [keysPaused, setKeysPaused] = useState(false);
  const [reported, setReported] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const busy = useRef(Promise.resolve());
  const player = useProxyVideo(video, sourceId, setMessage);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const loaded = await getSourceLog(sourceId);
        if (!live) return;
        setLog(loaded); setBricks(loaded.bricks); setStatus(loaded.logStatus); setNext(loaded.next);
        if (loaded.hasPeaks) getSourcePeaks(sourceId).then((p) => live && setPeaks(p), () => live && setPeaksFailed(true));
      } catch (cause) { if (live) setLoadError(reason(cause)); }
    })();
    return () => { live = false; };
  }, [sourceId]);

  // Keys go to a text box while one has the focus; the page says so rather than seeming not to respond.
  useEffect(() => {
    const check = () => setKeysPaused(typing(document.activeElement) && (document.activeElement as HTMLElement).dataset.testid !== 'input-note');
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', () => setTimeout(check, 0));
    return () => { document.removeEventListener('focusin', check); };
  }, []);

  const durationMs = log?.durationMs ?? 0;
  const frameMs = 1000 / (log?.fps || 30);
  const now = () => Math.round((video.current?.currentTime ?? 0) * 1000);
  const seekTo = useCallback((ms: number) => { const v = video.current; if (v) v.currentTime = Math.max(0, Math.min(durationMs, ms)) / 1000; }, [durationMs]);
  /** What a key acts on: the brick you selected, or else the innermost open one. */
  const target = useCallback(() => bricks.find((b) => b.id === selected)
    ?? bricks.filter((b) => b.outMs === null).sort((a, b) => (b.openSeq ?? 0) - (a.openSeq ?? 0))[0], [bricks, selected]);
  const selectAndGo = (b: LogBrick) => { setSelected(b.id); seekTo(b.inMs); };

  /** One command at a time, in order: each waits for the last, so undo always reverses what is on screen. An ordinary
   * edit's inverse goes on the undo stack and clears redo; an undo's goes on redo, and a redo's back on undo. */
  const send = useCallback((command: Command | Omit<Extract<Command, { type: 'open' }>, 'id'>, kind: 'edit' | 'undo' | 'redo' = 'edit') => {
    busy.current = busy.current.then(async () => {
      try {
        const result = await applySourceCommand(sourceId, { command: command as Record<string, unknown> });
        setBricks(result.bricks);
        setStatus((s) => (s === 'done' ? 'done' : result.bricks.length ? 'in_progress' : 'not_started'));
        setMessage(''); setOpenWarning(null);
        const inverse = result.inverse as Command;
        // What a key acts on next: the brick just opened, or — after O — the brick just closed.
        if (command.type === 'open' && inverse.type === 'delete') setSelected(inverse.id);
        if (command.type === 'close' && inverse.type === 'reopen') setSelected(inverse.id);
        if (kind === 'undo') setRedo((stack) => [...stack, inverse]);
        else { setUndo((stack) => [...stack, inverse]); if (kind === 'edit') setRedo([]); }
      } catch (cause) {
        setMessage(reason(cause));
      }
    });
  }, [sourceId]);

  /** Moves one edge of a brick to `toMs`, through the nudge command. */
  const moveEdgeTo = useCallback((b: LogBrick, edge: 'in' | 'out', toMs: number) => {
    const from = edge === 'in' ? b.inMs : b.outMs!;
    const deltaMs = Math.round(toMs - from);
    if (deltaMs === 0) { setMessage(`The ${edge} point is already there.`); return; }
    send({ type: 'nudge', id: b.id, edge, deltaMs });
  }, [send]);
  /** Steps one edge to the next word edge in a direction, or one frame with Shift. */
  const stepEdge = useCallback((b: LogBrick, edge: 'in' | 'out', direction: -1 | 1, byFrame: boolean) => {
    const from = edge === 'in' ? b.inMs : b.outMs!;
    const word = byFrame ? null : stepToWord(log?.words ?? null, from, edge, direction);
    if (!byFrame && word === null && log?.words) setMessage('No more words that way; moved a frame instead.');
    moveEdgeTo(b, edge, word ?? from + direction * frameMs);
  }, [log, frameMs, moveEdgeTo]);

  const markDone = async () => {
    try {
      const result = await markLogDone(sourceId);
      setStatus(result.logStatus); setNext(result.next); setOpenWarning(null); setMessage('');
    } catch (cause) {
      const open = (cause as { data?: { openInMs?: number[] } })?.data?.openInMs;
      if (open?.length) { setOpenWarning(open); return; }
      setMessage(reason(cause));
    }
  };
  const markInProgress = async () => {
    try { const result = await markLogInProgress(sourceId); setStatus(result.logStatus); setNext(result.next); }
    catch (cause) { setMessage(reason(cause)); }
  };

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) { setMessage('The video is still loading.'); return; }
    if (v.paused) void player.play(); else v.pause();
  }, [player]);

  const runAction = useCallback((action: string, event: KeyboardEvent) => {
    const v = video.current;
    const t = target();
    const shift = event.shiftKey;
    switch (action) {
      case 'playPause': togglePlay(); return;
      case 'back': case 'forward':
        seekTo(navigationTarget(log?.words ?? null, now(), action === 'forward' ? 1 : -1, modifierOf(event), frameMs, durationMs));
        return;
      case 'slower': case 'normal': case 'faster': {
        const to = nextSpeed(speed, action);
        setSpeed(to);
        if (v) v.playbackRate = to;
        setMessage(`Speed ${to}×`);
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
        // Tab picks which brick a key acts on and leaves the playhead where it is, so O can close the picked brick here.
        if (!bricks.length) return;
        const ordered = [...bricks].sort((a, b) => a.inMs - b.inMs);
        const i = ordered.findIndex((b) => b.id === t?.id);
        const to = shift ? (i <= 0 ? ordered.length - 1 : i - 1) : (i + 1) % ordered.length;
        setSelected(ordered[to].id);
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
        if (!t) { setMessage('Select a brick (Tab, or tap it) to open it.'); return; }
        if (t.outMs === null) { setMessage('This brick is still open: press O to give it an out point, then P to open it.'); return; }
        v?.pause();
        setMessage('');
        setEditing(t.id);
        return;
      }
    }
  }, [bricks, selected, undo, redo, log, frameMs, durationMs, speed, send, target, seekTo, togglePlay]); // eslint-disable-line react-hooks/exhaustive-deps

  // The editor closes itself if its brick goes away (deleted or reopened by an undo), so the page's keys never stay off.
  const editingBrick = bricks.find((b) => b.id === editing && b.outMs !== null);
  useEffect(() => { if (editing && !editingBrick) setEditing(null); }, [editing, editingBrick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (typing(el)) { if (event.code === 'Space') noteKey({ code: event.code, target: describeTarget(el), outcome: 'typed into a text box' }); return; }
      if (event.metaKey || event.ctrlKey || editing) return;
      const action = bindings[event.code] ?? playerKeys[event.code];
      if (!action || (event.altKey && action !== 'back' && action !== 'forward')) return;
      event.preventDefault();
      // A focused button would also take Space or Enter as a click; the key is the page's, not the button's.
      if (el?.tagName === 'BUTTON' || el?.tagName === 'A') el.blur();
      noteKey({ code: `${event.shiftKey ? 'Shift+' : ''}${event.altKey ? 'Option+' : ''}${event.code}`, target: describeTarget(el), outcome: action });
      runAction(action, event);
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

  const scrub = useScrub(seekTo, 0, durationMs);

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!log) return <p role="status">Loading the source…</p>;

  const pct = (ms: number) => `${(100 * ms) / durationMs}%`;
  const words = log.words;
  const near = words?.filter((w) => w.end_ms >= playhead - 6000 && w.start_ms <= playhead + 6000) ?? [];
  const layout = log.spriteLayout;
  const tile = hover !== null && layout ? Math.min(layout.count - 1, Math.floor(hover / 1000 / layout.intervalSeconds)) : null;
  const t = target();
  const ordered = [...bricks].sort((a, b) => a.inMs - b.inMs);
  const page = `/sources/${sourceId}/log`;

  return <section className="logging-viewer" aria-label="Logging viewer">
    <div className="page-head">
      <span className="prototype-tag" title={`Build ${import.meta.env.VITE_BUILD_SHA ?? 'development'}`}>Prototype</span>
      <p className="eyebrow">Logging · {roles[log.role] ?? log.role}</p>
      <div className="card-head"><h1>{log.shootName}</h1>
        <div className="log-status-bar">
          <span className={`pill log-status ${status}`} data-testid="text-log-status">{statusLabel[status]}</span>
          {status === 'done'
            ? <button type="button" className="button-quiet" onClick={() => void markInProgress()} data-testid="button-log-in-progress">Mark as in progress</button>
            : <button type="button" className="button-primary" onClick={() => void markDone()} disabled={!bricks.length} data-testid="button-log-done">I'm done logging</button>}
        </div></div>
    </div>
    {openWarning && <p role="alert" className="status-line error" data-testid="text-open-bricks">
      {openWarning.length} brick{openWarning.length === 1 ? ' is' : 's are'} still open:{' '}
      {openWarning.map((ms) => <button key={ms} type="button" className="button-quiet" onClick={() => { const b = bricks.find((x) => x.inMs === ms); if (b) selectAndGo(b); }}>{clock(ms)}</button>)}
      {' '}— give each an out point with O, or delete it, then mark the log done.</p>}
    {status === 'done' && <div className="next-step" data-testid="next-step">
      <span>✓ This file is logged. You can still change it.</span>
      {next ? <Link href={`/sources/${next.id}/log`} className="button button-primary" data-testid="link-next-file">Log the next file: {roles[next.role] ?? next.role}</Link>
        : <Link href={`/shoots/${log.shootId}/lesson`} className="button button-primary" data-testid="link-open-lesson">Open the lesson</Link>}
    </div>}

    <div className="media-card">
    {player.url
      ? <video ref={video} src={player.url} preload="auto" className="logging-video" data-testid="video-log" playsInline
          onLoadedMetadata={player.onLoadedMetadata} onError={player.onError} onStalled={player.onStalled}
          onTimeUpdate={player.onTimeUpdate} onSeeked={player.onSeeked} onPause={player.onPause} onPlaying={player.onPlaying}
          onClick={() => { (document.activeElement as HTMLElement | null)?.blur(); togglePlay(); }} />
      : <p role="status" style={{ color: '#fff' }}>Loading the proxy…</p>}
    <div className="media-bar"><span data-testid="text-playhead">{clock(playhead)} / {clock(durationMs)}{speed !== 1 && <strong> · {speed}×</strong>}</span>
      <span>{bricks.length} brick{bricks.length === 1 ? '' : 's'}</span></div>
    </div>

    {/* Click or drag anywhere to scrub — mouse or finger; tap a brick to select it and go to its start. */}
    <div className="logging-timeline" data-testid="timeline" {...scrub.handlers}
      onPointerMove={(e) => { setHover(scrub.at(e)); scrub.handlers.onPointerMove(e); }} onPointerLeave={() => setHover(null)}>
      {peaks ? <canvas ref={canvas} width={1000} height={64} className="logging-wave" /> : <p className="subtle logging-absent">{!log.hasPeaks ? 'No waveform for this source.' : peaksFailed ? 'The waveform could not be loaded.' : 'Loading the waveform…'}</p>}
      {bricks.map((b) => <div key={b.id} data-brick={b.id} className={`logging-brick${b.outMs === null ? ' open' : ''}${b.id === t?.id ? ' target' : ''}`}
        style={{ left: pct(b.inMs), width: pct(Math.max(durationMs / 400, (b.outMs ?? playhead) - b.inMs)), top: `${8 + 10 * Math.min(2, depthOf(b, bricks, durationMs))}px` }}
        onPointerDown={(e) => { e.stopPropagation(); selectAndGo(b); }} title={b.note ?? undefined}
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
    {keysPaused && <p className="status-line keys-paused" data-testid="text-keys-paused">Keys are going to a text box.{' '}
      <button type="button" className="button-quiet" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>Use the keys here</button></p>}
    <div className="keys" aria-label="Keys">
      <span><kbd>Space</kbd>play / pause</span><span><kbd>←</kbd><kbd>→</kbd>word (Shift: 5 s · Option: frame)</span>
      <span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>slower · 1× · faster</span><span><kbd>I</kbd><kbd>O</kbd>in · out (Shift: exact)</span>
      <span><kbd>Tab</kbd>select</span><span><kbd>P</kbd>open the brick</span><span><kbd>N</kbd>note</span><span><kbd>A</kbd>action</span>
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
    <p className="subtle report-keys"><button type="button" className="button-quiet" data-testid="button-report-keys" onClick={async () => {
      try { await reportKeyProblem(page, video.current); setReported('Sent. Thank you — the last few key presses went with it.'); }
      catch (cause) { setReported(`Could not send: ${reason(cause)}`); }
    }}>Report a key problem</button>{reported && <span data-testid="text-key-report"> {reported}</span>}</p>

    <div className="card" style={{ marginTop: 18 }}>
    <h2>Bricks</h2>
    {bricks.length === 0 && <p className="subtle">No bricks yet. Press I where a keep starts and O where it ends.</p>}
    <div className="table-scroll"><table className="plain-table" aria-label="Bricks">
      <thead><tr><th>In</th><th>Out</th><th>Note</th><th>Action</th><th>Labels</th></tr></thead>
      <tbody>{ordered.map((b) => <tr key={b.id} className={b.id === t?.id ? 'logging-row-target' : ''} onClick={() => selectAndGo(b)} data-testid={`row-brick-${b.id}`}>
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

    {editingBrick && <BrickEditor brick={editingBrick} sourceId={sourceId} words={words} frameMs={frameMs} durationMs={durationMs} message={message}
      setMessage={setMessage} onMoveTo={(edge, toMs) => moveEdgeTo(editingBrick, edge, toMs)}
      onStep={(edge, direction, byFrame) => stepEdge(editingBrick, edge, direction, byFrame)}
      onClose={() => { setEditing(null); seekTo(editingBrick.inMs); }} />}
  </section>;
}

/** Seconds of the source shown either side of the brick on the editor's strip (David, 2026-10-29). */
const contextMs = 3000;

/** One brick on its own (David, 2026-10-28 and 2026-10-29): playback is exactly the brick — from its in point to its out
 * point, then back to the in point — while the strip shows a few seconds either side to scrub into without moving an
 * edge. B and E go to the start and near the end; I and O set an edge at the playhead; [ ] step the in point and , . the
 * out point by word (Shift: a frame). The player keys are every player's. Esc closes it. */
function BrickEditor({ brick, sourceId, words, frameMs, durationMs, message, setMessage, onMoveTo, onStep, onClose }: {
  brick: LogBrick; sourceId: string; words: SourceLog['words']; frameMs: number; durationMs: number; message: string;
  setMessage: (m: string) => void; onMoveTo: (edge: 'in' | 'out', toMs: number) => void;
  onStep: (edge: 'in' | 'out', direction: -1 | 1, byFrame: boolean) => void; onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const player = useProxyVideo(video, sourceId, setMessage);
  const [time, setTime] = useState(brick.inMs);
  const [speed, setSpeed] = useState(1);
  const inMs = brick.inMs, outMs = brick.outMs!;
  // The strip: a few seconds either side, never narrower than the brick plus that margin as an edge moves outward.
  const fromMs = Math.max(0, inMs - contextMs), toMs = Math.min(durationMs, outMs + contextMs);
  const seek = useCallback((ms: number) => { const v = video.current; if (v) v.currentTime = Math.max(fromMs, Math.min(toMs, ms)) / 1000; }, [fromMs, toMs]);
  const scrub = useScrub(seek, fromMs, toMs);
  const ready = useRef(false);

  // Opened at the in point; and after an edge moves, the next pass starts from the new in point.
  useEffect(() => { if (ready.current) seek(inMs); }, [inMs]); // eslint-disable-line react-hooks/exhaustive-deps
  // Playback is the brick: reaching the out point goes back to the in point. Scrubbed before the in point, play runs on
  // into the brick; started at or after the out point, it starts from the in point.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        const ms = v.currentTime * 1000;
        setTime(ms);
        if (!v.paused && ms >= outMs) v.currentTime = inMs / 1000;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inMs, outMs]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (!v.paused) { v.pause(); return; }
    if (v.currentTime * 1000 >= outMs - frameMs) v.currentTime = inMs / 1000;
    void player.play();
  }, [player, inMs, outMs, frameMs]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) return;
      const action = editorBindings[event.code] ?? playerKeys[event.code];
      if (!action || (event.altKey && action !== 'back' && action !== 'forward')) return;
      event.preventDefault();
      noteKey({ code: `editor ${event.shiftKey ? 'Shift+' : ''}${event.altKey ? 'Option+' : ''}${event.code}`, outcome: action });
      const v = video.current;
      const at = (v?.currentTime ?? 0) * 1000;
      switch (action) {
        case 'close': onClose(); return;
        case 'playPause': togglePlay(); return;
        case 'back': case 'forward':
          seek(navigationTarget(words, at, action === 'forward' ? 1 : -1, modifierOf(event), frameMs, durationMs)); return;
        case 'slower': case 'normal': case 'faster': {
          const to = nextSpeed(speed, action); setSpeed(to); if (v) v.playbackRate = to; return;
        }
        case 'toStart': seek(inMs); return;
        case 'toEnd': seek(Math.max(inMs, outMs - 2000)); return;
        case 'setIn': onMoveTo('in', event.shiftKey ? at : snapToWord(words, at, 'in')); return;
        case 'setOut': onMoveTo('out', event.shiftKey ? at : snapToWord(words, at, 'out')); return;
        case 'inEarlier': onStep('in', -1, event.shiftKey); return;
        case 'inLater': onStep('in', 1, event.shiftKey); return;
        case 'outEarlier': onStep('out', -1, event.shiftKey); return;
        case 'outLater': onStep('out', 1, event.shiftKey); return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onMoveTo, onStep, onClose, togglePlay, seek, words, frameMs, durationMs, speed, inMs, outMs]);

  const span = toMs - fromMs || 1;
  const pos = (ms: number) => `${(100 * (ms - fromMs)) / span}%`;
  const inside = words?.filter((w) => w.end_ms > fromMs && w.start_ms < toMs) ?? [];
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Brick editor" data-testid="brick-editor" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal card">
      <div className="card-head"><div><p className="eyebrow">Brick</p><h2 data-testid="text-editor-span">{clock(inMs)} – {clock(outMs)}</h2>
        {brick.note && <p className="subtle">{brick.note}</p>}</div>
        <button type="button" onClick={onClose} data-testid="button-close-editor">Done (Esc)</button></div>
      <div className="media-card">
        {player.url && <video ref={video} src={player.url} preload="auto" playsInline className="logging-video" data-testid="video-editor"
          onLoadedMetadata={() => { if (!ready.current) { ready.current = true; seek(inMs); } player.onLoadedMetadata(); }}
          onError={player.onError} onStalled={player.onStalled} onTimeUpdate={player.onTimeUpdate} onSeeked={player.onSeeked}
          onPause={player.onPause} onPlaying={player.onPlaying} onClick={togglePlay} />}
        <div className="media-bar"><span data-testid="text-editor-time">{clock(time)}{time < inMs ? ' · before the brick' : time > outMs ? ' · after the brick' : ''}{speed !== 1 && <strong> · {speed}×</strong>}</span>
          <span>{((outMs - inMs) / 1000).toFixed(2)} s</span></div>
      </div>
      {/* The strip: the brick as a band, a few seconds either side shaded; click or drag to scrub. */}
      <div className="editor-strip" data-testid="editor-strip" {...scrub.handlers}>
        <div className="editor-band" style={{ left: pos(inMs), width: `${(100 * (outMs - inMs)) / span}%` }} data-testid="editor-band" />
        {inside.map((w, i) => <span key={i} className="editor-tick" style={{ left: pos(w.start_ms) }} />)}
        <div className="logging-playhead" style={{ left: pos(Math.max(fromMs, Math.min(toMs, time))) }} />
        <span className="editor-strip-label start">{clock(fromMs)}</span><span className="editor-strip-label end">{clock(toMs)}</span>
      </div>
      <p className="logging-words" data-testid="editor-words">{words ? inside.map((w, i) => <span key={i}
        className={w.start_ms < inMs || w.end_ms > outMs ? 'outside' : time >= w.start_ms && time < w.end_ms ? 'current' : ''}>{w.text} </span>) : 'No transcript: the keys move a frame at a time.'}</p>
      <div className="keys">
        <span><kbd>Space</kbd>play the brick</span><span><kbd>←</kbd><kbd>→</kbd>word (Shift: 5 s · Option: frame)</span>
        <span><kbd>B</kbd>to the start</span><span><kbd>E</kbd>near the end</span><span><kbd>I</kbd><kbd>O</kbd>set in · out here (Shift: exact)</span>
        <span><kbd>[</kbd><kbd>]</kbd>in point earlier · later</span><span><kbd>,</kbd><kbd>.</kbd>out point earlier · later</span>
        <span>by word (<kbd>Shift</kbd>: frame)</span><span><kbd>Esc</kbd>done</span></div>
      <div className="editor-buttons">
        <button type="button" onClick={() => seek(inMs)} data-testid="button-to-start">⇤ Start</button>
        <button type="button" onClick={togglePlay} data-testid="button-editor-play">Play / pause</button>
        <button type="button" onClick={() => onStep('in', -1, false)} data-testid="button-in-earlier">◀ In</button>
        <button type="button" onClick={() => onStep('in', 1, false)} data-testid="button-in-later">In ▶</button>
        <button type="button" onClick={() => onStep('out', -1, false)} data-testid="button-out-earlier">◀ Out</button>
        <button type="button" onClick={() => onStep('out', 1, false)} data-testid="button-out-later">Out ▶</button>
        <button type="button" onClick={() => onMoveTo('in', (video.current?.currentTime ?? 0) * 1000)} data-testid="button-set-in">Set in here</button>
        <button type="button" onClick={() => onMoveTo('out', (video.current?.currentTime ?? 0) * 1000)} data-testid="button-set-out">Set out here</button>
      </div>
      {message && <p role="status" className="status-line" data-testid="text-editor-message">{message}</p>}
    </div>
  </div>;
}
