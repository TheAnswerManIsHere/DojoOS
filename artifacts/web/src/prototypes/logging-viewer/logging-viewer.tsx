// PROTOTYPE — the one editor, fourth version of the logging viewer (David and Jared, 2026-11-06: logging and editing are
// one step, in one window; the pop-up brick editor is gone). Every edit is a command sent to the server, which applies it
// with applyCommand and answers with the bricks and the command that reverses it; Esc sends that inverse back and
// Shift+Esc the undo's own inverse (redo). The player moves by the rules every player shares
// (@workspace/shared/navigation): ← / → by word, Shift 5 s, Option a frame, J/K/L the speed. I opens a brick and, again
// while it is open, moves its in point; O closes it and, again, moves its out point; a brick picked with Tab or a tap is
// the one I and O move. Its edges also drag on the strip, which zooms (= - \, Ctrl/⌘ + wheel, a pinch) and stacks
// overlapping bricks in lanes, coloured by label. A file's log is not started, in progress, or done — done by the
// operator's word, and still editable. Bindings live in keymap.json; the questions in questions.json reach Jared
// through the rail.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'wouter';
import { applySourceCommand, getSourceLog, markLogDone, markLogInProgress, type LogBrick, type LogStatus, type NextToLog,
  type SourceLog } from '@workspace/api-client-react';
import { brickTags, framingPresets, snapToWord, stepToWord, type Command } from '@workspace/shared/commands';
import { assignLanes } from '@workspace/shared/timeline';
import { modifierOf, navigationTarget, nextSpeed, playerKeys, timecode } from '@workspace/shared/navigation';
import { punchInRegion, regionTransform } from '@workspace/shared/edl';
import { Strip, usePeaks, useStripZoom, type StripGeometry } from '../../player/strip';
import { TranscriptBox } from '../../player/transcript-box';
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
/** A lane's height on the strip, and how many show before the lanes scroll inside themselves. */
const laneHeightPx = 18, lanesShown = 4;
const autoNoteKey = 'dojoos:auto-note';
/** A brick's colour class: its labels, each a stripe of equal height when it has several (David, 2026-11-06). */
const labelColours: Record<string, string> = { lesson: '#2f6fb3', short: '#d9761c', highlight: '#7d4fb3' };
function brickFill(b: LogBrick): { className: string; background?: string } {
  const tags = brickTags.filter((t) => b.tags.includes(t));
  if (b.outMs === null) return { className: 'open' };
  if (tags.length === 0) return { className: 'tag-none' };
  if (tags.length === 1) return { className: `tag-${tags[0]}` };
  const stop = 100 / tags.length;
  return { className: 'tag-many', background: `linear-gradient(to bottom, ${tags.map((t, i) => `${labelColours[t]} ${i * stop}% ${(i + 1) * stop}%`).join(', ')})` };
}
/** How the selected brick came to be selected: picked (Tab, a tap), opened by I, or just closed by O. I moves the in
 * point of a picked or open brick and starts a new one after O; O moves the out point of any of them. */
