// The paired transcription pilot's scoring (issue #1, David's ruling of 2026-10-22): the same audio through each
// provider configuration, scored on what Jared's editing needs — his terms heard, nothing invented, fillers present and
// timed, the wake phrase found with its time, and word edges an editor can cut at without clipping speech.
//
// There is no hand-made reference transcript, so two of the measures are relative. A term or wake-phrase occurrence
// is a cluster of hits within a second and a half across configurations; a cluster every provider heard is taken as
// spoken, and one only some providers heard is listed for a person to adjudicate. Word edges are judged against the audio itself: where the speech energy around an edge actually starts
// or stops, read from the decoded samples.
import type { TimedWord } from "@workspace/shared";

export type Run = { config: string; provider: string; words: TimedWord[] };
export type Hit = { config: string; start_ms: number; end_ms: number; heard: string };
export type Cluster = { start_ms: number; hits: Hit[] };

type Token = { token: string; word: number };

/** Lower-cased word tokens with punctuation dropped; a hyphenated or slashed word becomes its parts, each pointing at
 * the word it came from, so "punch-in" and "punch in" read alike. */
export function tokens(words: TimedWord[]): Token[] {
  return words.flatMap((w, word) => normalise(w.text).map((token) => ({ token, word })));
}

export function normalise(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, "'").split(/[\s\-/]+/)
    .map((t) => t.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "").replace(/'s$/, "")).filter(Boolean);
}

const same = (heard: string, term: string) => heard === term || heard === `${term}s` || heard === `${term}es`;

/** Every place the phrase's tokens occur in order, plurals allowed, with the run's times for the span. A phrase of
 * several tokens also matches them written as one word, so "under-hook" finds "underhook" (the pilot's six misses on
 * 2026-10-23 were that spelling, not a mishearing). */
export function find(run: Run, phrase: string): Hit[] {
  const want = normalise(phrase), stream = tokens(run.words), hits: Hit[] = [];
  if (!want.length) return hits;
  const joined = want.join("");
  for (let i = 0; i < stream.length; i++) {
    if (want.length > 1 && same(stream[i].token, joined)) {
      const w = run.words[stream[i].word];
      hits.push({ config: run.config, start_ms: w.start_ms, end_ms: w.end_ms, heard: w.text });
      continue;
    }
    if (i + want.length > stream.length || !want.every((t, k) => same(stream[i + k].token, t))) continue;
    const first = run.words[stream[i].word], last = run.words[stream[i + want.length - 1].word];
    hits.push({ config: run.config, start_ms: first.start_ms, end_ms: last.end_ms,
      heard: run.words.slice(stream[i].word, stream[i + want.length - 1].word + 1).map((w) => w.text).join(" ") });
    i += want.length - 1;
  }
  return hits;
}

/** Hits from every configuration grouped by time: a hit within toleranceMs of a cluster's first hit joins it. */
export function cluster(hits: Hit[], toleranceMs = 1500): Cluster[] {
  const clusters: Cluster[] = [];
  for (const hit of [...hits].sort((a, b) => a.start_ms - b.start_ms)) {
    const last = clusters.at(-1);
    if (last && hit.start_ms - last.start_ms <= toleranceMs && !last.hits.some((h) => h.config === hit.config)) last.hits.push(hit);
    else clusters.push({ start_ms: hit.start_ms, hits: [hit] });
  }
  return clusters;
}

export type PhraseScore = { config: string; found: number; agreed: number; recall: number | null; disputed: number; alone: number };

/** Agreement is counted by provider, not by configuration, so the provider with more configurations in a run cannot set
 * the reference by itself (the build report on #30): a cluster every provider heard, through any of its configurations,
 * is agreed; one only some providers heard is disputed, left for a person to adjudicate from review.txt. Per
 * configuration: occurrences found, the agreed ones among them and the recall that makes, the disputed ones it heard,
 * and the ones no other configuration heard at all (its likeliest insertions). */
export function scorePhrase(runs: Run[], phrase: string): { clusters: Cluster[]; agreed: number; disputed: number; scores: PhraseScore[] } {
  const clusters = cluster(runs.flatMap((r) => find(r, phrase)));
  const providers = new Set(runs.map((r) => r.provider));
  const providerOf = new Map(runs.map((r) => [r.config, r.provider]));
  const heardBy = (c: Cluster) => new Set(c.hits.map((h) => providerOf.get(h.config)));
  const agreedClusters = clusters.filter((c) => heardBy(c).size === providers.size);
  const disputedClusters = clusters.filter((c) => heardBy(c).size < providers.size);
  const has = (c: Cluster, config: string) => c.hits.some((h) => h.config === config);
  return {
    clusters, agreed: agreedClusters.length, disputed: disputedClusters.length,
    scores: runs.map(({ config }) => ({
      config,
      found: clusters.filter((c) => has(c, config)).length,
      agreed: agreedClusters.filter((c) => has(c, config)).length,
      recall: agreedClusters.length ? agreedClusters.filter((c) => has(c, config)).length / agreedClusters.length : null,
      disputed: disputedClusters.filter((c) => has(c, config)).length,
      alone: clusters.filter((c) => c.hits.length === 1 && c.hits[0].config === config).length,
    })),
  };
}

