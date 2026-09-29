import { spawn } from "node:child_process";

const services = [
  ["web", ["--filter", "@workspace/web", "run", "serve"]],
  ["worker", ["--filter", "@workspace/worker", "run", "start"]],
];

let stopping = false;
let remaining = services.length;
let killTimer;
const children = services.map(([name, args]) => {
  const child = spawn("pnpm", args, { stdio: "inherit", detached: true });
  child.on("error", (error) => {
    console.error(`${name} failed to start:`, error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    remaining -= 1;
    if (!stopping) {
      console.error(`${name} exited unexpectedly (${signal ?? code}); stopping the deployment`);
      stop(1);
    }
    if (remaining === 0) clearTimeout(killTimer);
  });
  return child;
});

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) signalGroup(child, "SIGTERM");
  killTimer = setTimeout(() => {
    for (const child of children) signalGroup(child, "SIGKILL");
  }, 10_000);
  killTimer.unref();
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));