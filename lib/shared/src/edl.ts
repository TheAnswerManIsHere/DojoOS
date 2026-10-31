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

/** How far a punch-in zooms, until a template sets it (architecture.md §5: the template's punchInScale; step 5). */
export const defaultPunchInScale = 1.5;
/** The part of the picture a punch-in fills the frame with, as fractions of the source frame: 1/scale of its width and
 * height, centred across, and placed down the frame by the preset — the lower third keeps the bottom, the upper third the
 * top (David, 2026-10-30: the action a brick asks for is what plays). One answer for the render and every player. */
export function punchInRegion(preset: string | null | undefined, scale = defaultPunchInScale) {
  const size = 1 / Math.max(1, scale);
  const y = preset === "upper third" ? 0 : preset === "centre" ? (1 - size) / 2 : 1 - size;
  return { x: (1 - size) / 2, y, w: size, h: size };
}
/** The CSS that shows a region full-frame on a player: scaled up about the point that keeps the region's edges on the
 * frame's edges. A player inside a box that clips its overflow then shows exactly what the render will. */
export function regionTransform(region: { x: number; y: number; w: number; h: number } | null | undefined) {
  if (!region || region.w >= 1) return { transform: "", transformOrigin: "" };
  const ox = region.w < 1 ? region.x / (1 - region.w) : 0.5, oy = region.h < 1 ? region.y / (1 - region.h) : 0.5;
  return { transform: `scale(${1 / region.w})`, transformOrigin: `${(ox * 100).toFixed(2)}% ${(oy * 100).toFixed(2)}%` };
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
    const scale = typeof template.punchInScale === "number" ? template.punchInScale : defaultPunchInScale;
    const framing = brick.action === "punch_in" ? [{ atMs: 0, region: punchInRegion(brick.preset, scale) }] : [];
    picture.push({ sourceId: brick.sourceId, inMs, outMs, outStartMs, outEndMs, framing, placement: "full",
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
