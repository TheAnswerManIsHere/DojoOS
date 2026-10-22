// The AssemblyAI client against a fake of its v2 API: what is sent, how polling ends, and how a failure reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assemblyAI, createTranscriber } from "@workspace/shared";

const signal = new AbortController().signal;
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fake(statuses: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", headers, body: init.body });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/upload")) return json({ upload_url: "https://cdn.assemblyai.com/upload/abc" });
    if (url.endsWith("/transcript")) return json({ id: "t1" });
    return json(statuses.shift());
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("uploads the bytes, submits with the model and the usable keyterms, polls to completion and keeps word times in ms", async () => {
  const { calls, fetch } = fake([{ status: "queued" }, { status: "processing" },
    { status: "completed", text: "Psoas release.", speech_model_used: "universal-3-5-pro",
      words: [{ text: "Psoas", start: 120, end: 610, confidence: 0.9 }, { text: "release.", start: 640, end: 1100, confidence: 0.98 }] }]);
  const audio = new Uint8Array([1, 2, 3]);
  const result = await assemblyAI({ apiKey: "key", keyterms: [" psoas ", "", "one two three four five six seven"], fetch, pollMs: 1 })
    .transcribe(audio, signal);
  assert.deepEqual(result, { provider: "assemblyai", version: "universal-3-5-pro", text: "Psoas release.",
    words: [{ text: "Psoas", start_ms: 120, end_ms: 610 }, { text: "release.", start_ms: 640, end_ms: 1100 }] });
  assert.equal(calls[0].url, "https://api.assemblyai.com/v2/upload");
  assert.equal(calls[0].body, audio);
  assert.ok(calls.every((c) => c.headers.authorization === "key"), "every call carries the key");
  assert.deepEqual(JSON.parse(calls[1].body as string), { audio_url: "https://cdn.assemblyai.com/upload/abc",
    speech_models: ["universal-3-5-pro"], keyterms_prompt: ["psoas"] }, "an empty term and one over six words are dropped");
  assert.equal(calls.filter((c) => c.url.endsWith("/transcript/t1")).length, 3, "polled until completed");
});

test("no keyterms means no keyterms_prompt field", async () => {
  const { calls, fetch } = fake([{ status: "completed", words: [], text: "" }]);
  await assemblyAI({ apiKey: "key", fetch, pollMs: 1 }).transcribe(new Uint8Array(), signal);
  assert.equal("keyterms_prompt" in JSON.parse(calls[1].body as string), false);
});

test("a provider failure rejects with the provider's own reason", async () => {
  const { fetch } = fake([{ status: "error", error: "Audio duration is too short." }]);
  await assert.rejects(assemblyAI({ apiKey: "key", fetch, pollMs: 1 }).transcribe(new Uint8Array(), signal),
    /AssemblyAI could not transcribe: Audio duration is too short\./);
});

test("an HTTP refusal names the call and the status", async () => {
  const fetch = (async () => new Response("Invalid API key", { status: 401 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(assemblyAI({ apiKey: "bad", fetch }).transcribe(new Uint8Array(), signal), /POST \/upload answered 401: Invalid API key/);
});

test("transcription is off without a key, on with one", () => {
  assert.equal(createTranscriber({}), null);
  assert.equal(createTranscriber({ ASSEMBLYAI_API_KEY: "  " }), null);
  assert.equal(createTranscriber({ ASSEMBLYAI_API_KEY: "k" })?.provider, "assemblyai");
});
