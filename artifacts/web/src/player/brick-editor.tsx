// PROTOTYPE — one brick on its own, shared by the logger and the lesson page (David, 2026-10-28 and 2026-10-29).
// Playback is exactly the brick: from its in point to its last frame, where it stops (it does not loop, so where it
// ended is plain). The strip shows a few seconds either side — waveform and word ticks — to scrub into without moving
// an edge. B and E go to the start and near the end; I and O set an edge at the playhead; [ ] step the in point and
// , . the out point by word (Shift: a frame). Esc undoes and Shift+Esc redoes, as on the logger; D is done.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Peaks } from '@workspace/api-client-react';
import { snapToWord } from '@workspace/shared/commands';
import { modifierOf, navigationTarget, nextSpeed, playerKeys, timecode, type Word } from '@workspace/shared/navigation';
import { useProxyVideo } from './proxy-video';
import { noteKey } from './key-log';
import { Strip } from './strip';
import keys from './brick-editor-keys.json';

/** Seconds of the source shown either side of the brick on the editor's strip (David, 2026-10-29). */
const contextMs = 3000;
const editorBindings = keys.bindings as Record<string, string>;

export type EditableBrick = { inMs: number; outMs: number; note?: string | null; number?: number | null };

export function BrickEditor({ brick, sourceId, words, fps, durationMs, peaks, message, setMessage, onMoveTo, onStep, onUndo, onClose }: {
  brick: EditableBrick; sourceId: string; words: Word[] | null; fps: number | null; durationMs: number; peaks: Record<string, Peaks | null>;
  message: string; setMessage: (m: string) => void; onMoveTo: (edge: 'in' | 'out', toMs: number) => void;
  onStep: (edge: 'in' | 'out', direction: -1 | 1, byFrame: boolean) => void; onUndo: (redo: boolean) => void; onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const player = useProxyVideo(video, sourceId, setMessage);
  const [time, setTime] = useState(brick.inMs);
  const [speed, setSpeed] = useState(1);
  const frameMs = 1000 / (fps || 30);
  const tc = (ms: number) => timecode(ms, fps);
  const inMs = brick.inMs, outMs = brick.outMs;
  // The last frame of the brick: where playback stops.
  const lastFrameMs = Math.max(inMs, outMs - frameMs);
  // The strip: a few seconds either side, never narrower than the brick plus that margin as an edge moves outward.
  const fromMs = Math.max(0, inMs - contextMs), toMs = Math.min(durationMs, outMs + contextMs);
  const seek = useCallback((ms: number) => { const v = video.current; if (v) v.currentTime = Math.max(fromMs, Math.min(toMs, ms)) / 1000; }, [fromMs, toMs]);
  const ready = useRef(false);
  // The edges as they stand now, read by the frame loop: a loop that kept the edges it started with would play past
  // an out point moved after it began.
  const edges = useRef({ inMs, lastFrameMs });
  edges.current = { inMs, lastFrameMs };

  // Opened at the in point; and after an edge moves, the next pass starts from the new in point.
  useEffect(() => { if (ready.current) seek(inMs); }, [inMs]); // eslint-disable-line react-hooks/exhaustive-deps
  // Playback is the brick: it stops on the brick's last frame. Scrubbed before the in point, play runs on into the
  // brick; started from the last frame or after it, it starts again from the in point.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        const ms = v.currentTime * 1000;
        setTime(ms);
        const stopAt = edges.current.lastFrameMs;
        if (!v.paused && ms >= stopAt && ms < stopAt + 1000) { v.pause(); v.currentTime = stopAt / 1000; }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (!v.paused) { v.pause(); return; }
    if (v.currentTime * 1000 >= edges.current.lastFrameMs - frameMs / 2) v.currentTime = edges.current.inMs / 1000;
    void player.play();
  }, [player, frameMs]);

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
        case 'undo': onUndo(event.shiftKey); return;
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
  }, [onMoveTo, onStep, onUndo, onClose, togglePlay, seek, words, frameMs, durationMs, speed, inMs, outMs]);

  const inside = words?.filter((w) => w.end_ms > fromMs && w.start_ms < toMs) ?? [];
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Brick editor" data-testid="brick-editor" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal card">
      <div className="card-head"><div><p className="eyebrow">{brick.number ? `Brick ${brick.number}` : 'Brick'}</p><h2 data-testid="text-editor-span">{tc(inMs)} – {tc(outMs)}</h2>
        {brick.note && <p className="subtle">{brick.note}</p>}</div>
        <button type="button" onClick={onClose} data-testid="button-close-editor">Done (D)</button></div>
      <div className="media-card">
        {player.url && <video ref={video} src={player.url} preload="auto" playsInline className="logging-video" data-testid="video-editor"
          onLoadedMetadata={() => { if (!ready.current) { ready.current = true; seek(inMs); } player.onLoadedMetadata(); }}
          onError={player.onError} onStalled={player.onStalled} onTimeUpdate={player.onTimeUpdate} onSeeked={player.onSeeked}
          onPause={player.onPause} onPlaying={player.onPlaying} onClick={togglePlay} />}
        <div className="media-bar"><span data-testid="text-editor-time">{tc(time)}{time < inMs - 1 ? ' · before the brick' : time > outMs ? ' · after the brick' : ''}{speed !== 1 && <strong> · {speed}×</strong>}</span>
          <span>{tc(outMs - inMs)} long</span></div>
      </div>
      {/* The strip: waveform and word ticks, the brick as a band, a few seconds either side; click or drag to scrub. */}
      <Strip fromMs={fromMs} toMs={toMs} segments={[{ startMs: 0, endMs: durationMs, sourceId, sourceInMs: 0 }]} peaks={peaks}
        words={{ [sourceId]: words }} playhead={() => (video.current?.currentTime ?? 0) * 1000} onSeek={seek} testid="editor-strip"
        bands={[{ fromMs: inMs, toMs: outMs, className: 'brick', testid: 'editor-band' }]}>
        <span className="editor-strip-label start">{tc(fromMs)}</span><span className="editor-strip-label end">{tc(toMs)}</span>
      </Strip>
      <p className="logging-words" data-testid="editor-words">{words ? inside.map((w, i) => <span key={i}
        className={w.start_ms < inMs || w.end_ms > outMs ? 'outside' : time >= w.start_ms && time < w.end_ms ? 'current' : ''}>{w.text} </span>) : 'No transcript: the keys move a frame at a time.'}</p>
      <div className="keys">
        <span><kbd>Space</kbd>play the brick</span><span><kbd>←</kbd><kbd>→</kbd>word (Shift: 5 s · Option: frame)</span>
        <span><kbd>B</kbd>to the start</span><span><kbd>E</kbd>near the end</span><span><kbd>I</kbd><kbd>O</kbd>set in · out here (Shift: exact)</span>
        <span><kbd>[</kbd><kbd>]</kbd>in point earlier · later</span><span><kbd>,</kbd><kbd>.</kbd>out point earlier · later</span>
        <span>by word (<kbd>Shift</kbd>: frame)</span><span><kbd>Esc</kbd>undo (Shift: redo)</span><span><kbd>D</kbd>done</span></div>
      <div className="editor-buttons">
        <button type="button" onClick={() => seek(inMs)} data-testid="button-to-start">⇤ Start</button>
        <button type="button" onClick={togglePlay} data-testid="button-editor-play">Play / pause</button>
        <button type="button" onClick={() => onStep('in', -1, false)} data-testid="button-in-earlier">◀ In</button>
        <button type="button" onClick={() => onStep('in', 1, false)} data-testid="button-in-later">In ▶</button>
        <button type="button" onClick={() => onStep('out', -1, false)} data-testid="button-out-earlier">◀ Out</button>
        <button type="button" onClick={() => onStep('out', 1, false)} data-testid="button-out-later">Out ▶</button>
        <button type="button" onClick={() => onMoveTo('in', (video.current?.currentTime ?? 0) * 1000)} data-testid="button-set-in">Set in here</button>
        <button type="button" onClick={() => onMoveTo('out', (video.current?.currentTime ?? 0) * 1000)} data-testid="button-set-out">Set out here</button>
        <button type="button" onClick={() => onUndo(false)} data-testid="button-editor-undo">Undo</button>
      </div>
      {message && <p role="status" className="status-line" data-testid="text-editor-message">{message}</p>}
    </div>
  </div>;
}
