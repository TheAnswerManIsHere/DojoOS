// Transcription (architecture.md §4): a hosted provider called from the worker behind one interface. The provider is
// AssemblyAI (chosen in the build, 2026-10-22: word timings in milliseconds, keyterm prompting for Jared's anatomy
// vocabulary, the lowest published async rate of the providers that time every word). The interface is what the
// worker sees, so a second provider is one more implementation of it: ElevenLabs Scribe is that second one, built for
// the paired pilot David ruled on 2026-10-22 (issue #1), which decides which of the two transcribes the backlog.

export type TimedWord = { text: string; start_ms: number; end_ms: number };
export type Transcription = { provider: string; version: string; words: TimedWord[]; text: string };

export interface Transcriber {
  readonly provider: string;
  /** Transcribes one audio file's bytes; rejects with the provider's own error text when it fails. */
  transcribe(audio: Uint8Array, signal: AbortSignal): Promise<Transcription>;
}

type Fetch = typeof fetch;
const api = "https://api.assemblyai.com/v2";
const model = "universal-3-5-pro";

/** Upload → submit → poll, per AssemblyAI's v2 API: `POST /upload` returns `upload_url`; `POST /transcript` takes
 * `audio_url`, `speech_models` and `keyterms_prompt` (up to 1,000 terms on Universal-3.5 Pro, six words each);
 * `GET /transcript/{id}` reports `status` ∈ queued | processing | completed | error, and `words` with `start`/`end` in
 * milliseconds. Polling is every five seconds, well inside its 60-a-minute limit. */
export function assemblyAI({ apiKey, keyterms = [], disfluencies = false, fetch: fetcher = fetch, pollMs = 5000 }:
  { apiKey: string; keyterms?: string[]; disfluencies?: boolean; fetch?: Fetch; pollMs?: number }): Transcriber {
  const terms = keyterms.map((t) => t.trim()).filter((t) => t && t.split(/\s+/).length <= 6).slice(0, 1000);
  async function call<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const response = await fetcher(`${api}${path}`, { ...init, signal, headers: { authorization: apiKey, ...init.headers } });
    const body = await response.text();
    if (!response.ok) throw new Error(`AssemblyAI ${init.method ?? "GET"} ${path} answered ${response.status}: ${body.slice(0, 500)}`);
    return JSON.parse(body) as T;
  }
  return {
    provider: "assemblyai",
    async transcribe(audio, signal) {
      const { upload_url } = await call<{ upload_url: string }>("/upload",
        { method: "POST", body: audio, headers: { "content-type": "application/octet-stream" } }, signal);
      const submitted = await call<{ id: string }>("/transcript", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_url: upload_url, speech_models: [model], ...(terms.length && { keyterms_prompt: terms }),
          ...(disfluencies && { disfluencies: true }) }),
      }, signal);
      for (;;) {
        const t = await call<{ status: string; error?: string | null; text?: string | null; speech_model_used?: string | null;
          words?: Array<{ text: string; start: number; end: number }> | null }>(`/transcript/${submitted.id}`, {}, signal);
        if (t.status === "error") throw new Error(`AssemblyAI could not transcribe: ${t.error ?? "no reason given"}`);
        if (t.status === "completed") return {
          provider: "assemblyai", version: t.speech_model_used ?? model, text: t.text ?? "",
          words: (t.words ?? []).map((w) => ({ text: w.text, start_ms: w.start, end_ms: w.end })),
        };
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, pollMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      }
    },
  };
}

export const scribeModels = ["scribe_v2", "scribe_v2_medical"] as const;
export type ScribeModel = (typeof scribeModels)[number];

/** One synchronous call, per ElevenLabs' speech-to-text reference (read 2026-10-22): `POST /v1/speech-to-text`,
 * multipart, `xi-api-key` header; `model_id` is `scribe_v2` or `scribe_v2_medical`; `keyterms` up to 1,000, each under
 * 50 characters and at most five words, none of `<>{}[]\`. Fillers are kept, since `no_verbatim` defaults to false.
 * `words` mixes `word`, `spacing` and `audio_event` entries with `start`/`end` in seconds; only words are kept. */
export function elevenLabs({ apiKey, model = "scribe_v2", keyterms = [], fetch: fetcher = fetch }:
  { apiKey: string; model?: ScribeModel; keyterms?: string[]; fetch?: Fetch }): Transcriber {
  const terms = keyterms.map((t) => t.trim())
    .filter((t) => t && t.length < 50 && t.split(/\s+/).length <= 5 && !/[<>{}[\]\\]/.test(t)).slice(0, 1000);
  return {
    provider: "elevenlabs",
    async transcribe(audio, signal) {
      const form = new FormData();
      form.append("model_id", model);
      form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/mp4" }), "speech.m4a");
      form.append("timestamps_granularity", "word");
      form.append("tag_audio_events", "false");
      for (const term of terms) form.append("keyterms", term);
      const response = await fetcher("https://api.elevenlabs.io/v1/speech-to-text",
        { method: "POST", body: form, signal, headers: { "xi-api-key": apiKey } });
      const body = await response.text();
      if (!response.ok) throw new Error(`ElevenLabs POST /v1/speech-to-text answered ${response.status}: ${body.slice(0, 500)}`);
      const t = JSON.parse(body) as { text?: string; words?: Array<{ text: string; type: string; start?: number | null; end?: number | null }> };
      return {
        provider: "elevenlabs", version: model, text: t.text ?? "",
        words: (t.words ?? []).filter((w) => w.type === "word" && w.start != null && w.end != null)
          .map((w) => ({ text: w.text, start_ms: Math.round(w.start! * 1000), end_ms: Math.round(w.end! * 1000) })),
      };
    },
  };
}

/** The configured transcriber, or null when no key is set: with none, sources still ingest and play, and the worker
 * transcribes them once a key appears (the startup backfill). TRANSCRIPTION_PROVIDER picks `assemblyai`, `scribe_v2`
 * or `scribe_v2_medical`; unset, it is AssemblyAI when its key is set, else Scribe v2 when ElevenLabs' is.
 * TRANSCRIPTION_KEYTERMS is a comma-separated list of the vocabulary to favour. */
export function createTranscriber(env: NodeJS.ProcessEnv = process.env): Transcriber | null {
  const keyterms = (env.TRANSCRIPTION_KEYTERMS ?? "").split(",");
  const assembly = env.ASSEMBLYAI_API_KEY?.trim(), eleven = env.ELEVENLABS_API_KEY?.trim();
  const chosen = env.TRANSCRIPTION_PROVIDER?.trim() || (assembly ? "assemblyai" : eleven ? "scribe_v2" : "");
  if (chosen === "assemblyai") return assembly ? assemblyAI({ apiKey: assembly, keyterms }) : null;
  if ((scribeModels as readonly string[]).includes(chosen)) return eleven ? elevenLabs({ apiKey: eleven, model: chosen as ScribeModel, keyterms }) : null;
  if (chosen) throw new Error(`TRANSCRIPTION_PROVIDER is ${chosen}; it must be assemblyai, ${scribeModels.join(" or ")}`);
  return null;
}
