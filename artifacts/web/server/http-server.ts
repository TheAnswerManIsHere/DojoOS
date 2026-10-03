import type { Server } from "node:http";
import { createServer as createViteServer } from "vite";

/**
 * Development Vite in middleware mode, with its hot-reload socket on the app's
 * own HTTP server. Giving HMR a port of its own made Vite bind PORT before the
 * app did, so every request was answered by Vite's socket server with 426.
 */
export function createDevVite(httpServer: Server, configFile: string | false) {
  return createViteServer({ configFile, server: { middlewareMode: true, hmr: { server: httpServer } }, appType: "custom" });
}

/**
 * Resolves only once the server is actually listening. A bind failure rejects,
 * so startup fails loudly instead of logging "listening" over a port something
 * else answers.
 */
export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
