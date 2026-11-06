// PROTOTYPE — the strip every player draws under its picture (David, 2026-10-29; zoom, no word ticks, 2026-11-06): the
// waveform, a playhead, and bands for whatever the page marks — a brick, a dissolve. The strip maps its own time onto one
// or more pieces of source (one for a source's log, one per lesson segment), so the same drawing serves every player.
// Click or drag to scrub. With a zoom (useStripZoom) it shows a window of its range, Premiere's way: = and - zoom around
// the playhead and \ fits (the page binds those keys), Ctrl/⌘ + wheel or a pinch zooms around the pointer, a scroll bar
// under it scrolls (its ends zoom), and while it plays the view turns a page when the playhead runs off its right edge.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { getSourcePeaks, type Peaks } from '@workspace/api-client-react';
import { clampView, zoomAround } from '@workspace/shared/timeline';

/** A stretch of the strip's time that shows a stretch of one source: strip time startMs–endMs is source time from sourceInMs. */
export type StripSegment = { startMs: number; endMs: number; sourceId: string; sourceInMs: number };
export type StripBand = { fromMs: number; toMs: number; className: string; label?: string; testid?: string };
export type StripView = { fromMs: number; toMs: number };
/** Where things go on the strip as it is zoomed now: a time's left edge and a duration's width, in percent of the strip. */
export type StripGeometry = { view: StripView; pct: (ms: number) => string; width: (ms: number) => string; msAt: (clientX: number) => number };

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

export type StripZoom = ReturnType<typeof useStripZoom>;
/** The zoom window of a strip whose range is fromMs–toMs. `view` is null while the whole range fits. */
export function useStripZoom(fromMs: number, toMs: number) {
  const [view, setView] = useState<StripView | null>(null);
  const range = useRef({ fromMs, toMs });
  range.current = { fromMs, toMs };
  // A range that changes (a source's length arrives, an edit changes the lesson) keeps the window inside it.
  useEffect(() => { setView((v) => (v ? clampView(fromMs, toMs, v.fromMs, v.toMs - v.fromMs) : v)); }, [fromMs, toMs]);
  const current = useCallback((v: StripView | null) => v ?? range.current, []);
  const zoomBy = useCallback((factor: number, anchorMs: number) =>
    setView((v) => zoomAround(range.current.fromMs, range.current.toMs, current(v), factor, anchorMs)), [current]);
  const scrollTo = useCallback((viewFromMs: number) =>
    setView((v) => (v ? clampView(range.current.fromMs, range.current.toMs, viewFromMs, v.toMs - v.fromMs) : v)), []);
  const scrollBy = useCallback((deltaMs: number) =>
    setView((v) => (v ? clampView(range.current.fromMs, range.current.toMs, v.fromMs + deltaMs, v.toMs - v.fromMs) : v)), []);
  const setWindow = useCallback((viewFromMs: number, viewToMs: number) =>
    setView(clampView(range.current.fromMs, range.current.toMs, viewFromMs, viewToMs - viewFromMs)), []);
  const fit = useCallback(() => setView(null), []);
  /** Brings a time into view, if it is outside it, putting it a tenth of the way in. */
  const reveal = useCallback((ms: number) => setView((v) => {
    if (!v || (ms >= v.fromMs && ms <= v.toMs)) return v;
    const span = v.toMs - v.fromMs;
    return clampView(range.current.fromMs, range.current.toMs, ms - span / 10, span);
  }), []);
  return { view: view ?? { fromMs, toMs }, zoomed: view !== null, zoomBy, zoomIn: (anchorMs: number) => zoomBy(2, anchorMs),
    zoomOut: (anchorMs: number) => zoomBy(0.5, anchorMs), fit, scrollTo, scrollBy, setWindow, reveal, rangeFromMs: fromMs, rangeToMs: toMs };
}

/** The strip. The playhead is read from `playhead()` every frame and moved without re-rendering the page, so a page
 * playing video does not redraw itself sixty times a second. A pointer press on anything marked `data-noscrub` (a
 * brick, an edge handle) is that thing's, not a scrub. */
