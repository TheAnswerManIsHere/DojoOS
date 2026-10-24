// Every edit is a command, and the command set is closed (architecture.md §5). `applyCommand` is the only path by which
// state changes, and each application returns the command that reverses it, so undo reverses one operation within the
// records it owns and nothing is ever replayed from a journal.
//
// The first members are the logging viewer's (PLAN_LOGGING_VIEWER.md §3): marking bricks on one source. A brick is
// open from I to O — `outMs` null — and an open brick keeps its place among the open ones (`openSeq`), so O always
// closes the innermost and undoing O puts it back.

export const actions = ["keep", "punch_in"] as const;
export type Action = (typeof actions)[number];
export const framingPresets = ["lower third", "centre", "upper third"] as const;

export type LogBrick = {
  id: string; inMs: number; outMs: number | null; openSeq: number | null;
  action: Action; preset: string | null; tags: string[];
};
export type SourceLog = { durationMs: number; bricks: LogBrick[] };

export type Command =
  | { type: "open"; id: string; atMs: number }
  | { type: "close"; atMs: number }
  | { type: "reopen"; id: string; openSeq: number }
  | { type: "nudge"; id: string; edge: "in" | "out"; deltaMs: number }
  | { type: "setAction"; id: string; action: Action; preset: string | null }
  | { type: "setTags"; id: string; tags: string[] }
  | { type: "delete"; id: string }
  | { type: "restore"; brick: LogBrick };

export class CommandError extends Error {}

const fail = (message: string): never => { throw new CommandError(message); };
const clamp = (ms: number, max: number) => Math.max(0, Math.min(max, Math.round(ms)));

/** The innermost open brick: the one opened last. */
export function innermostOpen(bricks: LogBrick[]): LogBrick | undefined {
  return bricks.filter((b) => b.outMs === null).sort((a, b) => (b.openSeq ?? 0) - (a.openSeq ?? 0))[0];
}

