import { connectDb, createQueue, createStorage } from "@workspace/shared";
export type Context = {
  db: ReturnType<typeof connectDb>["db"];
  queue: ReturnType<typeof createQueue>;
  storage: ReturnType<typeof createStorage>;
};