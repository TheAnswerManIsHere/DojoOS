// How every player moves (David, 2026-10-29: "keep the navigation rules consistent any time we're on any player"): one
// definition, read by the logging viewer, the brick editor and the lesson page, so the keys can never drift apart.
// ← / → step to the previous or next word; where no word is within reach they move a second; Shift moves five
// seconds; Option moves one frame. J / K / L set the speed. Pure functions, no DOM.

export type Word = { start_ms: number; end_ms: number };

/** A word further away than this is not jumped to; the key moves `silenceStepMs` instead. */
export const wordReachMs = 5000;
export const silenceStepMs = 1000;
export const bigStepMs = 5000;
/** Pressed this soon after a word's start, ← goes to the word before rather than back to the start of this one, so
 * repeated presses during playback keep walking back instead of landing on the same word. */
const backTolerance = 250;

/** Where ← / → take the playhead from `atMs`: the next or previous word start, or a second when none is within reach.
 * Shift moves `bigStepMs`; Option moves one frame. The answer is clamped to [0, durationMs]. */
export function navigationTarget(words: Word[] | null, atMs: number, direction: -1 | 1,
  modifier: "none" | "shift" | "option", frameMs: number, durationMs: number): number {
  const clamp = (ms: number) => Math.max(0, Math.min(durationMs, ms));
  if (modifier === "shift") return clamp(atMs + direction * bigStepMs);
  if (modifier === "option") return clamp(atMs + direction * frameMs);
  let best: number | null = null;
  for (const w of words ?? []) {
    const at = w.start_ms;
    if (direction > 0 ? at > atMs + 1 && (best === null || at < best) : at < atMs - backTolerance && (best === null || at > best)) best = at;
  }
  if (best !== null && Math.abs(best - atMs) <= wordReachMs) return clamp(best);
  return clamp(atMs + direction * silenceStepMs);
}

/** The speeds J and L step through; K returns to 1×. Browsers cannot play video backwards, so J slows rather than reverses. */
export const playbackSpeeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
export function nextSpeed(current: number, action: "slower" | "normal" | "faster"): number {
  if (action === "normal") return 1;
  const i = playbackSpeeds.indexOf(current);
  const from = i < 0 ? playbackSpeeds.indexOf(1) : i;
  return playbackSpeeds[Math.max(0, Math.min(playbackSpeeds.length - 1, from + (action === "faster" ? 1 : -1)))];
}

/** The keys every player shares, by KeyboardEvent.code. A page's own keys are layered over these, never over them. */
export const playerKeys: Record<string, "playPause" | "back" | "forward" | "slower" | "normal" | "faster"> = {
  Space: "playPause", ArrowLeft: "back", ArrowRight: "forward", KeyJ: "slower", KeyK: "normal", KeyL: "faster",
};

/** Which modifier a key press carries, for navigationTarget. */
export const modifierOf = (e: { shiftKey: boolean; altKey: boolean }) => (e.altKey ? "option" : e.shiftKey ? "shift" : "none") as "none" | "shift" | "option";

/** A time code as minutes:seconds:frames — hours:minutes:seconds:frames past an hour — at the source's own frame
 * rate (David, 2026-10-29: "Decimal fractions of seconds are not useful"). Every player and every time a brick shows. */
export function timecode(ms: number, fps: number | null | undefined): string {
  const rate = Math.max(1, Math.round(fps || 30));
  const totalFrames = Math.round((Math.max(0, ms) / 1000) * rate);
  const frames = totalFrames % rate;
  const totalSeconds = Math.floor(totalFrames / rate);
  const s = totalSeconds % 60, m = Math.floor(totalSeconds / 60) % 60, h = Math.floor(totalSeconds / 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}:${two(frames)}` : `${m}:${two(s)}:${two(frames)}`;
}
