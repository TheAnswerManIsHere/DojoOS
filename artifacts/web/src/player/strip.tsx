// PROTOTYPE — the strip every player draws under its picture (David, 2026-10-29): the waveform and the word ticks,
// stacked, so the two can be compared before one of them goes; a playhead; and bands for whatever the page marks —
// a brick, a dissolve. The strip maps its own time onto one or more pieces of source (one for a source's log, one per
// lesson segment), so the same drawing serves the logger, the brick editor and the lesson. Click or drag to scrub.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { getSourcePeaks, type Peaks } from '@workspace/api-client-react';
import type { Word } from '@workspace/shared/navigation';
import { useState } from 'react';

/** A stretch of the strip's time that shows a stretch of one source: strip time startMs–endMs is source time from sourceInMs. */
export type StripSegment = { startMs: number; endMs: number; sourceId: string; sourceInMs: number };
export type StripBand = { fromMs: number; toMs: number; className: string; label?: string; testid?: string };

const peaksCache = new Map<string, Promise<Peaks | null>>();
/** A source's waveform, fetched once per page load and shared by every strip that shows it. */
export function usePeaks(sources: Array<{ id: string; hasPeaks: boolean }>) {
  const [peaks, setPeaks] = useState<Record<string, Peaks | null>>({});
  const key = sources.map((s) => `${s.id}:${s.hasPeaks}`).join(',');
  useEffect(() => {
    let live = true;
    for (const s of sources) {
      if (!s.hasPeaks) continue;
      if (!peaksCache.has(s.id)) peaksCache.set(s.id, getSourcePeaks(s.id).catch(() => null));
      void peaksCache.get(s.id)!.then((p) => { if (live) setPeaks((all) => (all[s.id] === p ? all : { ...all, [s.id]: p })); });
    }
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return peaks;
}

/** Click or drag along a strip to move the playhead — mouse or finger — between `fromMs` and `toMs`. A tap on the strip
 * also takes the keys back from a text box, as a tap on the video does. */
export function useScrub(seek: (ms: number) => void, fromMs: number, toMs: number) {
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
        (document.activeElement as HTMLElement | null)?.blur();
        dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seek(at(e));
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (dragging.current) seek(at(e)); },
      onPointerUp: () => { dragging.current = false; },
      onPointerCancel: () => { dragging.current = false; },
    },
  };
}

/** The strip. The playhead is read from `playhead()` every frame and moved without re-rendering the page, so a page
 * playing video does not redraw itself sixty times a second. */
export function Strip({ fromMs, toMs, segments, peaks, words, playhead, onSeek, onHover, bands = [], testid, className = '', children }: {
  fromMs: number; toMs: number; segments: StripSegment[]; peaks: Record<string, Peaks | null>;
  words: Record<string, Word[] | null | undefined>; playhead: () => number; onSeek: (ms: number) => void; onHover?: (ms: number | null) => void;
  bands?: StripBand[]; testid?: string; className?: string; children?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const scrub = useScrub(onSeek, fromMs, toMs);
  const span = Math.max(1, toMs - fromMs);
  const pct = (ms: number) => `${(100 * (ms - fromMs)) / span}%`;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(c).color || '#9aa6b2';
    for (let x = 0; x < w; x++) {
      const t = fromMs + (x / w) * span;
      const seg = segments.find((s) => t >= s.startMs && t < s.endMs);
      const p = seg && peaks[seg.sourceId];
      if (!p || !p.sample_rate) continue;
      const i = Math.floor(((seg.sourceInMs + (t - seg.startMs)) / 1000) * p.sample_rate / p.samples_per_pixel);
      const min = p.data[2 * i] ?? 0, max = p.data[2 * i + 1] ?? 0;
      g.fillRect(x, h / 2 - (max / 128) * (h / 2), 1, Math.max(1, ((max - min) / 128) * (h / 2)));
    }
  }, [fromMs, span, segments, peaks]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (head.current) head.current.style.left = pct(Math.max(fromMs, Math.min(toMs, playhead())));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Each word's start, in strip time, for every segment it falls inside.
  const ticks: number[] = [];
  for (const seg of segments) for (const word of words[seg.sourceId] ?? []) {
    const at = seg.startMs + (word.start_ms - seg.sourceInMs);
    if (at >= seg.startMs && at < seg.endMs && at >= fromMs && at <= toMs) ticks.push(at);
  }
  const hasPeaks = segments.some((s) => peaks[s.sourceId]);
  return <div className={`player-strip ${className}`} data-testid={testid} {...scrub.handlers}
    onPointerMove={(e) => { onHover?.(scrub.at(e)); scrub.handlers.onPointerMove(e); }} onPointerLeave={() => onHover?.(null)}>
    {bands.map((b, i) => <div key={i} className={`strip-band ${b.className}`} style={{ left: pct(b.fromMs), width: `${(100 * (b.toMs - b.fromMs)) / span}%` }}
      data-testid={b.testid} title={b.label}>{b.label && <span className="strip-band-label">{b.label}</span>}</div>)}
    <canvas ref={canvas} width={1000} height={40} className={`strip-wave${hasPeaks ? '' : ' empty'}`} />
    <div className="strip-words" data-testid={testid ? `${testid}-words` : undefined}>
      {ticks.map((at, i) => <span key={i} className="strip-tick" style={{ left: pct(at) }} />)}
    </div>
    {children}
    <div ref={head} className="logging-playhead" />
  </div>;
}
