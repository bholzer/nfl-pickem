import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { JOB_TYPES, type JobRun, type JobType } from "../../shared/contracts";
import { validSeason, validWeek } from "../../shared/season";
import { requireAdmin, requireCsrf, requireUser } from "../auth";
import type { AppBindings, Env } from "../env";
import {
  enqueue,
  errorMessage,
  getRun,
  isMissingWorkflow,
  isPaused,
  listRuns,
  nowIso,
  reconcile,
  requireRun,
  schedules,
  terminal,
  WorkflowCreationError,
} from "./store";

class JobControlError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422 | 503,
    readonly run?: JobRun,
  ) {
    super(message);
  }
}
const actions = ["retry", "pause", "resume", "cancel", "run_now"] as const;
type Action = (typeof actions)[number];
const isAction = (value: unknown): value is Action =>
  actions.some((action) => action === value);
const isJobType = (value: unknown): value is JobType =>
  JOB_TYPES.some((type) => type === value);

function hasJobType(value: unknown): value is { type: JobType } {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    isJobType(value.type)
  );
}

function isWeek(value: unknown): value is number | null {
  return value === null || validWeek(value);
}

function seasonFilter(query: string | undefined) {
  if (query === undefined) {
    return undefined;
  }
  const season = Number(query);
  if (!validSeason(season)) {
    throw new JobControlError("Invalid season filter", 422);
  }
  return season;
}

function isJobIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every((id: unknown) => typeof id === "string") &&
    new Set(value).size === value.length
  );
}

function isMaintenanceStop(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
) {
  if (method === "PUT" && path.endsWith("/pause")) {
    return body?.paused === true;
  }
  return (
    method === "POST" &&
    (path.endsWith("/action") || path.endsWith("/actions")) &&
    (body?.action === "pause" || body?.action === "cancel")
  );
}
const statuses = [
  "queued",
  "running",
  "sleeping",
  "paused",
  "complete",
  "errored",
  "cancelled",
  "superseded",
  "creation_failed",
];

type ClaimedControl = {
  env: Env;
  run: JobRun;
  owner: string;
  action: Action;
};

function canControl(run: JobRun, action: Action) {
  switch (action) {
    case "retry":
      return ["errored", "creation_failed", "cancelled"].includes(run.status);
    case "resume":
      return run.status === "paused";
    case "pause":
      return ["queued", "running", "sleeping"].includes(run.status);
    case "run_now":
      return (
        run.type === "schedule_hash_delivery" &&
        !!run.plannedAt &&
        ["sleeping", "paused"].includes(run.status)
      );
    case "cancel":
      return !["complete", "cancelled", "superseded"].includes(run.status);
  }
}

async function ensureNoReplacement({ env, run }: ClaimedControl) {
  const childId = await env.DB.prepare(
    "SELECT id FROM job_runs WHERE parent_id=?",
  )
    .bind(run.id)
    .first<string>("id");
  if (childId) {
    throw new JobControlError(
      "This job already has a replacement; control the replacement job instead",
      409,
      await requireRun(env.DB, childId),
    );
  }
}

async function notifyDeliveryResume(
  env: Env,
  id: string,
  instance: WorkflowInstance,
  failureMessage: string,
) {
  const paused = await env.DB.prepare(
    "SELECT gate_paused FROM job_runs WHERE id=?",
  )
    .bind(id)
    .first<number>("gate_paused");
  if (paused !== 1) {
    return;
  }
  try {
    await instance.sendEvent({ type: "delivery-resume", payload: {} });
  } catch (error) {
    throw new JobControlError(`${failureMessage}: ${errorMessage(error)}`, 503);
  }
}