export function Strip({ fromMs, toMs, segments, peaks, playhead, onSeek, onHover, onBackground, zoom, bands = [], testid, className = '', style, children }: {
  fromMs: number; toMs: number; segments: StripSegment[]; peaks: Record<string, Peaks | null>;
  playhead: () => number; onSeek: (ms: number) => void; onHover?: (ms: number | null) => void;
  /** A press on the strip itself — not on a brick or a handle — before it scrubs. */
  onBackground?: () => void;
  zoom?: StripZoom; bands?: StripBand[]; testid?: string; className?: string; style?: CSSProperties;
  children?: ReactNode | ((geometry: StripGeometry) => ReactNode);
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const view = zoom ? zoom.view : { fromMs, toMs };
  const span = Math.max(1, view.toMs - view.fromMs);
  const pct = (ms: number) => `${(100 * (ms - view.fromMs)) / span}%`;
  const width = (ms: number) => `${(100 * ms) / span}%`;
  const msAt = (clientX: number) => {
    const r = root.current?.getBoundingClientRect();
    if (!r || !r.width) return view.fromMs;
    return view.fromMs + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };
  const geometry: StripGeometry = { view, pct, width, msAt };
  const viewRef = useRef(view);
  viewRef.current = view;

  // The waveform, for the window shown.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(c).color || '#9aa6b2';
    for (let x = 0; x < w; x++) {
      const t = view.fromMs + (x / w) * span;
      const seg = segments.find((s) => t >= s.startMs && t < s.endMs);
      const p = seg && peaks[seg.sourceId];
      if (!p || !p.sample_rate) continue;
      const i = Math.floor(((seg.sourceInMs + (t - seg.startMs)) / 1000) * p.sample_rate / p.samples_per_pixel);
      const min = p.data[2 * i] ?? 0, max = p.data[2 * i + 1] ?? 0;
      g.fillRect(x, h / 2 - (max / 128) * (h / 2), 1, Math.max(1, ((max - min) / 128) * (h / 2)));
    }
  }, [view.fromMs, span, segments, peaks]);

  // The playhead, every frame; and, zoomed in, a page turn when playback carries it off the right edge. A playhead the
  // viewer scrolled away from is left alone: the view follows only a playhead it was already showing.
  const last = useRef<number | null>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const ms = playhead();
      const v = viewRef.current;
      if (head.current) {
        const inView = ms >= v.fromMs && ms <= v.toMs;
        head.current.style.display = inView ? '' : 'none';
        head.current.style.left = `${(100 * (ms - v.fromMs)) / Math.max(1, v.toMs - v.fromMs)}%`;
      }
      const prev = last.current;
      if (zoom?.zoomed && prev !== null && prev >= v.fromMs && prev <= v.toMs && ms > v.toMs && ms - prev < 1500) zoom.scrollTo(ms);
      last.current = ms;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/⌘ + wheel (a trackpad pinch arrives this way too) zooms around the pointer; a sideways wheel, or Shift + wheel,
  // scrolls a zoomed strip. A plain wheel is left to scroll the page.
  useEffect(() => {
    const el = root.current;
    if (!el || !zoom) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom.zoomBy(Math.exp(-e.deltaY * 0.01), msAt(e.clientX));
      } else if (zoom.zoomed && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        zoom.scrollBy((delta / Math.max(1, el.clientWidth)) * (v.toMs - v.fromMs));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Pointers: one scrubs; two pinch to zoom around their midpoint.
  const pointers = useRef(new Map<number, number>());
  const scrubbing = useRef(false);
  const pinch = useRef<{ distance: number; view: StripView; anchorMs: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-noscrub]')) return;
    pointers.current.set(e.pointerId, e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2 && zoom) {
      scrubbing.current = false;
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.max(8, Math.abs(a - b)), view: viewRef.current, anchorMs: msAt((a + b) / 2) };
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    onBackground?.();
    scrubbing.current = true;
    onSeek(msAt(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    onHover?.(msAt(e.clientX));
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e.clientX);
    if (pinch.current && pointers.current.size === 2 && zoom) {
      const [a, b] = [...pointers.current.values()];
      const p = pinch.current;
      const next = zoomAround(zoom.rangeFromMs, zoom.rangeToMs, p.view, Math.max(8, Math.abs(a - b)) / p.distance, p.anchorMs);
      if (next) zoom.setWindow(next.fromMs, next.toMs); else zoom.fit();
      return;
    }
    if (scrubbing.current) onSeek(msAt(e.clientX));
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) scrubbing.current = false;
  };

  const hasPeaks = segments.some((s) => peaks[s.sourceId]);
  return <>
    <div ref={root} className={`player-strip ${className}`} data-testid={testid} style={style} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onPointerLeave={() => onHover?.(null)}>
      {bands.filter((b) => b.toMs > view.fromMs && b.fromMs < view.toMs).map((b, i) => <div key={i} className={`strip-band ${b.className}`}
        style={{ left: pct(b.fromMs), width: width(b.toMs - b.fromMs) }} data-testid={b.testid} title={b.label}>
        {b.label && <span className="strip-band-label">{b.label}</span>}</div>)}
      <canvas ref={canvas} width={1000} height={40} className={`strip-wave${hasPeaks ? '' : ' empty'}`} />
      {typeof children === 'function' ? children(geometry) : children}
      <div ref={head} className="logging-playhead" />
    </div>
    {zoom?.zoomed && <ScrollBar zoom={zoom} testid={testid ? `${testid}-scroll` : undefined} />}
  </>;
}

/** The scroll bar under a zoomed strip: drag the thumb to scroll, either end of it to zoom (Premiere's). */
function ScrollBar({ zoom, testid }: { zoom: StripZoom; testid?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'left' | 'right'; startX: number; view: StripView } | null>(null);
  const full = Math.max(1, zoom.rangeToMs - zoom.rangeFromMs);
  const { fromMs, toMs } = zoom.view;
  const down = (mode: 'move' | 'left' | 'right') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, view: zoom.view };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current, w = track.current?.clientWidth;
    if (!d || !w) return;
    const deltaMs = ((e.clientX - d.startX) / w) * full;
    if (d.mode === 'move') zoom.scrollTo(d.view.fromMs + deltaMs);
    else if (d.mode === 'left') zoom.setWindow(Math.min(d.view.fromMs + deltaMs, d.view.toMs - 1), d.view.toMs);
    else zoom.setWindow(d.view.fromMs, Math.max(d.view.toMs + deltaMs, d.view.fromMs + 1));
  };
  const up = () => { drag.current = null; };
  return <div ref={track} className="strip-scroll" data-testid={testid}
    onPointerDown={(e) => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); const span = toMs - fromMs;
      zoom.scrollTo(zoom.rangeFromMs + ((e.clientX - r.left) / r.width) * full - span / 2); } }}>
    <div className="strip-scroll-thumb" style={{ left: `${(100 * (fromMs - zoom.rangeFromMs)) / full}%`, width: `${(100 * (toMs - fromMs)) / full}%` }}
      onPointerDown={down('move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="strip-scroll-end left" onPointerDown={down('left')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="strip-scroll-end right" onPointerDown={down('right')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
    </div>
  </div>;
}