export function applyCommand(state: SourceLog, command: Command): { state: SourceLog; inverse: Command } {
  const find = (id: string) => state.bricks.find((b) => b.id === id) ?? fail(`No brick ${id}`);
  const replace = (brick: LogBrick) => ({ ...state, bricks: state.bricks.map((b) => (b.id === brick.id ? brick : b)) });
  switch (command.type) {
    case "open": {
      if (state.bricks.some((b) => b.id === command.id)) fail(`Brick ${command.id} already exists`);
      const openSeq = Math.max(0, ...state.bricks.map((b) => b.openSeq ?? 0)) + 1;
      const brick: LogBrick = { id: command.id, inMs: clamp(command.atMs, state.durationMs), outMs: null, openSeq,
        action: "keep", preset: null, tags: [] };
      return { state: { ...state, bricks: [...state.bricks, brick] }, inverse: { type: "delete", id: command.id } };
    }
    case "close": {
      const open = innermostOpen(state.bricks) ?? fail("No open brick to close");
      const outMs = clamp(command.atMs, state.durationMs);
      if (outMs <= open.inMs) fail("The out point must come after the in point");
      return { state: replace({ ...open, outMs, openSeq: null }), inverse: { type: "reopen", id: open.id, openSeq: open.openSeq! } };
    }
    case "reopen": {
      const brick = find(command.id);
      if (brick.outMs === null) fail(`Brick ${command.id} is already open`);
      return { state: replace({ ...brick, outMs: null, openSeq: command.openSeq }), inverse: { type: "close", atMs: brick.outMs! } };
    }
    case "nudge": {
      const brick = find(command.id);
      if (command.edge === "out" && brick.outMs === null) fail("An open brick has no out point to nudge");
      const before = command.edge === "in" ? brick.inMs : brick.outMs!;
      const after = clamp(before + command.deltaMs, state.durationMs);
      const next = command.edge === "in" ? { ...brick, inMs: after } : { ...brick, outMs: after };
      if (next.outMs !== null && next.outMs <= next.inMs) fail("The out point must come after the in point");
      return { state: replace(next), inverse: { type: "nudge", id: brick.id, edge: command.edge, deltaMs: before - after } };
    }
    case "setAction": {
      const brick = find(command.id);
      if (!actions.includes(command.action)) fail(`Unknown action ${command.action}`);
      const preset = command.action === "punch_in" ? command.preset ?? framingPresets[0] : null;
      return { state: replace({ ...brick, action: command.action, preset }),
        inverse: { type: "setAction", id: brick.id, action: brick.action, preset: brick.preset } };
    }
    case "setTags": {
      const brick = find(command.id);
      const tags = [...new Set(command.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
      return { state: replace({ ...brick, tags }), inverse: { type: "setTags", id: brick.id, tags: brick.tags } };
    }
    case "delete": {
      const brick = find(command.id);
      return { state: { ...state, bricks: state.bricks.filter((b) => b.id !== brick.id) }, inverse: { type: "restore", brick } };
    }
    case "restore": {
      if (state.bricks.some((b) => b.id === command.brick.id)) fail(`Brick ${command.brick.id} already exists`);
      return { state: { ...state, bricks: [...state.bricks, command.brick] }, inverse: { type: "delete", id: command.brick.id } };
    }
    default:
      return fail(`Unknown command ${(command as { type: string }).type}`);
  }
}

/** Is this a command of the closed set, well formed? The route checks before applying anything a client sent. */
export function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 64;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  switch (c.type) {
    case "open": return str(c.id) && num(c.atMs);
    case "close": return num(c.atMs);
    case "reopen": return str(c.id) && num(c.openSeq);
    case "nudge": return str(c.id) && (c.edge === "in" || c.edge === "out") && num(c.deltaMs);
    case "setAction": return str(c.id) && actions.includes(c.action as Action) && (c.preset === null || typeof c.preset === "string");
    case "setTags": return str(c.id) && Array.isArray(c.tags) && c.tags.length <= 20 && c.tags.every((t) => typeof t === "string" && t.length <= 40);
    case "delete": return str(c.id);
    case "restore": {
      const b = c.brick as Record<string, unknown> | undefined;
      return !!b && str(b.id) && num(b.inMs) && (b.outMs === null || num(b.outMs)) && (b.openSeq === null || num(b.openSeq)) &&
        actions.includes(b.action as Action) && Array.isArray(b.tags);
    }
    default: return false;
  }
}

type Word = { start_ms: number; end_ms: number };

/** I snaps to the nearest word start, O to the nearest word end, within `withinMs`; with no word that close, or no
 * transcript at all, the raw playhead stands. */
export function snapToWord(words: Word[] | null, atMs: number, edge: "in" | "out", withinMs = 1000): number {
  let best = atMs, bestGap = withinMs + 1;
  for (const w of words ?? []) {
    const at = edge === "in" ? w.start_ms : w.end_ms;
    const gap = Math.abs(at - atMs);
    if (gap < bestGap) { best = at; bestGap = gap; }
  }
  return Math.round(bestGap <= withinMs ? best : atMs);
}

/** Preview the keep: the chronological union of the closed bricks — overlapping material once, gaps skipped (David,
 * 2026-10-24). Open bricks are excluded until they are closed. */
export function keepSpans(bricks: LogBrick[]): Array<{ inMs: number; outMs: number }> {
  const closed = bricks.filter((b): b is LogBrick & { outMs: number } => b.outMs !== null).map((b) => ({ inMs: b.inMs, outMs: b.outMs }))
    .sort((a, b) => a.inMs - b.inMs);
  const spans: Array<{ inMs: number; outMs: number }> = [];
  for (const span of closed) {
    const last = spans.at(-1);
    if (last && span.inMs <= last.outMs) last.outMs = Math.max(last.outMs, span.outMs);
    else spans.push({ ...span });
  }
  return spans;
}
