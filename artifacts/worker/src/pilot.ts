// The paired transcription pilot (issue #1, David's ruling of 2026-10-22), run by hand in the Repl:
//   pnpm --filter @workspace/worker exec tsx src/pilot.ts
// Each chosen source's speech track is read out of its proxy (never the original: the download cap) and sent to every
// configuration once; each answer is kept under PILOT_OUT, outside the repository, so scoring again costs nothing.
// What it prints is counts only: a summary per configuration across every source, and a per-term table; report.json
// keeps the per-source detail too. The adjudication file (review.txt) and the rendered cuts quote Jared's
// words, so they stay in PILOT_OUT and are never committed.
//
//   PILOT_SOURCES   comma-separated source ids; default every ready source with a proxy
//   PILOT_TERMS     a file of terms, one a line; default TRANSCRIPTION_KEYTERMS
//   PILOT_WAKE      the wake phrase; default "editor punch in now"
//   PILOT_CONFIGS   comma-separated; default every configuration below but assemblyai-plain
//   PILOT_MAX_USD   refuse when the calls not yet made would cost more; default 5, the per-run cap
//   PILOT_SCORE_ONLY=1  make no paid call; score what is kept
//   PILOT_OUT       default <tmpdir>/dojo-pilot
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { assemblyAI, connectDb, createStorage, elevenLabs, sources, type Transcriber, type Transcription } from "@workspace/shared";
import { extractSpeech } from "./media";
import { find, frameDb, noiseFloor, scoreEdges, scoreFillers, scorePhrase, wav, type EdgeScore, type PhraseScore, type Run } from "./pilot-score";

const env = process.env;
const out = env.PILOT_OUT || join(tmpdir(), "dojo-pilot");
const terms = env.PILOT_TERMS ? (await readFile(env.PILOT_TERMS, "utf8")).split("\n") : (env.TRANSCRIPTION_KEYTERMS ?? "").split(",");
const termList = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
const wake = env.PILOT_WAKE || "editor punch in now";
const need = (name: string) => { const v = env[name]?.trim(); if (!v) throw new Error(`${name} is not set`); return v; };

// Dollars an audio hour, from the rates decisions.md records (read 2026-10-22): AssemblyAI $0.21, keyterms +$0.05;
// Scribe v2 and v2 Medical $0.22, keyterms +20%.
const configs: Record<string, { usdPerHour: number; make: () => Transcriber }> = {
  "assemblyai-plain": { usdPerHour: 0.21, make: () => assemblyAI({ apiKey: need("ASSEMBLYAI_API_KEY") }) },
  "assemblyai": { usdPerHour: 0.21, make: () => assemblyAI({ apiKey: need("ASSEMBLYAI_API_KEY"), disfluencies: true }) },
  "assemblyai+terms": { usdPerHour: 0.26, make: () => assemblyAI({ apiKey: need("ASSEMBLYAI_API_KEY"), disfluencies: true, keyterms: termList }) },
  "scribe_v2": { usdPerHour: 0.22, make: () => elevenLabs({ apiKey: need("ELEVENLABS_API_KEY") }) },
  "scribe_v2+terms": { usdPerHour: 0.264, make: () => elevenLabs({ apiKey: need("ELEVENLABS_API_KEY"), keyterms: termList }) },
  "scribe_v2_medical": { usdPerHour: 0.22, make: () => elevenLabs({ apiKey: need("ELEVENLABS_API_KEY"), model: "scribe_v2_medical" }) },
  "scribe_v2_medical+terms": { usdPerHour: 0.264,
    make: () => elevenLabs({ apiKey: need("ELEVENLABS_API_KEY"), model: "scribe_v2_medical", keyterms: termList }) },
};
const chosen = env.PILOT_CONFIGS ? env.PILOT_CONFIGS.split(",").map((c) => c.trim()) : Object.keys(configs).filter((c) => c !== "assemblyai-plain");
for (const c of chosen) if (!configs[c]) throw new Error(`Unknown configuration ${c}; known: ${Object.keys(configs).join(", ")}`);
if (chosen.some((c) => c.endsWith("+terms")) && !termList.length) throw new Error("A +terms configuration needs PILOT_TERMS or TRANSCRIPTION_KEYTERMS");

function decode(file: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      const bytes = Buffer.concat(chunks);
      resolve(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1));
    });
  });
}

