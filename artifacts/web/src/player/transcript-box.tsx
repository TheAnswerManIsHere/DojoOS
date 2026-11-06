// PROTOTYPE — the transcript box (David, 2026-11-06): three lines high by default, five or the full transcript on
// request, and it turns a page at a time. The lines hold still while the highlight moves word by word; when the highlight
// passes the last line, the next lines come up and it starts again on their first word. The words are laid out once, at
// the box's real width, and the box only scrolls — a page is a run of whole lines — so nothing reflows while it plays,
// and the highlight changes no word's width. Between words the word just spoken stays highlighted. A click on a word
// moves the playhead to its start without starting playback.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentWordIndex } from '@workspace/shared/timeline';

export type TranscriptWord = { text: string; start_ms: number; end_ms: number };
type Size = '3' | '5' | 'full';
const sizeKey = 'dojoos:transcript-lines';
const sizes: Array<{ value: Size; label: string }> = [{ value: '3', label: '3 lines' }, { value: '5', label: '5 lines' }, { value: 'full', label: 'Full' }];

function storedSize(): Size {
  try { const v = localStorage.getItem(sizeKey); return v === '5' || v === 'full' ? v : '3'; } catch { return '3'; }
}

/** The words, rendered once per transcript; the highlight is moved on the elements directly, so a playing page does not
 * re-render thousands of words every frame. */
const Words = memo(function Words({ words, dim }: { words: TranscriptWord[]; dim?: (w: TranscriptWord) => boolean }) {
  return <>{words.map((w, i) => <span key={i} data-i={i} className={dim?.(w) ? 'outside' : undefined}>{w.text} </span>)}</>;
});

export function TranscriptBox({ words, playheadMs, onSeek, dim, empty, testid }: {
  words: TranscriptWord[] | null; playheadMs: number; onSeek: (ms: number) => void;
  dim?: (w: TranscriptWord) => boolean; empty: string; testid?: string;
}) {
  const [size, setSize] = useState<Size>(storedSize);
  const box = useRef<HTMLDivElement>(null);
  /** Each word's line, and each line's top, measured at the box's current width. */
  const layout = useRef<{ lineOf: number[]; lineTops: number[] }>({ lineOf: [], lineTops: [] });
  const shown = useRef(-1);
  const [measured, setMeasured] = useState(0);

  const measure = () => {
    const el = box.current;
    if (!el) return;
    const spans = el.querySelectorAll<HTMLSpanElement>('span[data-i]');
    const lineOf: number[] = [], lineTops: number[] = [];
    spans.forEach((s) => {
      const top = s.offsetTop;
      if (!lineTops.length || top > lineTops[lineTops.length - 1] + 2) lineTops.push(top);
      lineOf.push(lineTops.length - 1);
    });
    layout.current = { lineOf, lineTops };
    shown.current = -1;
    setMeasured((n) => n + 1);
  };
  useLayoutEffect(measure, [words, size]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; measure(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [words]); // eslint-disable-line react-hooks/exhaustive-deps

  // The highlight and the page, whenever the playhead moves.
  useEffect(() => {
    const el = box.current;
    if (!el || !words?.length) return;
    const i = currentWordIndex(words, playheadMs);
    const spans = el.querySelectorAll<HTMLSpanElement>('span[data-i]');
    if (i !== shown.current) {
      if (shown.current >= 0) spans[shown.current]?.classList.remove('current');
      if (i >= 0) spans[i]?.classList.add('current');
      shown.current = i;
    }
    const { lineOf, lineTops } = layout.current;
    if (!lineTops.length) return;
    const line = lineOf[Math.max(0, i)] ?? 0;
    const base = lineTops[0];
    if (size === 'full') {
      // Full: still while the highlight is in view; when it leaves, its line goes to the top.
      const top = lineTops[line] - base, lineHeight = (lineTops[1] ?? lineTops[0] + 28) - lineTops[0];
      if (top < el.scrollTop || top + lineHeight > el.scrollTop + el.clientHeight) el.scrollTop = top;
    } else {
      const perPage = Number(size);
      const first = Math.floor(line / perPage) * perPage;
      const top = lineTops[first] - base;
      if (el.scrollTop !== top) el.scrollTop = top;
    }
  }, [playheadMs, words, size, measured]);

  return <div className="transcript-box" data-testid={testid}>
    <div className="transcript-size" role="group" aria-label="Transcript size">
      {sizes.map((s) => <button key={s.value} type="button" className={`chip${size === s.value ? ' on' : ''}`} aria-pressed={size === s.value}
        data-testid={`button-transcript-${s.value}`}
        onClick={() => { setSize(s.value); try { localStorage.setItem(sizeKey, s.value); } catch { /* the choice still applies */ } }}>{s.label}</button>)}
    </div>
    <div ref={box} className={`logging-words lines-${size}`} data-testid={testid ? `${testid}-words` : undefined}
      onClick={(e) => {
        const i = (e.target as HTMLElement).closest<HTMLElement>('span[data-i]')?.dataset.i;
        if (i === undefined || !words) return;
        (document.activeElement as HTMLElement | null)?.blur();
        onSeek(words[Number(i)].start_ms);
      }}>
      {words?.length ? <Words words={words} dim={dim} /> : empty}
    </div>
  </div>;
}
