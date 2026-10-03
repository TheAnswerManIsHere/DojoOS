export function workerNudgePort() {
  const port = Number(process.env.WORKER_NUDGE_PORT ?? "4711");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("WORKER_NUDGE_PORT must be a valid port");
  return port;
}

export async function nudgeWorker(port: number) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/nudge`, { method: "POST", signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`Worker returned ${response.status}`);
      return;
    } catch (error) {
      if (attempt === 3) console.error("Worker nudge failed after three retries", error);
      else await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}