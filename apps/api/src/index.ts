import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { userRouter } from "./routes/user";

const app = new Hono();

app.use("*", cors({ origin: process.env.WEB_URL ?? "http://localhost:3000" }));
app.use("*", logger());

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.route("/users", userRouter);

const port = Number(process.env.PORT ?? 3001);
console.log(`API running on http://localhost:${port}`);

serve({ fetch: app.fetch, port });
