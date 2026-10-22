// Transcription (architecture.md §4): a hosted provider called from the worker behind one interface. The provider is
// AssemblyAI (chosen in the build, 2026-10-22: word timings in milliseconds, keyterm prompting for Jared's anatomy
// vocabulary, the lowest published async rate of the providers that time every word). The interface is what the
// worker sees, so a second provider is one more implementation of it.

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
export function assemblyAI({ apiKey, keyterms = [], fetch: fetcher = fetch, pollMs = 5000 }:
  { apiKey: string; keyterms?: string[]; fetch?: Fetch; pollMs?: number }): Transcriber {
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
        body: JSON.stringify({ audio_url: upload_url, speech_models: [model], ...(terms.length && { keyterms_prompt: terms }) }),
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

/** The configured transcriber, or null when no key is set: with none, sources still ingest and play, and the worker
 * transcribes them once a key appears (the startup backfill). TRANSCRIPTION_KEYTERMS is a comma-separated list of
 * the vocabulary to favour. */
export function createTranscriber(env: NodeJS.ProcessEnv = process.env): Transcriber | null {
  const apiKey = env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) return null;
  return assemblyAI({ apiKey, keyterms: (env.TRANSCRIPTION_KEYTERMS ?? "").split(",") });
}
