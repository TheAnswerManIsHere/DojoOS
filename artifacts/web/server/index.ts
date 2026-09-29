import express from "express";
import { createServer as createViteServer } from "vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb, createQueue, createStorage } from "@workspace/shared";
import { authRoutes, requireSession, seedAccounts, sessionRoutes } from "./modules/auth";
import { libraryRoutes } from "./modules/library";
import { ingestRoutes } from "./modules/ingest";
import { feedbackRoutes } from "./modules/feedback";

const root = fileURLToPath(new URL("../", import.meta.url));
const { db } = connectDb();
const ctx = { db, queue: createQueue(db), storage: createStorage() };
await seedAccounts(ctx);
const app = express();
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
app.use("/app-api/auth", authRoutes(ctx)); // Unauthenticated request and verification are required for sign-in.
app.use("/app-api", requireSession(ctx));
app.use("/app-api", sessionRoutes(ctx), libraryRoutes(ctx), ingestRoutes(ctx), feedbackRoutes(ctx));
app.use("/app-api", (_req, res) => res.status(404).json({ error: "Not found" }));
const gatePage = requireSession(ctx);
app.get("/", gatePage, (_req, res) => res.redirect("/library"));
app.get("/library", gatePage, (_req, _res, next) => next());
app.get("/feedback", gatePage, (req, res, next) => req.account?.tier === "operator" ? next() : res.status(403).end());
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({ configFile: join(root, "vite.config.ts"), server: { middlewareMode: true, hmr: { port: Number(process.env.PORT) } }, appType: "custom" });
  app.use(vite.middlewares);
  app.get("/{*path}", async (req, res, next) => {
    if (!["/sign-in", "/library", "/feedback"].includes(req.path)) return res.status(404).end();
    try {
      const html = await vite.transformIndexHtml(req.originalUrl, await (await import("node:fs/promises")).readFile(join(root, "index.html"), "utf8"));
      res.type("html").send(html);
    } catch (error) { return next(error); }
  });
} else {
  app.use(express.static(join(root, "dist/public"), { index: false, dotfiles: "deny" }));
  app.get("/{*path}", (req, res) => {
    if (!["/sign-in", "/library", "/feedback"].includes(req.path)) return res.status(404).end();
    return res.sendFile(join(root, "dist/public/index.html"));
  });
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Request failed", error);
  res.status(500).json({ error: "Internal server error" });
});
const port = Number(process.env.PORT);
if (!Number.isSafeInteger(port) || port < 1) throw new Error("PORT is required");
app.listen(port, "0.0.0.0", () => console.info(`DojoOS web listening on ${port}`));