const { db, pool } = connectDb();
const storage = createStorage();
const ids = env.PILOT_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean);
const chosenSources = await db.select({ id: sources.id, proxyKey: sources.proxyKey, durationMs: sources.durationMs }).from(sources)
  .where(and(isNull(sources.deletedAt), isNotNull(sources.proxyKey), eq(sources.ingestState, "ready"), ...(ids ? [inArray(sources.id, ids)] : [])));
await pool.end();
if (!chosenSources.length) throw new Error("No ready source with a proxy matches");

const pending = chosenSources.flatMap((s) => chosen.filter((c) => !existsSync(join(out, s.id, `${c}.json`))).map((c) => ({ s, c })));
const usd = pending.reduce((sum, { s, c }) => sum + ((s.durationMs ?? 0) / 3_600_000) * configs[c].usdPerHour, 0);
const maxUsd = Number(env.PILOT_MAX_USD ?? 5);
if (env.PILOT_SCORE_ONLY !== "1" && pending.length && usd > maxUsd) throw new Error(`The calls not yet made would cost about $${usd.toFixed(2)}, over PILOT_MAX_USD $${maxUsd}`);

const report: Record<string, unknown> = { at: new Date().toISOString(), sources: chosenSources.length,
  audioMinutes: +(chosenSources.reduce((m, s) => m + (s.durationMs ?? 0), 0) / 60000).toFixed(1), configs: chosen, terms: termList.length, wake };
const paid: Array<{ source: string; config: string; version: string; audioMinutes: number; usd: number; ms: number }> = [];
const failed: Array<{ source: string; config: string; error: string }> = [];
type PerSource = {
  source: string; minutes: number; noiseFloorDb: number; words: Record<string, number>;
  terms: Array<{ term: string; agreed: number; disputed: number; scores: PhraseScore[] }>;
  wake: { agreed: number; disputed: number; scores: PhraseScore[]; times: Record<string, number[]> };
  fillers: ReturnType<typeof scoreFillers>[]; edges: EdgeScore[];
};
const perSource: PerSource[] = [];
const review: string[] = [];

for (const source of chosenSources) {
  const dir = join(out, source.id);
  await mkdir(dir, { recursive: true });
  const speech = join(dir, "speech.m4a");
  if (!existsSync(speech)) await extractSpeech(await storage.playback(source.proxyKey!), speech, AbortSignal.timeout(30 * 60_000));
  const audio = await readFile(speech);
  const runs: Run[] = [];
  for (const config of chosen) {
    const file = join(dir, `${config}.json`);
    if (!existsSync(file)) {
      if (env.PILOT_SCORE_ONLY === "1") continue;
      const started = performance.now();
      try {
        const result: Transcription = await configs[config].make().transcribe(audio, AbortSignal.timeout(60 * 60_000));
        await writeFile(file, JSON.stringify(result));
        const minutes = (source.durationMs ?? 0) / 60000;
        paid.push({ source: source.id, config, version: result.version, audioMinutes: +minutes.toFixed(2),
          usd: +((minutes / 60) * configs[config].usdPerHour).toFixed(4), ms: Math.round(performance.now() - started) });
      } catch (error) {
        failed.push({ source: source.id, config, error: String(error).slice(0, 400) });
        continue;
      }
    }
    const result = JSON.parse(await readFile(file, "utf8")) as Transcription;
    runs.push({ config, provider: result.provider, words: result.words });
  }
  if (!runs.length) continue;

  const samples = await decode(speech);
  const energy = frameDb(samples), floor = noiseFloor(energy);
  const termScores = termList.map((term) => ({ term, ...scorePhrase(runs, term) }));
  const wakeScore = scorePhrase(runs, wake);
  perSource.push({
    source: source.id, minutes: +((source.durationMs ?? 0) / 60000).toFixed(1), noiseFloorDb: +floor.toFixed(1),
    words: Object.fromEntries(runs.map((r) => [r.config, r.words.length])),
    terms: termScores.map(({ term, agreed, disputed, scores }) => ({ term, agreed, disputed, scores })),
    wake: { agreed: wakeScore.agreed, disputed: wakeScore.disputed, scores: wakeScore.scores,
      times: Object.fromEntries(runs.map((r) => [r.config, find(r, wake).map((h) => h.start_ms)])) },
    fillers: runs.map(scoreFillers),
    edges: runs.map((r) => scoreEdges(r, energy, floor)),
  });

  // Adjudication: every term or wake-phrase cluster not every configuration reports, with what each one wrote there.
  for (const { term, clusters } of [...termScores, { term: wake, clusters: wakeScore.clusters }]) {
    for (const c of clusters.filter((c) => c.hits.length < runs.length)) {
      review.push(`\n${source.id} @ ${(c.start_ms / 1000).toFixed(1)}s  "${term}"  heard by ${c.hits.map((h) => h.config).join(", ")}`);
      for (const r of runs) review.push(`  ${r.config.padEnd(24)} ${r.words.filter((w) => w.end_ms >= c.start_ms - 1500 && w.start_ms <= c.start_ms + 2500).map((w) => w.text).join(" ")}`);
    }
  }
  // Rendered cuts: the first ten phrases between pauses of 300 ms or more, cut at each configuration's own edges.
  for (const r of runs) {
    const cuts = join(dir, "cuts", r.config);
    await mkdir(cuts, { recursive: true });
    let start = 0, written = 0;
    for (let i = 0; i < r.words.length && written < 10; i++) {
      const next = r.words[i + 1];
      if (next && next.start_ms - r.words[i].end_ms < 300) continue;
      const from = r.words[start].start_ms, to = r.words[i].end_ms;
      if (to - from >= 1000 && to - from <= 6000) await writeFile(join(cuts, `${String(++written).padStart(2, "0")}-${from}.wav`), wav(samples, from, to));
      start = i + 1;
    }
  }
}

