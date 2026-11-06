// The lesson's command set (PLAN_LESSON_TIMELINE.md §3): add, remove, move, trim and set a transition on the entries of
// one lesson cut, each returning the command that reverses it (architecture.md §5). An entry is a `cut_bricks` row: it
// points at a brick and carries this cut's overrides — the trim, as deltas from the brick's own span, and the
// transition after it — so no edit here ever changes a brick. A dissolve must fit: every edit that would leave one
// longer than a neighbour, or two overlapping inside one entry, is refused and the lesson stays as it was.
import { CommandError } from "./commands";

export const transitions = ["cut", "dissolve"] as const;
export type Transition = (typeof transitions)[number];
/** A new dissolve's length; each join keeps its own (David, 2026-11-06: "a way to change how long a dissolve lasts"). */
export const dissolveMs = 1000;
/** The shortest and longest dissolve a join may ask for: two frames at 30 fps, and ten seconds. */
export const minDissolveMs = 67, maxDissolveMs = 10_000;
/** An entry's dissolve length, for one stored before lengths existed. */
export const dissolveOf = (e: { dissolveMs?: number }) => e.dissolveMs ?? dissolveMs;

/** A closed brick the lesson can include. */
export type LessonBrick = { id: string; sourceId: string; inMs: number; outMs: number; tags: string[]; number?: number | null;
  /** What the brick asks of the picture: keep it as shot, or punch in at a preset (the logger's action). */
  action?: "keep" | "punch_in"; preset?: string | null };
/** One entry of the lesson, in output order. trimInMs ≥ 0 moves the in point later; trimOutMs ≤ 0 moves the out point
 * earlier. The transition belongs to this entry and applies to whichever entry follows it. */
export type LessonEntry = { id: string; brickId: string; trimInMs: number; trimOutMs: number; transition: Transition; dissolveMs?: number };
export type LessonState = { entries: LessonEntry[]; bricks: LessonBrick[] };

export type LessonCommand =
  | { type: "add"; entry: LessonEntry; position: number }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; to: number }
  | { type: "trim"; id: string; edge: "in" | "out"; deltaMs: number }
  | { type: "setTransition"; id: string; transition: Transition }
  /** The join after an entry: cut, or a dissolve of a length (the one editor's Edited view, 2026-11-06). */
  | { type: "setJoin"; id: string; transition: Transition; dissolveMs: number };

const fail = (message: string): never => { throw new CommandError(message); };

/** The span an entry plays, in source time: its brick's span narrowed by the trim, never wider than the brick. */
export function entrySpan(entry: LessonEntry, brick: LessonBrick) {
  const inMs = Math.min(brick.outMs, Math.max(brick.inMs, brick.inMs + entry.trimInMs));
  const outMs = Math.max(brick.inMs, Math.min(brick.outMs, brick.outMs + entry.trimOutMs));
  return outMs > inMs ? { inMs, outMs } : { inMs: brick.inMs, outMs: brick.outMs };
}

/** The entries whose dissolves do not fit: a dissolve in or out longer than the entry, or the two together longer
 * than it (they would overlap inside it). The last entry's transition has no effect. */
