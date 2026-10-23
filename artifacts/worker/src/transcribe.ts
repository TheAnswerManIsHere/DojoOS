// Transcription runs as its own job after ingest (architecture.md §4), so a provider failure retries the transcription
// alone and never downloads the original again. It reads the speech track out of the proxy through a signed URL,
// sends that to the provider, and stores the word-timed transcript. A source keeps its newest transcript; an earlier
// one is kept, not replaced, so a re-run can be compared with what it replaced.
import { and, eq, isNull } from "drizzle-orm";
import { sources, transcripts, type connectDb, type createStorage, type SourceTranscribeResult, type Transcriber } from "@workspace/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { extractSpeech } from "./media";
import { scratchDir } from "./scratch";

type Db = ReturnType<typeof connectDb>["db"];
type Storage = Pick<ReturnType<typeof createStorage>, "playback">;

export async function transcribe(db: Db, storage: Storage, transcriber: Transcriber, sourceId: string, signal: AbortSignal,
  extract = extractSpeech): Promise<SourceTranscribeResult> {
  const [source] = await db.select().from(sources).where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)));
  if (!source?.proxyKey) throw new Error("Source is missing or has no proxy to transcribe");
  const dir = await mkdtemp(join(scratchDir(), "dojo-transcribe-"));
  try {
    const speech = join(dir, "speech.m4a");
    const extracted = await extract(await storage.playback(source.proxyKey), speech, signal);
    const audio = await readFile(speech);
    const started = performance.now();
    const result = await transcriber.transcribe(audio, signal);
    const transcribeMs = Math.round(performance.now() - started);
    signal.throwIfAborted();
    await db.insert(transcripts).values({ sourceId, provider: result.provider, version: result.version, words: result.words });
    const summary: SourceTranscribeResult = { provider: result.provider, version: result.version, words: result.words.length,
      audioBytes: audio.length, extractMs: extracted.wallMs, transcribeMs };
    console.info("Transcription complete", sourceId, JSON.stringify(summary));
    return summary;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

