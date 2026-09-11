import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes } from "./auth";
import type { AppBindings } from "./env";
import { jobsRoutes } from "./jobs/routes";
import { apiRoutes } from "./routes";
import { EspnError } from "./services/espn";

export { PickemWorkflow } from "./workflows";

const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  if (c.env.APP_ENV !== "local" && c.req.url.startsWith("http:")) {
    c.header("Cache-Control", "no-store");
    return c.redirect(`https:${c.req.url.slice(5)}`, 308);
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.use("*", async (c, next) => {
  const path = c.req.path;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  const identityWrite =
    path === "/auth/discord/callback" ||
    (path === "/submissions/new" && c.req.query("token") !== undefined);
  const jobControl =
    path === "/api/admin/jobs" || path.startsWith("/api/admin/jobs/");
  if (
    c.env.MAINTENANCE_MODE === "true" &&
    (identityWrite || (mutating && path !== "/logout" && !jobControl))
  ) {
    c.header("Cache-Control", "no-store");
    return c.json(
      { error: "Writes are paused for migration. Please try again later." },
      503,
    );
  }
  await next();
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }
  if (error instanceof EspnError) {
    return c.json(
      { error: "Game data is unavailable. Please try again." },
      502,
    );
  }
  // Do not log URLs, request bodies, token claims, or upstream response bodies.
  console.error("Request failed", { path: c.req.path, error: error.name });
  return c.json({ error: "Unable to complete the request." }, 500);
});

app.get("/up", (c) => c.json({ status: "ok" }));
app.route("/", authRoutes);
app.route("/api", apiRoutes);
app.route("/api/admin/jobs", jobsRoutes);
app.all("/api", (c) => c.json({ error: "Not found" }, 404));
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/auth", (c) => c.json({ error: "Not found" }, 404));
app.all("/auth/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/logout", (c) => c.json({ error: "Not found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
