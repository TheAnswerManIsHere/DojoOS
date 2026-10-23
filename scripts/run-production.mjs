import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `--dev` is the development workspace's run command: the same supervision, with the web server's dev script, so the
// worker runs there too and an upload or import is ingested without anyone starting it by hand.
const dev = process.argv.includes("--dev");
// The workspace's /tmp is a 4 GB RAM disk (measured 2026-10-23), too small to stage a 3 GB original beside its proxy,
// so in development the worker stages under <repo>/tmp (gitignored) on the 256 GB workspace volume instead.
const env = { ...process.env };
if (dev) {
  env.TMPDIR = fileURLToPath(new URL("../tmp", import.meta.url));
  mkdirSync(env.TMPDIR, { recursive: true });
}
const services = [
  ["web", ["--filter", "@workspace/web", "run", dev ? "dev" : "serve"]],
  ["worker", ["--filter", "@workspace/worker", "run", "start"]],
];

let stopping = false;
let remaining = services.length;
let killTimer;
const children = services.map(([name, args]) => {
  const child = spawn("pnpm", args, { stdio: "inherit", detached: true, env });
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