async function resumeRun({ env, run, owner }: ClaimedControl) {
  const instance = await env.JOBS.get(run.id);
  const native = (await instance.status()).status;
  if (native === "paused") {
    await instance.resume();
  } else if (!["running", "waiting", "queued"].includes(native)) {
    throw new JobControlError(
      `Native job is ${native}; refresh before resuming`,
      409,
    );
  }
  // A failed pause can leave a D1-only fence around a still-running instance.
  const pendingAt = run.plannedAt ?? run.params.notBefore;
  await env.DB.prepare(
    "UPDATE job_runs SET status=?,updated_at=? WHERE id=? AND control=? AND status='paused'",
  )
    .bind(
      pendingAt && new Date(pendingAt).getTime() > Date.now()
        ? "sleeping"
        : "running",
      nowIso(),
      run.id,
      owner,
    )
    .run();
  await notifyDeliveryResume(
    env,
    run.id,
    instance,
    "Job resumed but delivery notification failed; retry global unpause",
  );
}

async function controlledInstance({ env, run, action }: ClaimedControl) {
  if (terminal[run.status]) {
    return undefined;
  }
  try {
    return await env.JOBS.get(run.id);
  } catch (error) {
    if (action === "pause" || !isMissingWorkflow(error)) {
      throw error;
    }
    return undefined;
  }
}

async function pauseFailureStatus(
  { env, run, owner }: ClaimedControl,
  instance: WorkflowInstance,
  error: unknown,
) {
  const native = await instance.status().catch(() => null);
  if (
    !native ||
    native.status === "paused" ||
    native.status === "waitingForPause"
  ) {
    await env.DB.prepare(
      "UPDATE job_runs SET error=?,updated_at=? WHERE id=? AND control=?",
    )
      .bind(
        `Pause response failed; job remains fenced: ${errorMessage(error)}`,
        nowIso(),
        run.id,
        owner,
      )
      .run();
    throw new JobControlError(
      "Pause outcome requires review; job remains paused. Refresh, then resume or cancel it.",
      503,
    );
  }
  switch (native.status) {
    case "complete":
      return "complete";
    case "errored":
      return "errored";
    case "terminated":
      return "cancelled";
    default:
      return run.status;
  }
}

async function compensateControl(
  control: ClaimedControl,
  instance: WorkflowInstance | undefined,
  error: unknown,
) {
  const { env, run, owner, action } = control;
  const restored =
    action === "pause" && instance
      ? await pauseFailureStatus(control, instance, error)
      : run.status;
  await env.DB.prepare(
    "UPDATE job_runs SET status=?,finished_at=?,error=?,updated_at=? WHERE id=? AND control=?",
  )
    .bind(
      restored,
      terminal[restored] ? nowIso() : null,
      `Control ${action} failed: ${errorMessage(error)}`,
      nowIso(),
      run.id,
      owner,
    )
    .run();
  if (instance && restored !== "paused" && !terminal[restored]) {
    await notifyDeliveryResume(
      env,
      run.id,
      instance,
      "Control failed and delivery wakeup failed; retry global unpause",
    );
  }
  throw error;
}

async function fenceRun({ env, run, owner, action }: ClaimedControl) {
  let target = "cancelled";
  if (action === "pause") {
    target = "paused";
  } else if (action === "run_now") {
    target = "superseded";
  }
  // Fence new deliveries before native control. In-flight sends cannot be recalled.
  const changed = await env.DB.prepare(
    `UPDATE job_runs SET status=?,updated_at=?,finished_at=?
    WHERE id=? AND control=? AND status=? RETURNING id`,
  )
    .bind(
      target,
      nowIso(),
      target === "paused" ? null : nowIso(),
      run.id,
      owner,
      run.status,
    )
    .first();
  if (!changed) {
    throw new JobControlError("Job changed state while applying control", 409);
  }
}

async function stopRun(control: ClaimedControl) {
  const { action } = control;
  // Failed records can be retired without a native API.
  const instance = await controlledInstance(control);
  await fenceRun(control);
  try {
    if (!instance) {
      return;
    }
    if (action === "pause") {
      await instance.pause();
    } else {
      await instance.terminate();
    }
  } catch (error) {
    // Confirmed absence already satisfies cancellation/termination.
    if (action === "pause" || !isMissingWorkflow(error)) {
      await compensateControl(control, instance, error);
    }
  }
}