type PickKind = 'picked' | 'opened' | 'closed';
const bindings = keymap.bindings as Record<string, string>;
const typing = (el: Element | null) => !!el && ((el as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function LoggingViewer({ sourceId }: { sourceId: string }) {
  const [log, setLog] = useState<SourceLog>();
  const [loadError, setLoadError] = useState('');
  const [bricks, setBricks] = useState<LogBrick[]>([]);
  const [status, setStatus] = useState<LogStatus>('not_started');
  const [next, setNext] = useState<NextToLog>(null);
  const [openWarning, setOpenWarning] = useState<number[] | null>(null);
  const [selected, setSelectedId] = useState<string | null>(null);
  const [pick, setPick] = useState<PickKind>('picked');
  const [undo, setUndo] = useState<Command[]>([]);
  const [redo, setRedo] = useState<Command[]>([]);
  const [message, setMessage] = useState('');
  const [noting, setNoting] = useState<{ id: string; text: string; resume: boolean } | null>(null);
  const [autoNote, setAutoNote] = useState(() => { try { return localStorage.getItem(autoNoteKey) === 'on'; } catch { return false; } });
  /** An edge being dragged: where it is now, before the drag lets go and sends one move. */
  const [drag, setDrag] = useState<{ id: string; edge: 'in' | 'out'; ms: number } | null>(null);
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
  const zoom = useStripZoom(0, Math.max(1, durationMs));
  const setSelected = (id: string | null, how: PickKind = 'picked') => { setSelectedId(id); setPick(how); };
  const frameMs = 1000 / (log?.fps || 30);
  const clock = (ms: number) => timecode(ms, log?.fps);
  const peaks = usePeaks(log ? [{ id: sourceId, hasPeaks: log.hasPeaks }] : []);
  const now = () => Math.round((video.current?.currentTime ?? 0) * 1000);
  const seekTo = useCallback((ms: number) => { const v = video.current; if (v) v.currentTime = Math.max(0, Math.min(durationMs, ms)) / 1000; }, [durationMs]);
  /** A key's move: the playhead goes there and a zoomed strip scrolls to show it. */
  const jumpTo = useCallback((ms: number) => { seekTo(ms); zoom.reveal(ms); }, [seekTo, zoom]);
  const toFrame = (ms: number) => Math.round(ms / frameMs) * frameMs;
  /** What a key acts on: the brick you selected, or else the innermost open one. */
  const target = useCallback(() => bricks.find((b) => b.id === selected)
    ?? bricks.filter((b) => b.outMs === null).sort((a, b) => (b.openSeq ?? 0) - (a.openSeq ?? 0))[0], [bricks, selected]);
  const selectAndGo = (b: LogBrick) => { setSelected(b.id); seekTo(b.inMs); };

  /** One command at a time, in order: each waits for the last, so undo always reverses what is on screen. An ordinary
   * edit's inverse goes on the undo stack and clears redo; an undo's goes on redo, and a redo's back on undo. */
  const send = useCallback((command: Command | Omit<Extract<Command, { type: 'open' }>, 'id'>, kind: 'edit' | 'undo' | 'redo' = 'edit'): Promise<Command | null> => {
    const run = busy.current.then(async (): Promise<Command | null> => {
      try {
        const result = await applySourceCommand(sourceId, { command: command as Record<string, unknown> });
        setBricks(result.bricks);
        setStatus((s) => (s === 'done' ? 'done' : result.bricks.length ? 'in_progress' : 'not_started'));
        setMessage(''); setOpenWarning(null);
        const inverse = result.inverse as Command;
        // What a key acts on next: the brick just opened, or — after O — the brick just closed.
        if (command.type === 'open' && inverse.type === 'delete') { setSelectedId(inverse.id); setPick('opened'); }
        if (command.type === 'close' && inverse.type === 'reopen') { setSelectedId(inverse.id); setPick('closed'); }
        if (kind === 'undo') setRedo((stack) => [...stack, inverse]);
        else { setUndo((stack) => [...stack, inverse]); if (kind === 'edit') setRedo([]); }
        return inverse;
      } catch (cause) {
        setMessage(reason(cause));
        return null;
      }
    });
    busy.current = run.then(() => undefined);
    return run;
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

  /** Esc undoes and Shift+Esc redoes, from one history. */
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
        jumpTo(navigationTarget(log?.words ?? null, now(), action === 'forward' ? 1 : -1, modifierOf(event), frameMs, durationMs));
        return;
      case 'slower': case 'normal': case 'faster': {
        const to = nextSpeed(speed, action);
        setSpeed(to);
        if (v) v.playbackRate = to;
        setMessage(`Speed ${to}×`);
        return;
      }
      case 'markIn': {
        // I again while a brick is open, or on a brick you picked, moves its in point; after O, or with nothing
        // selected, it starts a new brick (David, 2026-11-06).
        const atMs = shift ? now() : snapToWord(log?.words ?? null, now(), 'in');
        const chosen = bricks.find((b) => b.id === selected);
        if (chosen && (chosen.outMs === null || pick === 'picked')) moveEdgeTo(chosen, 'in', atMs);
        else send({ type: 'open', atMs });
        return;
      }
      case 'markOut': {
        // O closes the selected open brick, or else the innermost open one; O again — or on a brick you picked —
        // moves that brick's out point (David, 2026-11-06: "Same for O on the out point").
        const atMs = shift ? now() : snapToWord(log?.words ?? null, now(), 'out');
        const chosen = bricks.find((b) => b.id === selected);
        if (chosen && chosen.outMs !== null) { moveEdgeTo(chosen, 'out', atMs); return; }
        const open = chosen ?? bricks.filter((b) => b.outMs === null).sort((a, b) => (b.openSeq ?? 0) - (a.openSeq ?? 0))[0];
        if (!open) { setMessage('No brick to close: press I to start one.'); return; }
        void send({ type: 'close', atMs, id: open.id }).then((inverse) => {
          if (!inverse || !autoNote) return;
          // Automatic note creation: the note box opens as soon as O closes a brick, and the video waits for it.
          const wasPlaying = !!video.current && !video.current.paused;
          video.current?.pause();
          setNoting({ id: open.id, text: '', resume: wasPlaying });
        });
        return;
      }
      case 'toStart': case 'toEnd': {
        // The brick you selected, or else the innermost one under the playhead.
        const at = now();
        const b = t ?? bricks.filter((x) => x.outMs !== null && at >= x.inMs && at < x.outMs).sort((x, y) => y.inMs - x.inMs)[0];
        if (!b) { setMessage('No brick here: select one with Tab or a tap.'); return; }
        if (action === 'toStart') { jumpTo(b.inMs); return; }
        if (b.outMs === null) { setMessage('This brick is still open: it has no end yet.'); return; }
        jumpTo(Math.max(b.inMs, b.outMs - frameMs));
        return;
      }
      case 'inEarlier': case 'inLater': case 'outEarlier': case 'outLater': {
        if (!t) { setMessage('Select a brick (Tab, or tap it) to move its edges.'); return; }
        const edge = action.startsWith('in') ? 'in' : 'out';
        if (edge === 'out' && t.outMs === null) { setMessage('This brick is still open: press O to give it an out point.'); return; }
        stepEdge(t, edge, action.endsWith('Earlier') ? -1 : 1, shift);
        return;
      }
      case 'zoomIn': zoom.zoomIn(now()); return;
      case 'zoomOut': zoom.zoomOut(now()); return;
      case 'zoomFit': zoom.fit(); return;
      case 'cycleAction': if (t) send({ type: 'setAction', id: t.id, ...nextAction(t) }); else setMessage('No brick to set an action on.'); return;
      case 'note': if (t) setNoting({ id: t.id, text: t.note ?? '', resume: false }); else setMessage('No brick to write a note on.'); return;
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
    }
  }, [bricks, selected, pick, autoNote, undo, redo, log, frameMs, durationMs, speed, send, target, seekTo, jumpTo, togglePlay, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (typing(el)) { if (event.code === 'Space') noteKey({ code: event.code, target: describeTarget(el), outcome: 'typed into a text box' }); return; }
      if (event.metaKey || event.ctrlKey) return;
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
  }, [runAction]);

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

  const words = log.words;
  // Lanes from the bricks as saved, so a brick being dragged keeps its lane until the drag lets go.
  const lanes = assignLanes(bricks.map((b) => ({ id: b.id, inMs: b.inMs, endMs: b.outMs ?? Math.max(b.inMs + 1, playhead) })));
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const lanesPx = Math.min(laneCount, lanesShown) * laneHeightPx + 4;
  const edgeOf = (b: LogBrick, edge: 'in' | 'out') => (drag && drag.id === b.id && drag.edge === edge ? drag.ms : edge === 'in' ? b.inMs : b.outMs);
  /** Dragging an edge: the picture shows the frame at the edge while it moves; letting go sends one move, one undo step.
   * Near either end of a zoomed strip the view scrolls, so an edge can go past what is on screen. */
  const startDrag = (b: LogBrick, edge: 'in' | 'out', g: StripGeometry) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    video.current?.pause();
    const stripEl = el.closest<HTMLElement>('.player-strip');
    const clampEdge = (ms: number) => edge === 'in' ? Math.max(0, Math.min((b.outMs ?? durationMs) - frameMs, ms))
      : Math.min(durationMs, Math.max(b.inMs + frameMs, ms));
    let latest = edge === 'in' ? b.inMs : b.outMs!;
    const moveTo = (clientX: number) => {
      const r = stripEl?.getBoundingClientRect();
      if (r && zoom.zoomed) {
        const span = zoom.view.toMs - zoom.view.fromMs;
        if (clientX < r.left + 24) zoom.scrollBy(-span / 50); else if (clientX > r.right - 24) zoom.scrollBy(span / 50);
      }
      latest = clampEdge(toFrame(g.msAt(clientX)));
      setDrag({ id: b.id, edge, ms: latest });
      seekTo(edge === 'in' ? latest : latest - frameMs);
    };
    moveTo(e.clientX);
    const onMove = (ev: PointerEvent) => moveTo(ev.clientX);
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp);
      setDrag(null);
      const from = edge === 'in' ? b.inMs : b.outMs!;
      if (Math.abs(latest - from) >= 1) moveEdgeTo(b, edge, latest);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
  };
  const closeNote = (resume: boolean) => { setNoting(null); if (resume) void player.play(); };
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
          <label className="toggle" data-testid="toggle-auto-note"><input type="checkbox" checked={autoNote} data-testid="input-auto-note" onChange={(e) => {
            setAutoNote(e.target.checked); try { localStorage.setItem(autoNoteKey, e.target.checked ? 'on' : 'off'); } catch { /* still applies */ }
            e.target.blur(); }} /> Automatic note creation</label>
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

    {/* Click or drag anywhere to scrub — mouse or finger; tap a brick to select it and go to its start, and drag the
        selected brick's edges. Bricks stack in lanes along the top, coloured by label; the waveform runs below them. */}
    <div className="strip-zoom" data-testid="strip-zoom">
      <button type="button" className="button-quiet" onClick={() => zoom.zoomOut(now())} data-testid="button-zoom-out" aria-label="Zoom out">−</button>
      <button type="button" className="button-quiet" onClick={() => zoom.zoomIn(now())} data-testid="button-zoom-in" aria-label="Zoom in">+</button>
      <button type="button" className="button-quiet" onClick={zoom.fit} disabled={!zoom.zoomed} data-testid="button-zoom-fit">Fit</button>
      <span data-testid="text-zoom">{zoom.zoomed ? `Showing ${clock(zoom.view.fromMs)}–${clock(zoom.view.toMs)}` : 'Showing the whole file'}</span>
    </div>
    <Strip fromMs={0} toMs={durationMs} segments={[{ startMs: 0, endMs: durationMs, sourceId, sourceInMs: 0 }]} peaks={peaks}
      playhead={() => (video.current?.currentTime ?? 0) * 1000} onSeek={seekTo} onHover={setHover} zoom={zoom}
      onBackground={() => { if (pick === 'picked') setSelected(null); }}
      testid="timeline" className="logging-timeline" style={{ height: lanesPx + 54 }}>
      {(g) => <>
        <div className="brick-lanes" style={{ height: lanesPx }}>
          {bricks.map((b) => {
            const inMs = edgeOf(b, 'in')!, outMs = edgeOf(b, 'out');
            if ((outMs ?? playhead) < g.view.fromMs || inMs > g.view.toMs) return null;
            const fill = brickFill(b);
            return <div key={b.id} data-brick={b.id} data-noscrub="" className={`logging-brick ${fill.className}${b.id === t?.id ? ' target' : ''}${drag?.id === b.id ? ' dragging' : ''}`}
              style={{ left: g.pct(inMs), width: g.width(Math.max(durationMs / 2000, (outMs ?? playhead) - inMs)), top: `${2 + (lanes.get(b.id) ?? 0) * laneHeightPx}px`, background: fill.background }}
              onPointerDown={(e) => { e.stopPropagation(); selectAndGo(b); }} title={`Brick ${b.number ?? ''}${b.note ? ` · ${b.note}` : ''}`}
              data-testid={`span-brick-${b.id}`} />;
          })}
        </div>
        {t && <>
          <div className="edge-handle" data-noscrub="" style={{ left: g.pct(edgeOf(t, 'in')!), top: 4 + (lanes.get(t.id) ?? 0) * laneHeightPx, bottom: 'auto', height: laneHeightPx }}
            onPointerDown={startDrag(t, 'in', g)} data-testid="handle-in" />
          {t.outMs !== null && <div className="edge-handle" data-noscrub="" style={{ left: g.pct(edgeOf(t, 'out')!), top: 4 + (lanes.get(t.id) ?? 0) * laneHeightPx, bottom: 'auto', height: laneHeightPx }}
            onPointerDown={startDrag(t, 'out', g)} data-testid="handle-out" />}
        </>}
        {tile !== null && layout && log.spriteUrl && <div className="logging-sprite" style={{
          left: g.pct(hover!), width: layout.tileWidth, height: layout.tileHeight, backgroundImage: `url(${log.spriteUrl})`,
          backgroundPosition: `-${(tile % layout.columns) * layout.tileWidth}px -${Math.floor(tile / layout.columns) * layout.tileHeight}px`,
        }} />}
      </>}
    </Strip>
    {!log.hasPeaks && <p className="subtle">No waveform for this source.</p>}
    {!log.spriteUrl && <p className="subtle">No thumbnail sprite for this source.</p>}

    <TranscriptBox words={words} playheadMs={playhead} onSeek={jumpTo} testid="transcript-strip"
      empty="No transcript for this source: I and O mark the raw playhead." />
    {keysPaused && <p className="status-line keys-paused" data-testid="text-keys-paused">Keys are going to a text box.{' '}
      <button type="button" className="button-quiet" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>Use the keys here</button></p>}
    <div className="keys" aria-label="Keys">
      <span><kbd>Space</kbd>play / pause</span><span><kbd>←</kbd><kbd>→</kbd>word (Shift: 5 s · Option: frame)</span>
      <span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>slower · 1× · faster</span><span><kbd>I</kbd><kbd>O</kbd>in · out, again to move it (Shift: exact)</span>
      <span><kbd>Tab</kbd>select</span><span><kbd>B</kbd><kbd>E</kbd>brick's first · last frame</span>
      <span><kbd>[</kbd><kbd>]</kbd>in point · <kbd>,</kbd><kbd>.</kbd>out point by word (Shift: frame)</span>
      <span><kbd>N</kbd>note</span><span><kbd>A</kbd>action</span>
      <span><kbd>=</kbd><kbd>-</kbd><kbd>\</kbd>zoom in · out · fit</span>
      <span><kbd>Delete</kbd>remove</span><span><kbd>Esc</kbd>undo (Shift: redo)</span><span><kbd>S</kbd>show actions</span>
    </div>

    {noting && <form className="plain-form" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (noting.text.trim() || !noting.resume) void send({ type: 'setNote', id: noting.id, note: noting.text });
      closeNote(noting.resume);
    }}>
      <label>What is this brick? (a note for you, e.g. “psoas release, side-lying”)
        <input autoFocus value={noting.text} maxLength={500} onChange={(e) => setNoting({ ...noting, text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeNote(noting.resume); } }} data-testid="input-note" />
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
          className={`chip tag-${tag}${b.tags.includes(tag) ? ' on' : ''}`} aria-pressed={b.tags.includes(tag)} data-testid={`chip-${tag}-${b.id}`}
          onClick={(e) => { e.stopPropagation(); send({ type: 'setTags', id: b.id, tags: b.tags.includes(tag) ? b.tags.filter((x) => x !== tag) : [...b.tags, tag] }); }}>{tag}</button>)}
        </div></td>
      </tr>)}</tbody>
    </table></div>
    </div>

  </section>;
}

