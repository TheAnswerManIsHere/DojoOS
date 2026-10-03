import { randomUUID } from "node:crypto";
import type { JobQueue, jobs } from "@workspace/shared";

type Job = typeof jobs.$inferSelect;
type Claimed = { job: Job; owner: string };
type Lease = { owner: string | null; timer: ReturnType<typeof setTimeout> };

/** All claims are event-driven. Job completion continues the current drain. */
export class DrainRunner {
  private active = new Map<string, { job: Job; controller: AbortController; done: Promise<void> }>();
  private pending: Claimed[] = [];
  private leases = new Map<string, Lease>();
  private claimLane: Promise<unknown> = Promise.resolve();
  private pumping = false;
  private requested = false;
  private stopped = false;

  constructor(
    private queue: JobQueue,
    private concurrency: number,
    private leaseMs: number,
    private execute: (job: Job, signal: AbortSignal) => Promise<unknown>,
  ) {}

  watchLease(id: string, claimedAt: Date, owner: string | null = null) {
    if (this.stopped) return;
    const old = this.leases.get(id);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.leases.delete(id);
      if (this.stopped) return;
      if (owner) {
        this.active.get(owner)?.controller.abort();
        this.pending = this.pending.filter((item) => item.owner !== owner);
      }
      // Exactly one attempt at this row's expiry, even if all slots are busy.
      void this.claimOne().then((item) => {
        if (item && !this.stopped) this.accept(item);
      }).catch((error) => console.error("Lease-expiry claim failed", error));
    }, Math.max(0, claimedAt.getTime() + this.leaseMs - Date.now()));
    this.leases.set(id, { owner, timer });
  }

  private claimOne(): Promise<Claimed | null> {
    const attempt = this.claimLane.then(async () => {
      if (this.stopped) return null;
      // Unique ownership per claim prevents a stale attempt completing a reclaimed job.
      const owner = randomUUID();
      console.info("Worker database claim attempt");
      const job = await this.queue.claim(owner);
      return job ? { job, owner } : null;
    });
    this.claimLane = attempt.catch(() => {});
    return attempt;
  }

  drain() {
    if (this.stopped) return;
    this.requested = true;
    if (!this.pumping) void this.pump();
  }

  private accept(item: Claimed) {
    if (this.stopped) return;
    this.pending.push(item);
    if (item.job.claimedAt) this.watchLease(item.job.id, item.job.claimedAt, item.owner);
    this.startPending();
  }

  private startPending() {
    while (!this.stopped && this.active.size < this.concurrency) {
      const index = this.pending.findIndex((item) => ![...this.active.values()].some((active) => active.job.id === item.job.id));
      if (index === -1) break;
      const [item] = this.pending.splice(index, 1);
      const controller = new AbortController();
      const done = Promise.resolve().then(async () => {
        try {
          const result = await this.execute(item.job, controller.signal);
          if (!controller.signal.aborted && !await this.queue.complete(item.job.id, item.owner, result)) {
            console.error("Lost job claim", item.job.id);
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Job failed", item.job.id, message);
            await this.queue.fail(item.job.id, item.owner, message);
          }
        }
      }).catch((error) => console.error("Job settlement failed", error)).finally(() => {
        const lease = this.leases.get(item.job.id);
        if (lease?.owner === item.owner) {
          clearTimeout(lease.timer);
          this.leases.delete(item.job.id);
        }
        this.active.delete(item.owner);
        this.startPending();
        // Lease expiry already scheduled its one claim; do not add a second attempt
        // merely because the expired execution has now acknowledged cancellation.
        if (!controller.signal.aborted) this.drain();
      });
      this.active.set(item.owner, { job: item.job, controller, done });
    }
  }

  private async pump() {
    this.pumping = true;
    try {
      while (!this.stopped && this.requested) {
        this.requested = false;
        this.startPending();
        while (!this.stopped && this.active.size + this.pending.length < this.concurrency) {
          const item = await this.claimOne();
          if (!item) {
            if (this.active.size === 0 && this.pending.length === 0) console.info(`Worker drain complete; idle (${this.leases.size} lease timers)`);
            break;
          }
          this.accept(item);
        }
      }
    } catch (error) {
      console.error("Worker drain failed; waiting for next nudge, lease expiry, or safety poll", error);
    } finally {
      this.pumping = false;
    }
  }

  async stop() {
    this.stopped = true;
    for (const lease of this.leases.values()) clearTimeout(lease.timer);
    this.leases.clear();
    for (const active of this.active.values()) active.controller.abort();
    await this.claimLane;
    await Promise.all([...this.active.values()].map((active) => active.done));
  }
}