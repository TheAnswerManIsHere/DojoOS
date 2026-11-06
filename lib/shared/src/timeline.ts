// PROTOTYPE — pure helpers for the one editor's timeline (David, 2026-11-06): which lane each brick sits in on the strip,
// which word is "current" for the transcript box, and the zoom window's arithmetic. No DOM; tested in the web package.

/** Anything with an in point and an end. An open brick's end is passed in by the caller (the playhead, or the source's end). */
export type Span = { id: string; inMs: number; endMs: number };

/** Lanes, assigned like tracks: bricks in order of start, the longer first on a tie, each in the highest lane (0 = top)
 * where it overlaps nothing. So no brick covers another, and a brick that contains others sits above them. */
export function assignLanes(spans: Span[]): Map<string, number> {
  const ordered = [...spans].sort((a, b) => a.inMs - b.inMs || (b.endMs - b.inMs) - (a.endMs - a.inMs) || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const s of ordered) {
    let lane = laneEnds.findIndex((end) => end <= s.inMs);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(s.endMs); } else laneEnds[lane] = s.endMs;
    lanes.set(s.id, lane);
  }
  return lanes;
}

/** The word the transcript box highlights: the last one to have started at or before the playhead, so between two words
 * the one just spoken stays highlighted. -1 before the first word. Words are in time order. */
export function currentWordIndex(words: ReadonlyArray<{ start_ms: number }>, atMs: number): number {
  let lo = 0, hi = words.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start_ms <= atMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Deepest zoom: about three seconds across the strip, so a frame is about ten pixels wide (David, 2026-11-06). */
export const minViewMs = 3000;

/** A zoom window: `null` means the whole range fits. Clamped so it never runs past either end of the range, is never
 * narrower than the deepest zoom (or the range itself, if shorter), and turns back into "fits" at full width. */
export function clampView(rangeFrom: number, rangeTo: number, fromMs: number, spanMs: number): { fromMs: number; toMs: number } | null {
  const full = Math.max(1, rangeTo - rangeFrom);
  const span = Math.max(Math.min(minViewMs, full), Math.min(full, spanMs));
  if (span >= full) return null;
  const from = Math.max(rangeFrom, Math.min(rangeTo - span, fromMs));
  return { fromMs: from, toMs: from + span };
}

/** Zooming by `factor` (>1 in, <1 out) keeps `anchorMs` where it was on screen. */
export function zoomAround(rangeFrom: number, rangeTo: number, view: { fromMs: number; toMs: number }, factor: number, anchorMs: number) {
  const span = view.toMs - view.fromMs;
  const next = span / factor;
  const ratio = span > 0 ? (anchorMs - view.fromMs) / span : 0.5;
  return clampView(rangeFrom, rangeTo, anchorMs - ratio * next, next);
}
