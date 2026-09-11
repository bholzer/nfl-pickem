import type { D1Database } from "@cloudflare/workers-types";
import type { JobParams, JobRun, JobType } from "../../shared/contracts";
import type { Env } from "../env";

export const schedules: Array<{ type: JobType; cron: string }> = [
  { type: "deliver_submission_links", cron: "0 13 * * TUE" },
  { type: "schedule_hash_delivery", cron: "0 14 * * THU" },
  { type: "deliver_standings", cron: "*/15 2-4 * * FRI" },
  { type: "deliver_standings", cron: "*/15 20-23 * * SUN" },
  { type: "deliver_standings", cron: "*/15 0-5 * * MON" },
  { type: "deliver_standings", cron: "*/15 2-4 * * TUE" },
];
export const terminal: Record<string, true | undefined> = {
  complete: true,
  errored: true,
  cancelled: true,
  superseded: true,
  creation_failed: true,
};
type JobRow = Omit<JobRun, "params"> & { params: string };
const columns = `id, type, season, week, status, planned_at AS plannedAt, created_at AS createdAt,
  updated_at AS updatedAt, error, source, params, started_at AS startedAt,
  finished_at AS finishedAt, parent_id AS parentId`;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const isMissingWorkflow = (error: unknown) =>
  error instanceof Error &&
  /(?:^|\()instance\.not_found(?:\)|$)/.test(error.message);
export const nowIso = () => new Date().toISOString();
export const isPaused = async (db: D1Database) =>
  (await db
    .prepare("SELECT paused FROM job_settings WHERE id = 1")
    .first<number>("paused")) === 1;

export class WorkflowCreationError extends Error {
  constructor(
    message: string,
    readonly run: JobRun,
  ) {
    super(message);
    this.name = "WorkflowCreationError";
  }
}

export async function getRun(
  db: D1Database,
  id: string,
): Promise<JobRun | null> {
  const row = await db
    .prepare(`SELECT ${columns} FROM job_runs WHERE id = ?`)
    .bind(id)
    .first<JobRow>();
  return row ? { ...row, params: JSON.parse(row.params) as JobParams } : null;
}

