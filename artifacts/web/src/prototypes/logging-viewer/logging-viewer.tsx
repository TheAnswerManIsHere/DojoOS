// PROTOTYPE — the logging viewer, third version (David's feedback, 2026-10-28 and 2026-10-29): log one source in one
// watching pass from the keyboard. Every edit is a command sent to the server, which applies it with applyCommand and
// answers with the bricks and the command that reverses it; Esc sends that inverse back and Shift+Esc the undo's own
// inverse (redo). The player moves by the rules every player shares (@workspace/shared/navigation): ← / → by word,
// Shift 5 s, Option a frame, J/K/L the speed. P opens a brick on its own: it plays exactly the brick, its strip shows a
// few seconds either side, and its edges move by word or frame, or to the playhead. A file's log is not started, in
// progress, or done — done by the operator's word, and still editable. Bindings live in keymap.json; the questions live
// in questions.json and reach Jared through the rail.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { applySourceCommand, getSourceLog, markLogDone, markLogInProgress, type LogBrick, type LogStatus, type NextToLog,
  type SourceLog } from '@workspace/api-client-react';
import { brickTags, framingPresets, snapToWord, stepToWord, type Command } from '@workspace/shared/commands';
import { modifierOf, navigationTarget, nextSpeed, playerKeys, timecode } from '@workspace/shared/navigation';
import { punchInRegion, regionTransform } from '@workspace/shared/edl';
import { BrickEditor } from '../../player/brick-editor';
import { Strip, usePeaks } from '../../player/strip';
import { useProxyVideo } from '../../player/proxy-video';
import { describeTarget, noteKey, reportKeyProblem } from '../../player/key-log';
import keymap from './keymap.json';

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
const typing = (el: Element | null) => !!el && ((el as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

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
  const [hover, setHover] = useState<number | null>(null);
  const [keysPaused, setKeysPaused] = useState(false);
  const [showAction, setShowAction] = useState(false);
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
      } catch (cause) { if (live) setLoadError(reason(cause)); }
    })();
    return () => { live = false; };
  }, [sourceId]);

  // Keys go to a text box while one has the focus; the page says so rather than seeming not to respond.
  useEffect(() => {
    const check = () => setKeysPaused(typing(document.activeElement) && (document.activeElement as HTMLElement).dataset.testid !== 'input-note');
    const later = () => setTimeout(check, 0);
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', later);
    return () => { document.removeEventListener('focusin', check); document.removeEventListener('focusout', later); };
  }, []);

  const durationMs = log?.durationMs ?? 0;
  const frameMs = 1000 / (log?.fps || 30);
  const clock = (ms: number) => timecode(ms, log?.fps);
  const peaks = usePeaks(log ? [{ id: sourceId, hasPeaks: log.hasPeaks }] : []);
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

  /** Esc undoes and Shift+Esc redoes — on the logger and in the brick editor, from one history. */
  const undoRedo = useCallback((redoing: boolean) => {
    const stack = redoing ? redo : undo;
    const last = stack.at(-1);
    if (!last) { setMessage(redoing ? 'Nothing to redo.' : 'Nothing to undo.'); return; }
    (redoing ? setRedo : setUndo)((st) => st.slice(0, -1));
    send(last, redoing ? 'redo' : 'undo');
  }, [undo, redo, send]);

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
      case 'undo': undoRedo(shift); return;
      case 'showAction': setShowAction((on) => !on); return;
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

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!log) return <p role="status">Loading the source…</p>;

  const pct = (ms: number) => `${(100 * ms) / durationMs}%`;
  const words = log.words;
  const near = words?.filter((w) => w.end_ms >= playhead - 6000 && w.start_ms <= playhead + 6000) ?? [];
  const layout = log.spriteLayout;
  const tile = hover !== null && layout ? Math.min(layout.count - 1, Math.floor(hover / 1000 / layout.intervalSeconds)) : null;
  const t = target();
  const ordered = [...bricks].sort((a, b) => a.inMs - b.inMs);
  // The punch-in playing now: of the closed bricks around the playhead that ask for one, the innermost — the latest to start.
  const acting = showAction ? bricks.filter((b) => b.action === 'punch_in' && b.outMs !== null && playhead >= b.inMs && playhead < b.outMs)
    .sort((a, b) => b.inMs - a.inMs)[0] : undefined;
  const actionStyle = acting ? regionTransform(punchInRegion(acting.preset)) : undefined;
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
            : <button type="button" className="button-primary" onClick={() => void markDone()} data-testid="button-log-done">I'm done logging</button>}
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
    {/* Show action (S): while a punch-in brick plays, the picture shows what the render will — that brick's framing. */}
    <div className="video-frame">
    {player.url
      ? <video ref={video} src={player.url} preload="auto" className="logging-video" data-testid="video-log" playsInline style={actionStyle}
          onLoadedMetadata={player.onLoadedMetadata} onError={player.onError} onStalled={player.onStalled}
          onTimeUpdate={player.onTimeUpdate} onSeeked={player.onSeeked} onPause={player.onPause} onPlaying={player.onPlaying}
          onClick={() => { (document.activeElement as HTMLElement | null)?.blur(); togglePlay(); }} />
      : <p role="status" style={{ color: '#fff' }}>Loading the proxy…</p>}
    </div>
    <div className="media-bar"><span data-testid="text-playhead">{clock(playhead)} / {clock(durationMs)}{speed !== 1 && <strong> · {speed}×</strong>}
      {showAction && <strong className="action-badge" data-testid="text-showing-action"> · Showing actions{acting ? ` · Brick ${acting.number ?? ''}: punch in, ${acting.preset}` : ''}</strong>}</span>
      <span>{bricks.length} brick{bricks.length === 1 ? '' : 's'}</span></div>
    </div>

    {/* Click or drag anywhere to scrub — mouse or finger; tap a brick to select it and go to its start. The bricks run
        in a lane along the top; below them the waveform and the word ticks, stacked (David, 2026-10-29). */}
    <Strip fromMs={0} toMs={durationMs} segments={[{ startMs: 0, endMs: durationMs, sourceId, sourceInMs: 0 }]} peaks={peaks}
      words={{ [sourceId]: words }} playhead={() => (video.current?.currentTime ?? 0) * 1000} onSeek={seekTo} onHover={setHover}
      testid="timeline" className="logging-timeline">
      {bricks.map((b) => <div key={b.id} data-brick={b.id} className={`logging-brick${b.outMs === null ? ' open' : ''}${b.id === t?.id ? ' target' : ''}`}
        style={{ left: pct(b.inMs), width: pct(Math.max(durationMs / 400, (b.outMs ?? playhead) - b.inMs)), top: `${8 + 10 * Math.min(2, depthOf(b, bricks, durationMs))}px` }}
        onPointerDown={(e) => { e.stopPropagation(); selectAndGo(b); }} title={`Brick ${b.number ?? ''}${b.note ? ` · ${b.note}` : ''}`}
        data-testid={`span-brick-${b.id}`} />)}
      {tile !== null && layout && log.spriteUrl && <div className="logging-sprite" style={{
        left: pct(hover!), width: layout.tileWidth, height: layout.tileHeight, backgroundImage: `url(${log.spriteUrl})`,
        backgroundPosition: `-${(tile % layout.columns) * layout.tileWidth}px -${Math.floor(tile / layout.columns) * layout.tileHeight}px`,
      }} />}
    </Strip>
    {!log.hasPeaks && <p className="subtle">No waveform for this source.</p>}
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
      <span><kbd>Delete</kbd>remove</span><span><kbd>Esc</kbd>undo (Shift: redo)</span><span><kbd>S</kbd>show actions</span>
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
      <thead><tr><th>#</th><th>In</th><th>Out</th><th>Note</th><th>Action</th><th>Labels</th></tr></thead>
      <tbody>{ordered.map((b) => <tr key={b.id} className={b.id === t?.id ? 'logging-row-target' : ''} onClick={() => selectAndGo(b)} data-testid={`row-brick-${b.id}`}>
        <td data-testid={`text-brick-number-${b.id}`}>{b.number ?? '—'}</td>
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

    {editingBrick && <BrickEditor brick={{ ...editingBrick, outMs: editingBrick.outMs! }} showAction={showAction} onShowAction={setShowAction} sourceId={sourceId} words={words} fps={log.fps}
      durationMs={durationMs} peaks={peaks} message={message} setMessage={setMessage} onMoveTo={(edge, toMs) => moveEdgeTo(editingBrick, edge, toMs)}
      onStep={(edge, direction, byFrame) => stepEdge(editingBrick, edge, direction, byFrame)} onUndo={undoRedo}
      onClose={() => { setEditing(null); seekTo(editingBrick.inMs); }} />}
  </section>;
}

