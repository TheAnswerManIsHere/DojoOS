import type { revisions } from "./schema";
import { dissolveMs, entrySpan, type LessonBrick, type LessonEntry } from "./lesson";

export interface ResolvedEDL {
  orientation: "16:9" | "9:16";
  slides: Array<{ slideId: string; outStartMs: number; outEndMs: number; transitionOut?: string }>;
  picture: Array<{
    sourceId: string; inMs: number; outMs: number; outStartMs: number; outEndMs: number;
    framing: Array<{ atMs: number; region: { x: number; y: number; w: number; h: number } }>;
    placement: "full" | "split" | "corner" | "hidden"; transitionOut?: string;
  }>;
  narration: Array<{ sourceId: string; inMs: number; outMs: number; outStartMs: number; outEndMs: number; gain: number }>;
  captions: Array<{ startMs: number; endMs: number; text: string; styleRef?: string }>;
  template: Record<string, unknown>;
  chapters: Array<{ atMs: number; title: string }>;
}

/** One entry of a cut, as the resolver reads it: the brick's source and span, and this cut's overrides. */
export type ResolveEntry = { entry: LessonEntry; brick: LessonBrick };

/** The cut's composition on one output clock (architecture.md §5): each entry plays its trimmed span; a dissolve
 * overlaps its two neighbours by its length in picture and narration alike, so the total is the sum of the spans less
 * the overlaps. A dissolve longer than either neighbour (possible only when a brick was shortened after the lesson was
 * built) is shortened to fit, never dropped. Pure: the browser preview and the render read the same answer. */
export function resolveCut(cut: { orientation: "16:9" | "9:16" }, entries: ResolveEntry[], template: Record<string, unknown> = {}): ResolvedEDL {
  const spans = entries.map(({ entry, brick }) => entrySpan(entry, brick));
  const picture: ResolvedEDL["picture"] = [];
  const narration: ResolvedEDL["narration"] = [];
  let at = 0, incoming = 0;
  entries.forEach(({ entry, brick }, i) => {
    const { inMs, outMs } = spans[i];
    const length = outMs - inMs;
    const last = i === entries.length - 1;
    const overlap = !last && entry.transition === "dissolve"
      ? Math.max(0, Math.min(dissolveMs, length - incoming, spans[i + 1].outMs - spans[i + 1].inMs)) : 0;
    const outStartMs = at, outEndMs = at + length;
    picture.push({ sourceId: brick.sourceId, inMs, outMs, outStartMs, outEndMs, framing: [], placement: "full",
      ...(overlap > 0 && { transitionOut: `dissolve:${overlap}` }) });
    narration.push({ sourceId: brick.sourceId, inMs, outMs, outStartMs, outEndMs, gain: 1 });
    at = outEndMs - overlap;
    incoming = overlap;
  });
  return { orientation: cut.orientation, slides: [], picture, narration, captions: [], template, chapters: [] };
}

/** How long a resolved EDL plays. */
export const edlLengthMs = (edl: ResolvedEDL) => Math.max(0, ...edl.picture.map((p) => p.outEndMs), ...edl.narration.map((n) => n.outEndMs));
/** A segment's outgoing dissolve length, or 0 for a cut. */
export const dissolveOut = (segment: { transitionOut?: string }) => Number(/^dissolve:(\d+)$/.exec(segment.transitionOut ?? "")?.[1] ?? 0);

export function clipRevision(_revision: typeof revisions.$inferSelect, _inMs: number, _outMs: number): Partial<ResolvedEDL> {
  throw new Error("not implemented");
}
/** What plays at one output time: the one picture segment there, or the two a dissolve overlaps, each with the source
 * time showing and its share of picture and sound (the incoming segment's rises linearly across the overlap). The
 * preview plays from this, and the checks compare preview and render against it. */
export function activeAt(edl: ResolvedEDL, atMs: number): Array<{ index: number; sourceId: string; sourceMs: number; weight: number }> {
  const live = edl.picture.map((p, index) => ({ p, index })).filter(({ p }) => atMs >= p.outStartMs && atMs < p.outEndMs);
  return live.map(({ p, index }) => {
    const other = live.find((l) => l.index !== index);
    let weight = 1;
    if (other) {
      const later = other.index > index ? other.p : p;
      const overlap = Math.max(1, (other.index > index ? p : other.p).outEndMs - later.outStartMs);
      const rising = Math.min(1, Math.max(0, (atMs - later.outStartMs) / overlap));
      weight = later === p ? rising : 1 - rising;
    }
    return { index, sourceId: p.sourceId, sourceMs: p.inMs + (atMs - p.outStartMs), weight };
  });
}