async function applyControl(control: ClaimedControl): Promise<JobRun> {
  const { env, run, action } = control;
  if (action === "retry" || action === "run_now") {
    await ensureNoReplacement(control);
  }
  if (action === "retry") {
    return enqueue(env, run.type, run, run);
  }
  if (action === "resume") {
    await resumeRun(control);
  } else {
    await stopRun(control);
  }
  if (action === "run_now") {
    const params = { ...run.params };
    delete params.notBefore;
    return enqueue(env, "deliver_hashes", run, { ...run, params });
  }
  return requireRun(env.DB, run.id);
}

export async function controlRun(
  env: Env,
  id: string,
  action: Action,
): Promise<JobRun> {
  const existing = await getRun(env.DB, id);
  if (!existing) {
    throw new JobControlError("Job not found", 404);
  }
  const run = await reconcile(env, existing);
  if (!canControl(run, action)) {
    throw new JobControlError(
      `Cannot ${action} a ${run.status} ${run.type} job`,
      409,
    );
  }
  const owner = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE job_runs SET control=?,control_until=? WHERE id=?
    AND status=? AND (control IS NULL OR control_until <= ?) RETURNING id`,
  )
    .bind(owner, Date.now() + 300_000, id, run.status, Date.now())
    .first();
  if (!claimed) {
    throw new JobControlError(
      "Another operator is changing this job; refresh and retry",
      409,
    );
  }
  try {
    return await applyControl({ env, run, owner, action });
  } catch (error) {
    if (error instanceof JobControlError) {
      throw error;
    }
    throw new JobControlError(
      `Job ${action} failed: ${errorMessage(error)}`,
      503,
      error instanceof WorkflowCreationError ? error.run : undefined,
    );
  } finally {
    await env.DB.prepare(
      "UPDATE job_runs SET control=NULL,control_until=NULL WHERE id=? AND control=?",
    )
      .bind(id, owner)
      .run();
  }
}

export async function setGlobalPause(env: Env, paused: boolean) {
  await env.DB.prepare("UPDATE job_settings SET paused=? WHERE id=1")
    .bind(paused ? 1 : 0)
    .run();
  if (paused) {
    return;
  }
  const waiting = await env.DB.prepare(
    `SELECT id FROM job_runs WHERE gate_paused=1
    AND status NOT IN ('paused','complete','errored','cancelled','superseded','creation_failed')`,
  ).all<{ id: string }>();
  const failed: string[] = [];
  for (const run of waiting.results) {
    try {
      await (
        await env.JOBS.get(run.id)
      ).sendEvent({ type: "delivery-resume", payload: {} });
    } catch {
      failed.push(run.id);
    }
  }
  if (failed.length) {
    throw new JobControlError(
      `Dispatch unpaused but some wakeups failed; retry unpause for jobs: ${failed.join(", ")}`,
      503,
    );
  }
}

export const jobsRoutes = new Hono<AppBindings>();
jobsRoutes.use("*", requireUser, requireAdmin);
jobsRoutes.use(
  "*",
  createMiddleware<AppBindings>(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return requireCsrf(c, next);
    }
    await next();
  }),
);
jobsRoutes.use("*", async (c, next) => {
  if (
    c.env.MAINTENANCE_MODE === "true" &&
    c.req.method !== "GET" &&
    c.req.method !== "HEAD"
  ) {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!isMaintenanceStop(c.req.method, c.req.path, body)) {
      return c.json(
        {
          error:
            "Only pausing and cancelling work are allowed during migration.",
        },
        503,
      );
    }
  }
  await next();
});
jobsRoutes.onError((error, c) =>
  c.json(
    {
      error: errorMessage(error),
      run: error instanceof JobControlError ? error.run : undefined,
    },
    error instanceof JobControlError ? error.status : 503,
  ),
);

jobsRoutes.get("/", async (c) => {
  const type = c.req.query("type");
  const status = c.req.query("status");
  const before = c.req.query("before");
  const season = seasonFilter(c.req.query("season"));
  if ((type && !isJobType(type)) || (status && !statuses.includes(status))) {
    return c.json({ error: "Invalid job filter" }, 422);
  }
  if (
    before &&
    !(await getRun(c.env.DB, before)) &&
    !Number.isFinite(Date.parse(before))
  ) {
    return c.json({ error: "Invalid pagination cursor" }, 422);
  }
  const page = await listRuns(c.env.DB, { type, status, before, season });
  const runs = await Promise.all(page.runs.map((run) => reconcile(c.env, run)));
  return c.json({
    runs,
    hasMore: page.hasMore,
    paused: await isPaused(c.env.DB),
    schedules,
  });
});

jobsRoutes.post("/", async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!hasJobType(body)) {
    return c.json({ error: "Invalid job type" }, 422);
  }
  if (!("season" in body) || !validSeason(body.season)) {
    return c.json(
      { error: "Season must be an integer from 1920 to 9999" },
      422,
    );
  }
  const week = "week" in body ? body.week : null;
  if (!isWeek(week)) {
    return c.json(
      { error: "Week must be null or an integer from 1 to 18" },
      422,
    );
  }
  try {
    const run = await enqueue(c.env, body.type, { season: body.season, week });
    return c.json({ run }, 201);
  } catch (error) {
    return c.json(
      {
        error: `Workflow creation failed: ${errorMessage(error)}`,
        run: error instanceof WorkflowCreationError ? error.run : undefined,
      },
      503,
    );
  }
});

jobsRoutes.put("/pause", async (c) => {
  const body = await c.req.json<{ paused?: unknown }>().catch(() => null);
  if (!body || typeof body.paused !== "boolean") {
    return c.json({ error: "paused must be a boolean" }, 422);
  }
  await setGlobalPause(c.env, body.paused);
  return c.json({ paused: body.paused });
});

jobsRoutes.post("/actions", async (c) => {
  const body = await c.req
    .json<{ ids?: unknown; action?: unknown }>()
    .catch(() => null);
  if (!body || !isAction(body.action) || !isJobIds(body.ids)) {
    return c.json(
      { error: "Provide one action and 1–100 distinct job IDs" },
      422,
    );
  }
  const runs: JobRun[] = [];
  // Each native operation is independently durable; expose partial success rather
  // than claiming atomicity across unrelated platform instances.
  for (const id of body.ids) {
    try {
      runs.push(await controlRun(c.env, id, body.action));
    } catch (error) {
      if (error instanceof JobControlError && error.run) {
        runs.push(error.run);
      }
      return c.json(
        { runs, failedId: id, error: errorMessage(error) },
        error instanceof JobControlError ? error.status : 503,
      );
    }
  }
  return c.json({ runs });
});

jobsRoutes.get("/:id", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (!run) {
    return c.json({ error: "Job not found" }, 404);
  }
  const deliveries = await c.env.DB.prepare(
    `SELECT key,status,error,updated_at AS updatedAt
    FROM job_deliveries WHERE run_id=? ORDER BY key`,
  )
    .bind(run.id)
    .all();
  return c.json({
    run: await reconcile(c.env, run),
    deliveries: deliveries.results,
  });
});
jobsRoutes.post("/:id/action", async (c) => {
  const body = await c.req.json<{ action?: unknown }>().catch(() => null);
  if (!body || !isAction(body.action)) {
    return c.json({ error: "Invalid job action" }, 422);
  }
  return c.json({
    run: await controlRun(c.env, c.req.param("id"), body.action),
  });
});
