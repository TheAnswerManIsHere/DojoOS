import { eq, sql } from "drizzle-orm";
import { jobs } from "./schema";
import type { connectDb } from "./db";
import type { JobKind, JobPayloads } from "./contracts";

type Db = ReturnType<typeof connectDb>["db"];
export function jobLeaseMs() {
  const value = Number(process.env.JOB_LEASE_MS ?? "1800000");
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("JOB_LEASE_MS must be a positive timer-safe integer");
  return value;
}
export interface JobQueue {
  enqueue<K extends JobKind>(kind: K, payload: JobPayloads[K]): Promise<string>;
  claim(workerId: string): Promise<typeof jobs.$inferSelect | null>;
  complete(id: string, workerId: string, result: unknown): Promise<boolean>;
  fail(id: string, workerId: string, error: string): Promise<boolean>;
}
export function createQueue(db: Db): JobQueue {
  const leaseMs = jobLeaseMs();
  return {
    async enqueue(kind, payload) {
      const [job] = await db.insert(jobs).values({ kind, payload }).returning({ id: jobs.id });
      return job.id;
    },
    async claim(workerId) {
      return db.transaction(async (tx) => {
        await tx.update(jobs).set({ state: "failed", error: sql`coalesce(${jobs.error}, 'Job lease expired after 3 attempts')` })
          .where(sql`${jobs.deletedAt} is null and ${jobs.attempts} >= 3 and
            (${jobs.state} = 'queued' or (${jobs.state} = 'claimed' and ${jobs.claimedAt} <= now() - ${leaseMs} * interval '1 millisecond'))`);
        const [picked] = await tx.select().from(jobs)
          .where(sql`${jobs.id} = (select id from jobs where
            (state = 'queued' or (state = 'claimed' and claimed_at <= now() - ${leaseMs} * interval '1 millisecond'))
            and attempts < 3 and deleted_at is null order by created_at, id for update skip locked limit 1)`)
          .for("update", { skipLocked: true });
        if (!picked) return null;
        const [claimed] = await tx.update(jobs).set({ state: "claimed", claimedBy: workerId, claimedAt: new Date(), attempts: picked.attempts + 1,
          error: picked.state === "claimed" ? picked.error ?? "Job lease expired" : picked.error })
          .where(eq(jobs.id, picked.id)).returning();
        return claimed;
      });
    },
    async complete(id, workerId, result) {
      const [row] = await db.update(jobs).set({ state: "completed", result, error: null })
        .where(sql`${jobs.id} = ${id} and ${jobs.claimedBy} = ${workerId} and ${jobs.state} = 'claimed'`).returning({ id: jobs.id });
      return !!row;
    },
    async fail(id, workerId, error) {
      const [row] = await db.update(jobs).set({ state: "failed", error })
        .where(sql`${jobs.id} = ${id} and ${jobs.claimedBy} = ${workerId} and ${jobs.state} = 'claimed'`).returning({ id: jobs.id });
      return !!row;
    },
  };
}