// Across every source: what decides the pilot, per configuration, in one place.
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const summary = Object.fromEntries(chosen.map((config) => {
  const terms = perSource.flatMap((s) => s.terms.map((t) => t.scores.find((x) => x.config === config)!));
  const agreed = sum(perSource.flatMap((s) => s.terms.map((t) => t.agreed)));
  const wake = perSource.map((s) => s.wake.scores.find((x) => x.config === config)!);
  const fillers = perSource.map((s) => s.fillers.find((x) => x.config === config)!);
  const edges = perSource.map((s) => s.edges.find((x) => x.config === config)!);
  return [config, {
    words: sum(perSource.map((s) => s.words[config] ?? 0)),
    terms: { found: sum(terms.map((t) => t.found)), agreedHeard: sum(terms.map((t) => t.agreed)), agreedOf: agreed,
      recall: agreed ? +(sum(terms.map((t) => t.agreed)) / agreed).toFixed(3) : null,
      disputedHeard: sum(terms.map((t) => t.disputed)), alone: sum(terms.map((t) => t.alone)) },
    wake: { found: sum(wake.map((w) => w.found)), agreedHeard: sum(wake.map((w) => w.agreed)), alone: sum(wake.map((w) => w.alone)) },
    fillers: { kept: sum(fillers.map((f) => f.fillers)), timed: sum(fillers.map((f) => f.timed)) },
    edges: { judged: sum(edges.map((e) => e.edges)), clipped: sum(edges.map((e) => e.clipped)),
      medianAbsMsPerSource: edges.map((e) => e.medianAbsMs), p90IntoMsPerSource: edges.map((e) => e.p90IntoMs) },
  }];
}));
const termTable = (perSource[0]?.terms ?? []).map(({ term }) => {
  const rows = perSource.map((s) => s.terms.find((t) => t.term === term)!);
  return { term, agreed: sum(rows.map((r) => r.agreed)), disputed: sum(rows.map((r) => r.disputed)),
    found: Object.fromEntries(chosen.map((c) => [c, sum(rows.map((r) => r.scores.find((x) => x.config === c)!.found))])) };
});
Object.assign(report, { paid, paidUsd: +paid.reduce((s, p) => s + p.usd, 0).toFixed(4), failed, summary, termTable, perSource });
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
await writeFile(join(out, "review.txt"), review.join("\n"));
console.log(JSON.stringify({ at: report.at, sources: report.sources, audioMinutes: report.audioMinutes, paidUsd: report.paidUsd,
  failed, summary, termTable }));
console.log(`\nKept in ${out}: report.json, review.txt (quotes the audio; never commit), cuts/ per source and configuration.`);