export function misfits(state: LessonState): string[] {
  const brickOf = new Map(state.bricks.map((b) => [b.id, b]));
  const lengths = state.entries.map((e) => { const s = entrySpan(e, brickOf.get(e.brickId)!); return s.outMs - s.inMs; });
  const out = (i: number) => (i < state.entries.length - 1 && state.entries[i].transition === "dissolve" ? dissolveOf(state.entries[i]) : 0);
  return state.entries.filter((_, i) => (i > 0 ? out(i - 1) : 0) + out(i) > lengths[i]).map((e) => e.id);
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function applyLessonCommand(state: LessonState, command: LessonCommand): { state: LessonState; inverse: LessonCommand } {
  const brickOf = (id: string) => state.bricks.find((b) => b.id === id) ?? fail(`No brick ${id} in this shoot`);
  const index = (id: string) => { const i = state.entries.findIndex((e) => e.id === id); return i >= 0 ? i : fail(`No entry ${id} in the lesson`); };
  let next: LessonEntry[];
  let inverse: LessonCommand;
  switch (command.type) {
    case "add": {
      if (state.entries.some((e) => e.id === command.entry.id)) fail(`Entry ${command.entry.id} is already in the lesson`);
      brickOf(command.entry.brickId);
      const at = Math.max(0, Math.min(state.entries.length, command.position));
      next = [...state.entries.slice(0, at), command.entry, ...state.entries.slice(at)];
      inverse = { type: "remove", id: command.entry.id };
      break;
    }
    case "remove": {
      const i = index(command.id);
      next = state.entries.filter((_, j) => j !== i);
      inverse = { type: "add", entry: state.entries[i], position: i };
      break;
    }
    case "move": {
      const i = index(command.id);
      const to = Math.max(0, Math.min(state.entries.length - 1, command.to));
      if (to === i) fail(command.to < i ? "Already the first brick" : "Already the last brick");
      next = state.entries.filter((_, j) => j !== i);
      next.splice(to, 0, state.entries[i]);
      inverse = { type: "move", id: command.id, to: i };
      break;
    }
    case "trim": {
      const i = index(command.id);
      const entry = state.entries[i];
      const brick = brickOf(entry.brickId);
      const span = entrySpan(entry, brick);
      const delta = Math.round(command.deltaMs);
      // The edge moves within the brick's own span, and stops short of the other edge.
      const moved = command.edge === "in"
        ? Math.max(brick.inMs, Math.min(span.outMs - 1, span.inMs + delta)) - span.inMs
        : Math.min(brick.outMs, Math.max(span.inMs + 1, span.outMs + delta)) - span.outMs;
      if (moved === 0) fail(command.edge === "in" ? (delta < 0 ? "The in point is already at the brick's start" : "Nothing left to trim")
        : delta > 0 ? "The out point is already at the brick's end" : "Nothing left to trim");
      const trimmed = command.edge === "in" ? { ...entry, trimInMs: span.inMs + moved - brick.inMs }
        : { ...entry, trimOutMs: span.outMs + moved - brick.outMs };
      next = state.entries.map((e, j) => (j === i ? trimmed : e));
      inverse = { type: "trim", id: command.id, edge: command.edge, deltaMs: -moved };
      break;
    }
    case "setTransition": {
      const i = index(command.id);
      if (state.entries[i].transition === command.transition) fail(`Already a ${command.transition}`);
      next = state.entries.map((e, j) => (j === i ? { ...e, transition: command.transition } : e));
      inverse = { type: "setTransition", id: command.id, transition: state.entries[i].transition };
      break;
    }
    case "setJoin": {
      const i = index(command.id);
      const was = state.entries[i];
      const ms = Math.round(command.dissolveMs);
      if (ms < minDissolveMs || ms > maxDissolveMs) fail(`A dissolve is between ${secs(minDissolveMs)} and ${secs(maxDissolveMs)}`);
      if (was.transition === command.transition && dissolveOf(was) === ms) fail(command.transition === "cut" ? "Already a cut" : "The dissolve is already that long");
      next = state.entries.map((e, j) => (j === i ? { ...e, transition: command.transition, dissolveMs: ms } : e));
      inverse = { type: "setJoin", id: command.id, transition: was.transition, dissolveMs: dissolveOf(was) };
      break;
    }
  }
  const after = { ...state, entries: next };
  // A lesson already out of fit (a brick shortened in the logging viewer since) never blocks an edit that adds no misfit.
  const was = new Set(misfits(state));
  const fresh = misfits(after).filter((id) => !was.has(id));
  if (fresh.length) {
    const i = next.findIndex((e) => e.id === fresh[0]);
    const span = entrySpan(next[i], brickOf(next[i].brickId));
    if (command.type === "setJoin") {
      // Say how long a dissolve can be here: it may not outlast the brick before it or the one after, less their other dissolves.
      const j = index(command.id);
      const len = (k: number) => { const s = entrySpan(next[k], brickOf(next[k].brickId)); return s.outMs - s.inMs; };
      const into = j > 0 && next[j - 1].transition === "dissolve" ? dissolveOf(next[j - 1]) : 0;
      const after = j + 2 < next.length && next[j + 1].transition === "dissolve" ? dissolveOf(next[j + 1]) : 0;
      const longest = Math.max(0, Math.min(len(j) - into, j + 1 < next.length ? len(j + 1) - after : 0));
      fail(`A ${secs(command.dissolveMs)} dissolve doesn't fit here: the longest that fits is ${secs(longest)}.`);
    }
    fail(`A ${secs(dissolveOf(next[i]))} dissolve doesn't fit: brick ${i + 1} would be ${secs(span.outMs - span.inMs)} long with its dissolves. ` +
      "Make the dissolve next to it a cut (D), then try again.");
  }
  return { state: after, inverse };
}

export function isLessonCommand(value: unknown): value is LessonCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 64;
  const int = (v: unknown, max = 86_400_000) => Number.isSafeInteger(v) && Math.abs(v as number) <= max;
  const isEntry = (v: unknown) => {
    const e = v as Record<string, unknown> | null;
    return !!e && typeof e === "object" && str(e.id) && str(e.brickId) && int(e.trimInMs) && (e.trimInMs as number) >= 0
      && int(e.trimOutMs) && (e.trimOutMs as number) <= 0 && transitions.includes(e.transition as Transition)
      && (e.dissolveMs === undefined || int(e.dissolveMs, maxDissolveMs));
  };
  switch (c.type) {
    case "add": return isEntry(c.entry) && int(c.position, 100_000) && (c.position as number) >= 0;
    case "remove": return str(c.id);
    case "move": return str(c.id) && int(c.to, 100_000) && (c.to as number) >= 0;
    case "trim": return str(c.id) && (c.edge === "in" || c.edge === "out") && int(c.deltaMs) && c.deltaMs !== 0;
    case "setTransition": return str(c.id) && transitions.includes(c.transition as Transition);
    case "setJoin": return str(c.id) && transitions.includes(c.transition as Transition) && int(c.dissolveMs, maxDissolveMs);
    default: return false;
  }
}

