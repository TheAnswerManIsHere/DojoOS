// The lesson render (PLAN_LESSON_TIMELINE.md §3; architecture.md §4–§5): one revision's frozen ResolvedEDL — never
// the live cut — rendered from the originals into one H.264/AAC file fit to 1920×1080. Each original the lesson uses
// is read once; each segment is its own input seeked to its span; a dissolve is a picture cross-fade and an audio
// cross-fade over the same overlap, and a cut is a concatenation, so the file's clock is the resolver's clock.
import { eq } from "drizzle-orm";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dissolveOut, edlLengthMs, revisions, sources, prefixes, type connectDb, type CutRenderResult, type ResolvedEDL } from "@workspace/shared";
import { ffmpeg, probe } from "./media";
import { scratchDir } from "./scratch";

type Db = ReturnType<typeof connectDb>["db"];
export type RenderStorage = {
  download(key: string, file: string, signal?: AbortSignal): Promise<void>;
  put(key: string, file: string, contentType: string, signal?: AbortSignal): Promise<void>;
};
export type RenderInput = { file: string; hasVideo: boolean; hasAudio: boolean };
export const renderSize = { width: 1920, height: 1080, fps: 30 };
const s = (ms: number) => (ms / 1000).toFixed(3);
const since = (started: number) => Math.round(performance.now() - started);

/** ffmpeg's arguments for one resolved EDL: one seeked input per picture segment, a filtergraph that normalises each
 * to the render size, frame rate and audio format, and joins them in order — xfade + acrossfade over a dissolve's
 * overlap, concat at a cut. A source with no picture plays black, one with no sound plays silence. */
export function renderArgs(edl: ResolvedEDL, inputs: Map<string, RenderInput>, output: string): string[] {
  const { width: w, height: h, fps } = renderSize;
  const args: string[] = [];
  const graph: string[] = [];
  edl.picture.forEach((seg, i) => {
    const input = inputs.get(seg.sourceId);
    if (!input) throw new Error(`No original staged for source ${seg.sourceId}`);
    const length = s(seg.outMs - seg.inMs);
    args.push("-ss", s(seg.inMs), "-t", length, "-i", input.file);
    const video = input.hasVideo ? `[${i}:v:0]` : `color=c=black:s=${w}x${h}:r=${fps}:d=${length},`;
    graph.push(`${video}fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
      `format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`);
    const audio = input.hasAudio ? `[${i}:a:0]` : "anullsrc=r=48000:cl=stereo,";
    graph.push(`${audio}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${length},` +
      `atrim=duration=${length},asetpts=PTS-STARTPTS[a${i}]`);
  });
  let v = "v0", a = "a0", accMs = edl.picture[0].outMs - edl.picture[0].inMs;
  for (let i = 1; i < edl.picture.length; i++) {
    const overlap = dissolveOut(edl.picture[i - 1]);
    const nv = `vj${i}`, na = `aj${i}`;
    if (overlap > 0) {
      graph.push(`[${v}][v${i}]xfade=transition=fade:duration=${s(overlap)}:offset=${s(accMs - overlap)}[${nv}]`);
      graph.push(`[${a}][a${i}]acrossfade=d=${s(overlap)}:c1=tri:c2=tri[${na}]`);
    } else graph.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[${nv}][${na}]`);
    v = nv; a = na;
    accMs += edl.picture[i].outMs - edl.picture[i].inMs - overlap;
  }
  return [...args, "-filter_complex", graph.join(";"), "-map", `[${v}]`, "-map", `[${a}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4", output];
}

/** Renders one revision: stages each original it uses once, renders, stores the file under renders/<revision id>.mp4
 * and records the file's length, size and timings on the revision. */
export async function renderRevision(db: Db, storage: RenderStorage, revisionId: string, signal: AbortSignal): Promise<CutRenderResult> {
  const [revision] = await db.select().from(revisions).where(eq(revisions.id, revisionId));
  if (!revision) throw new Error("No such revision");
  const edl = revision.resolvedEdl as ResolvedEDL;
  if (!edl.picture.length) throw new Error("The revision has nothing to render");
  const dir = await mkdtemp(join(scratchDir(), "dojo-render-"));
  try {
    const inputs = new Map<string, RenderInput>();
    const downloadStarted = performance.now();
    for (const sourceId of new Set(edl.picture.map((p) => p.sourceId))) {
      const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
      if (!source) throw new Error(`Source ${sourceId} is gone`);
      const file = join(dir, `original-${inputs.size}`);
      await storage.download(source.originalKey, file, signal);
      const probed = await probe(file, signal);
      inputs.set(sourceId, { file, hasVideo: probed.hasVideo, hasAudio: probed.hasAudio });
    }
    const downloadMs = since(downloadStarted);
    const output = join(dir, "render.mp4");
    const renderStarted = performance.now();
    await ffmpeg(renderArgs(edl, inputs, output), signal);
    const renderMs = since(renderStarted);
    const { durationMs } = await probe(output, signal);
    const bytes = (await stat(output)).size;
    const key = `${prefixes.renders}${revisionId}.mp4`;
    const uploadStarted = performance.now();
    await storage.put(key, output, "video/mp4", signal);
    const result: CutRenderResult = { durationMs, bytes, downloadMs, renderMs, uploadMs: since(uploadStarted), sources: inputs.size };
    await db.update(revisions).set({ renderKey: key, metadata: { ...(revision.metadata as Record<string, unknown>), ...result,
      expectedMs: edlLengthMs(edl) } }).where(eq(revisions.id, revisionId));
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
