export type SourceProbePayload = { sourceId: string };
export type JobPayloads = { "source.probe": SourceProbePayload };
export type JobKind = keyof JobPayloads;
export type SourceProbeResult = { durationMs: number | null; width: number | null; height: number | null; fps: number | null; probe: unknown };
/** One ffmpeg step's cost, read from its own -benchmark report. */
export type StepCost = { wallMs: number; maxRssKiB: number | null; bytes: number };
/** What a completed source.probe job records: the step-0 and step-1 measurements (architecture.md §2, §9). */
export type SourceIngestResult = {
  durationMs: number | null; width: number | null; height: number | null; fps: number | null;
  originalBytes: number; originalBitRate: number | null; downloadMs: number; probeMs: number;
  proxy: StepCost; sprite: StepCost; peaks: StepCost; uploadMs: number;
};
export type EDL = { cutId: string; entries: Array<{ brickId: string; inMs: number; outMs: number; position: number }> };
export type TemplateSpec = { name: string; orientations: Array<"landscape" | "portrait" | "square">; settings: Record<string, unknown> };