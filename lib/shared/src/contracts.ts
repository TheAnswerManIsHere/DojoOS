export type SourceProbePayload = { sourceId: string };
export type SourceTranscribePayload = { sourceId: string };
/** Render one revision's frozen composition (PLAN_LESSON_TIMELINE.md §3); shootId lets the library show it running. */
export type CutRenderPayload = { revisionId: string; shootId: string };
export type JobPayloads = { "source.probe": SourceProbePayload; "source.transcribe": SourceTranscribePayload; "cut.render": CutRenderPayload };
/** What a completed cut.render job records. */
export type CutRenderResult = { durationMs: number | null; bytes: number; downloadMs: number; renderMs: number; uploadMs: number; sources: number };
export type JobKind = keyof JobPayloads;
export type SourceProbeResult = { durationMs: number | null; width: number | null; height: number | null; fps: number | null; probe: unknown };
/** One ffmpeg step's cost, read from its own -benchmark report. */
export type StepCost = { wallMs: number; maxRssKiB: number | null; bytes: number };
/** What a completed source.probe job records: the step-0 and step-1 measurements (architecture.md §2, §9). */
export type SourceIngestResult = {
  durationMs: number | null; width: number | null; height: number | null; fps: number | null;
  originalBytes: number; originalBitRate: number | null; downloadMs: number; probeMs: number;
  /** sprite is null for a source with no picture; uploadMs spans the proxy upload, which overlaps the sprite and peaks. */
  proxy: StepCost; sprite: StepCost | null; peaks: StepCost; uploadMs: number;
};
export type EDL = { cutId: string; entries: Array<{ brickId: string; inMs: number; outMs: number; position: number }> };
export type TemplateSpec = { name: string; orientations: Array<"landscape" | "portrait" | "square">; settings: Record<string, unknown> };
/** What a completed source.transcribe job records. */
export type SourceTranscribeResult = { provider: string; version: string; words: number; audioBytes: number; extractMs: number; transcribeMs: number };
