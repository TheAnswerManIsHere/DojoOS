export type SourceProbePayload = { sourceId: string };
export type JobPayloads = { "source.probe": SourceProbePayload };
export type JobKind = keyof JobPayloads;
export type SourceProbeResult = { durationMs: number | null; width: number | null; height: number | null; fps: number | null; probe: unknown };
export type EDL = { cutId: string; entries: Array<{ brickId: string; inMs: number; outMs: number; position: number }> };
export type TemplateSpec = { name: string; orientations: Array<"landscape" | "portrait" | "square">; settings: Record<string, unknown> };