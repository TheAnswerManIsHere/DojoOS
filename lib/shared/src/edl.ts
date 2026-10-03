import type { bricks, cuts, revisions, templates } from "./schema";

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

export function resolveCut(_cut: typeof cuts.$inferSelect, _bricks: Array<typeof bricks.$inferSelect>, _template: typeof templates.$inferSelect): ResolvedEDL {
  throw new Error("not implemented");
}

export function clipRevision(_revision: typeof revisions.$inferSelect, _inMs: number, _outMs: number): Partial<ResolvedEDL> {
  throw new Error("not implemented");
}