import express from "express";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb, createQueue, createStorage } from "@workspace/shared";
import { authRoutes, requireSession, seedAccounts, sessionRoutes } from "./modules/auth";
import { libraryRoutes } from "./modules/library";
import { ingestRoutes } from "./modules/ingest";
import { feedbackRoutes, featureOfPage, syncPrototypeQuestions } from "./modules/feedback";
import { loggingRoutes } from "./modules/logging";
import { cutRoutes } from "./modules/cuts";
import { nudgeWorker, workerNudgePort } from "./worker-nudge";
import { createDevVite, listen } from "./http-server";

const port = Number(process.env.PORT);
if (!Number.isSafeInteger(port) || port < 1) throw new Error("PORT is required");
const root = fileURLToPath(new URL("../", import.meta.url));
const { db } = connectDb();
const queue = createQueue(db);
const nudgePort = workerNudgePort();
const ctx = { db, queue: { ...queue, enqueue: async (...args: Parameters<typeof queue.enqueue>) => {
  const id = await queue.enqueue(...args);
  void nudgeWorker(nudgePort);
  return id;
} }, storage: createStorage() };
await seedAccounts(ctx);
await syncPrototypeQuestions(ctx);
const app = express();
const httpServer = createServer(app);
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    const origin = req.headers.origin;
    // Same-origin browser requests carry Origin. Reject explicitly cross-origin mutations.
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) return res.status(403).json({ error: "Cross-origin request denied" });
  }
  return next();
});
app.use("/app-api/auth", authRoutes(ctx)); // Sign-in itself is the one unauthenticated operation.
app.use("/app-api", requireSession(ctx));
app.use("/app-api", sessionRoutes(ctx), libraryRoutes(ctx), ingestRoutes(ctx), feedbackRoutes(ctx), loggingRoutes(ctx), cutRoutes(ctx));
app.use("/app-api", (_req, res) => res.status(404).json({ error: "Not found" }));
const gatePage = requireSession(ctx);
// The home page answers 200 to anyone, signed in or not: the deployment's health check calls it with no session, and a
// 401 there fails the publish. The page itself is the app shell, which sends a visitor to the library or to sign-in.
app.get("/", (_req, _res, next) => next());
app.get("/library", gatePage, (_req, _res, next) => next());
app.get("/sources/:id/log", gatePage, (_req, _res, next) => next());
app.get("/shoots/:id/lesson", gatePage, (_req, _res, next) => next());
// The pages the SPA serves: sign-in, and every page the rail knows (featureOfPage).
const isPage = (path: string) => path === "/" || path === "/sign-in" || featureOfPage(path) !== null;
app.get("/feedback", gatePage, (_req, _res, next) => next());
if (process.env.NODE_ENV !== "production") {
  const vite = await createDevVite(httpServer, join(root, "vite.config.ts"));
  app.use(vite.middlewares);
  app.get("/{*path}", async (req, res, next) => {
    if (!isPage(req.path)) return res.status(404).end();
    try {
      const html = await vite.transformIndexHtml(req.originalUrl, await (await import("node:fs/promises")).readFile(join(root, "index.html"), "utf8"));
      res.type("html").send(html);
    } catch (error) { return next(error); }
  });
} else {
  app.use(express.static(join(root, "dist/public"), { index: false, dotfiles: "deny" }));
  app.get("/{*path}", (req, res) => {
    if (!isPage(req.path)) return res.status(404).end();
    return res.sendFile(join(root, "dist/public/index.html"));
  });
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Request failed", error);
  res.status(500).json({ error: "Internal server error" });
});
await listen(httpServer, port, "0.0.0.0");
console.info(`DojoOS web listening on ${port}`);