export const fillers = new Set(["um", "uh", "umm", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm"]);

/** Fillers a configuration kept, and how many carry a real duration (at least 30 ms) an editor could cut by. */
export function scoreFillers(run: Run) {
  const kept = run.words.filter((w) => normalise(w.text).some((t) => fillers.has(t)));
  const timed = kept.filter((w) => w.end_ms - w.start_ms >= 30);
  const durations = timed.map((w) => w.end_ms - w.start_ms).sort((a, b) => a - b);
  return { config: run.config, fillers: kept.length, timed: timed.length, medianMs: durations.length ? durations[durations.length >> 1] : null };
}

// Word edges against the audio. Frame energy in dB is read every 5 ms over a 10 ms window of 16 kHz mono samples; the
// file's noise floor is its tenth-percentile frame. An edge is judged only where an editor would cut, beside a pause of
// at least 200 ms, so the next word's speech cannot be mistaken for this one's. Inside the span from the word's own
// other edge to the middle of the pause, the true edge is where the energy last (or first) rises above halfway, in dB,
// between the noise floor and the word's loudest frame. "Into speech" is how far the timestamp sits inside the speech
// — a cut there would clip it — and a cut more than 20 ms inside counts as clipped.
export const hopMs = 5;
const sampleRate = 16000, windowSamples = 160, hopSamples = 80;

export function frameDb(samples: Int16Array): Float32Array {
  const frames = Math.max(0, Math.floor((samples.length - windowSamples) / hopSamples) + 1);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hopSamples, end = i + windowSamples; i < end; i++) sum += samples[i] * samples[i];
    out[f] = 10 * Math.log10(sum / windowSamples / 32768 ** 2 + 1e-12);
  }
  return out;
}

export function noiseFloor(db: Float32Array): number {
  const sorted = Float32Array.from(db).sort();
  return sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : -120;
}

export type EdgeScore = { config: string; edges: number; clipped: number; medianAbsMs: number | null; p90IntoMs: number | null };

export function scoreEdges(run: Run, db: Float32Array, floor: number, minPauseMs = 200, clipMs = 20): EdgeScore {
  const frame = (ms: number) => Math.max(0, Math.min(db.length - 1, Math.round(ms / hopMs)));
  const into: number[] = [];
  const words = run.words;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end_ms <= w.start_ms) continue;
    let peak = -Infinity;
    for (let f = frame(w.start_ms); f <= frame(w.end_ms); f++) peak = Math.max(peak, db[f]);
    if (peak - floor < 12) continue;
    const threshold = floor + (peak - floor) / 2;
    const next = words[i + 1], prev = words[i - 1];
    if (!next || next.start_ms - w.end_ms >= minPauseMs) {
      const limit = next ? (w.end_ms + next.start_ms) / 2 : w.end_ms + minPauseMs / 2;
      let last = -1;
      for (let f = frame(w.start_ms); f <= frame(limit); f++) if (db[f] > threshold) last = f;
      if (last >= 0) into.push(last * hopMs + 10 - w.end_ms);
    }
    if (!prev || w.start_ms - prev.end_ms >= minPauseMs) {
      const limit = prev ? (prev.end_ms + w.start_ms) / 2 : Math.max(0, w.start_ms - minPauseMs / 2);
      let first = -1;
      for (let f = frame(limit); f <= frame(w.end_ms); f++) if (db[f] > threshold) { first = f; break; }
      if (first >= 0) into.push(w.start_ms - first * hopMs);
    }
  }
  const abs = into.map(Math.abs).sort((a, b) => a - b), sorted = [...into].sort((a, b) => a - b);
  return {
    config: run.config, edges: into.length, clipped: into.filter((ms) => ms > clipMs).length,
    medianAbsMs: abs.length ? abs[abs.length >> 1] : null,
    p90IntoMs: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : null,
  };
}

/** A 16-bit mono WAV of the samples between two times, so a person can hear what a cut at those edges sounds like. */
export function wav(samples: Int16Array, startMs: number, endMs: number): Buffer {
  const from = Math.max(0, Math.floor((startMs * sampleRate) / 1000)), to = Math.min(samples.length, Math.ceil((endMs * sampleRate) / 1000));
  const data = Buffer.from(samples.slice(from, Math.max(from, to)).buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