export async function requireRun(db: D1Database, id: string): Promise<JobRun> {
  const run = await getRun(db, id);
  if (!run) {
    throw new Error(`Job ${id} is missing from durable history`);
  }
  return run;
}
export async function insertRun(
  db: D1Database,
  params: JobParams,
  source: JobRun["source"],
  scope = params.runId,
  parent: string | null = null,
) {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO job_runs
    (id,type,season,week,params,source,status,created_at,updated_at,delivery_scope,parent_id)
    VALUES (?,?,?,?,?,?,'queued',?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      params.runId,
      params.type,
      params.season,
      params.week,
      JSON.stringify(params),
      source,
      now,
      now,
      scope,
      parent,
    )
    .run();
}
export async function setStatus(
  db: D1Database,
  id: string,
  status: string,
  error: string | null = null,
) {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE job_runs SET status = ?, error = ?, updated_at = ?,
    started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
    finished_at = CASE WHEN ? THEN ? ELSE finished_at END
    WHERE id = ? AND status NOT IN ('paused','complete','errored','cancelled','superseded','creation_failed')`,
    )
    .bind(status, error, now, status, now, terminal[status] ? 1 : 0, now, id)
    .run();
}
export async function enqueue(
  env: Env,
  type: JobType,
  period: Pick<JobParams, "season" | "week">,
  parent?: JobRun,
) {
  const id = crypto.randomUUID();
  const params: JobParams = {
    ...(!parent ? { weekOffset: 0 } : {}),
    ...parent?.params,
    type,
    season: period.season,
    week: period.week,
    runId: id,
  };
  const scope = parent
    ? await env.DB.prepare("SELECT delivery_scope FROM job_runs WHERE id = ?")
        .bind(parent.id)
        .first<string>("delivery_scope")
    : id;
  await insertRun(env.DB, params, "manual", scope ?? id, parent?.id ?? null);
  try {
    await env.JOBS.create({ id, params });
  } catch (error) {
    await setStatus(
      env.DB,
      id,
      "creation_failed",
      `Workflow creation failed: ${errorMessage(error)}`,
    );
    throw new WorkflowCreationError(
      errorMessage(error),
      await requireRun(env.DB, id),
    );
  }
  return requireRun(env.DB, id);
}

function isStaleUnstartedRun(run: JobRun) {
  return (
    run.status === "queued" &&
    run.startedAt === null &&
    Date.now() - Date.parse(run.createdAt) > 300_000
  );
}

export async function reconcile(env: Env, run: JobRun): Promise<JobRun> {
  // D1 is the long-lived history. Expired platform records must never erase it.
  if (terminal[run.status] || run.status === "paused") {
    return run;
  }
  try {
    const status = await (await env.JOBS.get(run.id)).status();
    switch (status.status) {
      case "complete":
        await setStatus(env.DB, run.id, "complete");
        break;
      case "errored":
        await setStatus(
          env.DB,
          run.id,
          "errored",
          status.error?.message ?? "Workflow failed",
        );
        break;
      case "terminated":
        await setStatus(env.DB, run.id, "cancelled");
        break;
    }
  } catch (error) {
    // Only a confirmed absence can make an unstarted, stale creation recoverable.
    // Transport failures and retained terminal history are not evidence of loss.
    if (isMissingWorkflow(error) && isStaleUnstartedRun(run)) {
      await setStatus(
        env.DB,
        run.id,
        "creation_failed",
        "Native instance was not created; this job can be retried or discarded",
      );
    }
  }
  return requireRun(env.DB, run.id);
}

export async function listRuns(
  db: D1Database,
  filters: { type?: string; status?: string; season?: number; before?: string },
) {
  const where: string[] = [];
  const args: Array<string | number> = [];
  for (const field of ["type", "status"] as const) {
    if (filters[field]) {
      where.push(`${field} = ?`);
      args.push(filters[field]);
    }
  }
  if (filters.season !== undefined) {
    where.push("season = ?");
    args.push(filters.season);
  }
  if (filters.before) {
    // An existing run ID is a stable cursor even when several runs share a timestamp.
    const cursor = await getRun(db, filters.before);
    if (cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(cursor.createdAt, cursor.createdAt, cursor.id);
    } else {
      where.push("created_at < ?");
      args.push(filters.before);
    }
  }
  const result = await db
    .prepare(
      `SELECT ${columns} FROM job_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC LIMIT 21`,
    )
    .bind(...args)
    .all<JobRow>();
  return {
    runs: result.results
      .slice(0, 20)
      .map((row) => ({ ...row, params: JSON.parse(row.params) as JobParams })),
    hasMore: result.results.length > 20,
  };
}

export async function recordDelivery(
  db: D1Database,
  runId: string,
  key: string,
  status: string,
  error: string | null = null,
) {
  await db
    .prepare(
      `INSERT INTO job_deliveries(run_id,key,status,error,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(run_id,key) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`,
    )
    .bind(runId, key, status, error, nowIso())
    .run();
}

// A lease bounds crash recovery; it cannot atomically commit Discord's remote send.
export async function claimEffect(
  db: D1Database,
  key: string,
  owner: string,
  ttl: number | null = null,
) {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO job_effects(key,owner,status,lease_until,expires_at)
    VALUES(?,?,'sending',?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,
    status='sending',lease_until=excluded.lease_until,expires_at=excluded.expires_at
    WHERE (job_effects.status='sending' AND (job_effects.owner=excluded.owner OR job_effects.lease_until <= ?))
      OR (job_effects.status='sent' AND job_effects.expires_at <= ?)
    RETURNING key`,
    )
    .bind(
      key,
      owner,
      now + 300_000,
      ttl === null ? Number.MAX_SAFE_INTEGER : now + ttl,
      now,
      now,
    )
    .first();
  if (result) {
    return "claimed" as const;
  }
  const status = await db
    .prepare("SELECT status FROM job_effects WHERE key=?")
    .bind(key)
    .first<string>("status");
  return status === "sent" ? ("suppressed" as const) : ("busy" as const);
}
export async function releaseEffect(
  db: D1Database,
  key: string,
  owner: string,
) {
  await db
    .prepare(
      "DELETE FROM job_effects WHERE key=? AND owner=? AND status='sending'",
    )
    .bind(key, owner)
    .run();
}
export async function finishEffect(db: D1Database, key: string, owner: string) {
  const result = await db
    .prepare(
      "UPDATE job_effects SET status='sent' WHERE key=? AND owner=? AND status='sending' RETURNING key",
    )
    .bind(key, owner)
    .first();
  if (!result) {
    throw new Error(
      "Delivery lease was lost after remote send; operator review required",
    );
  }
}
export async function hasMarker(db: D1Database, key: string) {
  return !!(await db
    .prepare("SELECT key FROM job_markers WHERE key=? AND expires_at > ?")
    .bind(key, Date.now())
    .first());
}
export async function mark(db: D1Database, keys: string[]) {
  if (!keys.length) {
    return;
  }
  await db.batch(
    keys.map((key) =>
      db
        .prepare(
          `INSERT INTO job_markers(key,expires_at) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at`,
        )
        .bind(key, Date.now() + 7 * 86400_000),
    ),
  );
}

export async function deliveryMessage(
  db: D1Database,
  key: string,
  build: () => Promise<string>,
  ttl: number | null = null,
) {
  const now = Date.now();
  const cached = await db
    .prepare("SELECT message FROM job_messages WHERE key=? AND expires_at > ?")
    .bind(key, now)
    .first<string>("message");
  if (cached !== null) {
    return cached;
  }
  const message = await build();
  // Retry children must not combine previously delivered parts with a new snapshot.
  await db
    .prepare(
      `INSERT INTO job_messages(key,message,expires_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET message=excluded.message,expires_at=excluded.expires_at
    WHERE job_messages.expires_at <= ?`,
    )
    .bind(key, message, ttl === null ? Number.MAX_SAFE_INTEGER : now + ttl, now)
    .run();
  const persisted = await db
    .prepare("SELECT message FROM job_messages WHERE key=?")
    .bind(key)
    .first<string>("message");
  if (persisted === null) {
    throw new Error(`Delivery message ${key} is missing from durable history`);
  }
  return persisted;
}