/** The lesson's first membership (PLAN_LESSON_TIMELINE.md §3, D1): every closed brick, file by file in the order the
 * files were added, then by in point, ties broken by brick id. */
export function initialOrder<B extends LessonBrick>(bricks: B[], sourceOrder: string[]): B[] {
  const rank = new Map(sourceOrder.map((id, i) => [id, i]));
  return [...bricks].sort((a, b) => (rank.get(a.sourceId) ?? 1e9) - (rank.get(b.sourceId) ?? 1e9) || a.inMs - b.inMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The edit (the one editor's Edited view, David, 2026-11-06): every closed brick, file by file in the order the files
 * were added, each file's bricks in time order, joined, with the gaps between them gone. Where bricks overlap or nest,
 * their combined span plays once: a brick wholly inside what is already covered adds nothing, and one that runs past
 * it adds only the part past it (as a trim of its in point). Each join keeps the cut or dissolve it was given, by brick,
 * from `stored`; a new one is a cut. `newId` names an entry for a brick that has none yet. */
export function editEntries(bricks: LessonBrick[], sourceOrder: string[], stored: LessonEntry[], newId: () => string): LessonEntry[] {
  const kept = new Map(stored.map((e) => [e.brickId, e]));
  const rank = new Map(sourceOrder.map((id, i) => [id, i]));
  const ordered = [...bricks].sort((a, b) => (rank.get(a.sourceId) ?? 1e9) - (rank.get(b.sourceId) ?? 1e9) || a.inMs - b.inMs
    || (b.outMs - b.inMs) - (a.outMs - a.inMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: LessonEntry[] = [];
  let source = "", covered = -1;
  for (const b of ordered) {
    if (b.sourceId !== source) { source = b.sourceId; covered = -1; }
    if (b.outMs <= covered) continue;
    const trimInMs = Math.max(0, covered - b.inMs);
    covered = b.outMs;
    const was = kept.get(b.id);
    out.push({ id: was?.id ?? newId(), brickId: b.id, trimInMs, trimOutMs: 0, transition: was?.transition ?? "cut",
      ...(was?.dissolveMs !== undefined && { dissolveMs: was.dissolveMs }) });
  }
  return out;
}
