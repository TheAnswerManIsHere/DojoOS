import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import express from "express";
import { createDevVite, listen } from "./http-server";

const portOf = (server: { address(): string | AddressInfo | null }) => (server.address() as AddressInfo).port;
const close = (server: Server | ReturnType<typeof createNetServer>) => new Promise((resolve) => server.close(resolve));

async function freePort() {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = portOf(probe);
  await close(probe);
  return port;
}

test("in development the app, not Vite's socket server, answers HTTP requests on PORT", async () => {
  // The real server listens on PORT; the regression was Vite claiming PORT first.
  const port = await freePort();
  process.env.PORT = String(port);
  const app = express();
  const httpServer = createServer(app);
  const vite = await createDevVite(httpServer, false);
  app.use(vite.middlewares);
  app.get("/ping", (_req, res) => res.send("app"));
  try {
    await listen(httpServer, port, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app");
  } finally {
    await vite.close();
    if (httpServer.listening) await close(httpServer);
  }
});

test("listen rejects when the port is taken instead of reporting success", async () => {
  const squatter = createNetServer();
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const server = createServer();
  try {
    await assert.rejects(listen(server, portOf(squatter), "127.0.0.1"), { code: "EADDRINUSE" });
    assert.equal(server.listening, false);
  } finally {
    await close(squatter);
  }
});
