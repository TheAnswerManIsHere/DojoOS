// An empty union has no members yet. Future members will discriminate on `type`.
export type Command = never;

export function applyCommand(_state: unknown, _command: Command): never {
  throw new Error("not implemented");
}