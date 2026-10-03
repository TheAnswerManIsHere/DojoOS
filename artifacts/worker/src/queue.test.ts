import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { connectDb, createQueue, jobs } from "@workspace/shared";

test("expired claims reach attempt three, then fail while retaining the last error", async () => {
  const { db, pool } = connectDb();
  const rollback = new Error("test rollback");
  const previousLease = process.env.JOB_LEASE_MS;
  process.env.JOB_LEASE_MS = "1000";
  try {
    await assert.rejects(db.transaction(async (tx) => {
      const queue = createQueue(tx as unknown as typeof db);
      const [row] = await tx.insert(jobs).values({
        kind: "source.probe", payload: {}, state: "claimed", attempts: 2,
        claimedAt: new Date(Date.now() - 2000), claimedBy: "old-owner", error: "last recorded error",
      }).returning();
      const claimed = await queue.claim("new-owner");
      assert.equal(claimed?.id, row.id);
      assert.equal(claimed?.attempts, 3);
      await tx.update(jobs).set({ claimedAt: new Date(Date.now() - 2000) }).where(eq(jobs.id, row.id));
      assert.equal(await queue.claim("later-owner"), null);
      const [failed] = await tx.select().from(jobs).where(eq(jobs.id, row.id));
      assert.equal(failed.state, "failed");
      assert.equal(failed.attempts, 3);
      assert.equal(failed.error, "last recorded error");
      assert.equal(await queue.complete(row.id, "new-owner", {}), false);
      throw rollback;
    }), (error: unknown) => error === rollback);
  } finally {
    if (previousLease === undefined) delete process.env.JOB_LEASE_MS;
    else process.env.JOB_LEASE_MS = previousLease;
    await pool.end();
  }
});