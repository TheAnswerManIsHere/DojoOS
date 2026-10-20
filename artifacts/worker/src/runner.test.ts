import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobQueue, jobs } from "@workspace/shared";
import { DrainRunner } from "./runner";

type Job = typeof jobs.$inferSelect;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyQueue = (claim: JobQueue["claim"]): JobQueue => ({
  claim, enqueue: async () => "unused", complete: async () => true, fail: async () => true,
  // A queue that refuses renewal is one where the claim was lost; tests that need a held claim override it.
  renew: async () => null,
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
  const queue = emptyQueue(async (owner) => {
    claims++;
    return claims === 1 ? { id: "held", claimedBy: owner, claimedAt: new Date() } as Job : null;
  });
  // Renewal cannot reach the database, so the lease expiry it would have moved still stands.
  queue.renew = async () => { throw new Error("database unreachable"); };
  const runner = new DrainRunner(queue, 1, 30, async (_job, signal) => {
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

test("a job that outlives its lease keeps it by renewing, and completes once with no expiry claim", async () => {
  let claims = 0, completed = 0, aborted = false, renewals = 0;
  const queue = emptyQueue(async (owner) => {
    claims++;
    return claims === 1 ? { id: "long", claimedBy: owner, claimedAt: new Date() } as Job : null;
  });
  queue.renew = async () => { renewals++; return new Date(); };
  queue.complete = async () => { completed++; return true; };
  const runner = new DrainRunner(queue, 1, 30, async (_job, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await wait(150); // five leases long
  });
  try {
    runner.drain();
    await wait(220);
    assert.equal(aborted, false);
    assert.equal(completed, 1);
    assert.ok(renewals >= 3, `renewed while running (${renewals})`);
    // The initial claim and the completion's continuation drain; no lease-expiry attempt.
    assert.equal(claims, 2);
  } finally { await runner.stop(); }
});

test("a job whose renewal is refused is aborted and not completed", async () => {
  let completed = 0, aborted = false;
  const queue = emptyQueue(async (owner) => ({ id: "lost", claimedBy: owner, claimedAt: new Date() } as Job));
  queue.complete = async () => { completed++; return true; };
  let first = true;
  queue.claim = async (owner) => { if (!first) return null; first = false; return { id: "lost", claimedBy: owner, claimedAt: new Date() } as Job; };
  const runner = new DrainRunner(queue, 1, 300, async (_job, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  });
  try {
    runner.drain();
    await wait(200); // renewal at 100 ms is refused, well before the 300 ms expiry
    assert.equal(aborted, true);
    assert.equal(completed, 0);
  } finally { await runner.stop(); }
});

test("a renewal that lands after its job settled does not re-arm a lease timer or cause a claim", async () => {
  let claims = 0;
  let release!: (at: Date) => void;
  const queue = emptyQueue(async (owner) => {
    claims++;
    return claims === 1 ? { id: "late", claimedBy: owner, claimedAt: new Date() } as Job : null;
  });
  queue.renew = () => new Promise<Date>((resolve) => { release = resolve; });
  const runner = new DrainRunner(queue, 1, 60, async () => { await wait(30); }); // renewal starts at 20 ms, job settles at 30
  try {
    runner.drain();
    await wait(60);
    const settledClaims = claims; // the first claim and the completion's continuation drain
    release(new Date()); // the renewal answers after settlement
    await wait(150); // well past a 60 ms lease the late answer would have armed
    assert.equal(claims, settledClaims);
  } finally { await runner.stop(); }
});
