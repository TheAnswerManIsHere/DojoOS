import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobQueue, jobs } from "@workspace/shared";
import { DrainRunner } from "./runner";

type Job = typeof jobs.$inferSelect;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyQueue = (claim: JobQueue["claim"]): JobQueue => ({
  claim, enqueue: async () => "unused", complete: async () => true, fail: async () => true,
});

test("an empty startup drain stays idle and a nudge makes one new pass", async () => {
  let claims = 0;
  const runner = new DrainRunner(emptyQueue(async () => { claims++; return null; }), 2, 1000, async () => {});
  try {
    runner.drain();
    await wait(30);
    assert.equal(claims, 1);
    await wait(100);
    assert.equal(claims, 1);
    runner.drain();
    await wait(30);
    assert.equal(claims, 2);
  } finally { await runner.stop(); }
});

test("an observed lease creates exactly one expiry attempt, then no repeat", async () => {
  let claims = 0;
  const runner = new DrainRunner(emptyQueue(async () => { claims++; return null; }), 2, 30, async () => {});
  try {
    runner.watchLease("observed", new Date());
    await wait(90);
    assert.equal(claims, 1);
    await wait(60);
    assert.equal(claims, 1);
  } finally { await runner.stop(); }
});

test("draining jobs never exceeds the simultaneous-job bound", async () => {
  let issued = 0, running = 0, peak = 0, completed = 0;
  const queue = emptyQueue(async (owner) => {
    if (issued === 4) return null;
    return { id: String(++issued), claimedBy: owner, claimedAt: new Date() } as Job;
  });
  queue.complete = async () => { completed++; return true; };
  const runner = new DrainRunner(queue, 2, 1000, async () => {
    peak = Math.max(peak, ++running);
    await wait(25);
    running--;
  });
  try {
    runner.drain();
    await wait(180);
    assert.equal(completed, 4);
    assert.equal(peak, 2);
  } finally { await runner.stop(); }
});

test("held leases get one expiry attempt even when the execution slot is busy", async () => {
  let claims = 0, aborted = false;
  const runner = new DrainRunner(emptyQueue(async (owner) => {
    claims++;
    return claims === 1 ? { id: "held", claimedBy: owner, claimedAt: new Date() } as Job : null;
  }), 1, 30, async (_job, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  });
  try {
    runner.drain();
    await wait(100);
    assert.equal(aborted, true);
    // Initial claim plus exactly one lease-expiry attempt, with no extra continuation.
    assert.equal(claims, 2);
    await wait(50);
    assert.equal(claims, 2);
  } finally { await runner.stop(); }
});