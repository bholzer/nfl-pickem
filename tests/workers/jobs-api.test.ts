import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { assert, describe, expect, it } from "vitest";
import type { Env } from "../../src/server/env";
import type { JobParams, JobRun, JobsData } from "../../src/shared/contracts";
import { ensureTokenUser } from "../../src/server/db";
import { signToken } from "../../src/server/tokens";
import { jobsRoutes } from "../../src/server/jobs/routes";
import {
  claimEffect,
  finishEffect,
  getRun,
  hasMarker,
  insertRun,
  mark,
  reconcile,
  releaseEffect,
  setStatus,
} from "../../src/server/jobs/store";

async function identity(admin: boolean) {
  const user = await ensureTokenUser(env.DB, {
    discordId: admin ? "1001" : "1002",
    username: admin ? "Admin" : "Player",
  });
  if (admin) {
    await env.DB.prepare("UPDATE users SET admin=1 WHERE id=?")
      .bind(user.id)
      .run();
  }
  const csrf = "a".repeat(43);
  const token = await signToken(
    {
      purpose: "session",
      userId: user.id,
      csrf,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    env.SESSION_SECRET,
  );
  return {
    Cookie: `pickem_session=${token}`,
    Origin: env.APP_ORIGIN,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
}
async function request(
  path: string,
  method = "GET",
  headers: HeadersInit = {},
  body?: unknown,
  bindings: Env = env,
): Promise<Response> {
  return jobsRoutes.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    bindings,
  );
}
async function run(
  id: string,
  status = "queued",
  type: JobParams["type"] = "deliver_hashes",
  season = 2026,
) {
  await insertRun(env.DB, { runId: id, type, season, week: 1 }, "manual");
  if (status !== "queued") {
    await setStatus(
      env.DB,
      id,
      status,
      status === "errored" ? "Observed upstream failure" : null,
    );
  }
}

describe("jobs administrator API", () => {
  it("requires a real admin session for list/detail and CSRF for every mutation", async () => {
    await run("private-job", "errored");
    const member = await identity(false);
    const admin = await identity(true);
    for (const path of ["/", "/private-job"]) {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, "GET", member)).status).toBe(403);
      expect((await request(path, "GET", admin)).status).toBe(200);
    }
    const mutations = [
      ["/", "POST", { type: "deliver_hashes", season: 2026, week: 1 }],
      ["/private-job/action", "POST", { action: "retry" }],
      ["/actions", "POST", { ids: ["private-job"], action: "retry" }],
      ["/pause", "PUT", { paused: true }],
    ] as const;
    for (const [path, method, body] of mutations) {
      expect((await request(path, method, member, body)).status).toBe(403);
      expect(
        (
          await request(
            path,
            method,
            { ...admin, "X-CSRF-Token": "wrong" },
            body,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            path,
            method,
            { ...admin, Origin: "https://attacker.invalid" },
            body,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM job_runs",
      ).first<number>("count"),
    ).toBe(1);
    const response = await request("/pause", "PUT", admin, { paused: true });
    expect(await response.json()).toEqual({ paused: true });
    expect(
      (await (await request("/", "GET", admin)).json<JobsData>()).paused,
    ).toBe(true);
  });

  it("paginates tied creation times without omissions and filters persisted type/status", async () => {
    const admin = await identity(true);
    for (let index = 0; index < 24; index++) {
      await run(`run-${String(index).padStart(2, "0")}`, "errored");
    }
    await env.DB.prepare(
      "UPDATE job_runs SET created_at='2026-09-10T12:00:00.000Z'",
    ).run();
    await run("other-type", "complete", "deliver_submission_links");
    const first = await (
      await request("/?type=deliver_hashes&status=errored", "GET", admin)
    ).json<JobsData>();
    expect(first.runs.map((item) => item.id)).toEqual(
      Array.from(
        { length: 20 },
        (_, i) => `run-${String(23 - i).padStart(2, "0")}`,
      ),
    );
    expect(first.hasMore).toBe(true);
    const cursor = first.runs.at(-1);
    assert(cursor);
    const next = await (
      await request(
        `/?type=deliver_hashes&status=errored&before=${cursor.id}`,
        "GET",
        admin,
      )
    ).json<JobsData>();
    expect(next.runs.map((item) => item.id)).toEqual([
      "run-03",
      "run-02",
      "run-01",
      "run-00",
    ]);
    expect(next.hasMore).toBe(false);
    expect(next.runs[0]).toMatchObject({
      params: { type: "deliver_hashes", week: 1 },
      error: "Observed upstream failure",
    });
    expect(next.runs[0]?.finishedAt).toEqual(expect.any(String));
    expect((await request("/?type=invalid", "GET", admin)).status).toBe(422);
    expect((await request("/?before=not-a-cursor", "GET", admin)).status).toBe(
      422,
    );
  });

  it("requires season when enqueuing and isolates history filters across seasons", async () => {
    const admin = await identity(true);
    const missing = await request("/", "POST", admin, {
      type: "deliver_hashes",
      week: 1,
    });
    expect(missing.status).toBe(422);
    await run("previous-season", "errored", "deliver_hashes", 2025);
    await run("current-season", "errored");
    const page = await (
      await request("/?season=2025", "GET", admin)
    ).json<JobsData>();
    expect(page.runs.map((item) => item.id)).toEqual(["previous-season"]);
    expect(page.runs[0]).toMatchObject({
      season: 2025,
      params: { season: 2025, week: 1 },
    });
    expect((await request("/?season=not-a-season", "GET", admin)).status).toBe(
      422,
    );
  });

  it("awaits durable creation and reports a persisted creation failure instead of 201", async () => {
    const admin = await identity(true);
    let rejectCreation!: (error: Error) => void;
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bindings: Env = {
      ...env,
      JOBS: {
        create: async () => {
          entered();
          return new Promise<WorkflowInstance>((_resolve, reject) => {
            rejectCreation = reject;
          });
        },
      } as unknown as Workflow<JobParams>,
    };
    let settled = false;
    const pending = request(
      "/",
      "POST",
      admin,
      { type: "deliver_hashes", season: 2026, week: null },
      bindings,
    ).then((response) => {
      settled = true;
      return response;
    });
    await began;
    expect(settled).toBe(false);
    rejectCreation(new Error("Native workflow capacity unavailable"));
    const response = await pending;
    expect(response.status).toBe(503);
    const page = await (
      await request("/?status=creation_failed", "GET", admin)
    ).json<JobsData>();
    expect(page.runs).toEqual([
      expect.objectContaining({
        status: "creation_failed",
        week: null,
      }),
    ]);
    expect(page.runs[0]?.error).toContain("capacity unavailable");
    expect(page.runs[0]?.finishedAt).toEqual(expect.any(String));
  });

  it("returns a failed retry child in partial bulk results so the parent is not retried again", async () => {
    const admin = await identity(true);
    await run("first-parent", "errored");
    await run("second-parent", "errored");
    await request("/pause", "PUT", admin, { paused: true });
    await using all = await introspectWorkflow(env.JOBS);
    let first = true;
    const bindings = {
      ...env,
      JOBS: {
        create: async (options: WorkflowInstanceCreateOptions<JobParams>) => {
          if (first) {
            first = false;
            return env.JOBS.create(options);
          }
          throw new Error("Native creation unavailable");
        },
      },
    } as unknown as Env;
    const response = await request(
      "/actions",
      "POST",
      admin,
      { ids: ["first-parent", "second-parent"], action: "retry" },
      bindings,
    );
    expect(response.status).toBe(503);
    const result = await response.json<{
      runs: JobRun[];
      failedId: string;
    }>();
    expect(result.failedId).toBe("second-parent");
    expect(result.runs).toEqual([
      expect.objectContaining({ parentId: "first-parent" }),
      expect.objectContaining({
        parentId: "second-parent",
        status: "creation_failed",
      }),
    ]);
    const failedChild = result.runs[1];
    assert(failedChild);
    const recovery = await request(`/${failedChild.id}/action`, "POST", admin, {
      action: "retry",
    });
    expect(recovery.status).toBe(200);
    expect((await recovery.json<{ run: JobRun }>()).run.parentId).toBe(
      failedChild.id,
    );
  });

  it("enqueues native work while globally paused and supports bulk cancellation through authenticated routes", async () => {
    const admin = await identity(true);
    await request("/pause", "PUT", admin, { paused: true });
    await using traces = await introspectWorkflow(env.JOBS);
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await request("/", "POST", admin, {
        type: "deliver_hashes",
        season: 2026,
        week: 1,
      });
      expect(response.status).toBe(201);
      const body = await response.json<{ run: JobRun }>();
      ids.push(body.run.id);
    }
    for (const trace of await traces.get()) {
      expect(await trace.waitForStepResult({ name: "dispatch gate 0" })).toBe(
        true,
      );
    }
    const cancelled = await request("/actions", "POST", admin, {
      ids,
      action: "cancel",
    });
    expect(cancelled.status).toBe(200);
    expect(
      (await cancelled.json<{ runs: JobRun[] }>()).runs.map(
        (item) => item.status,
      ),
    ).toEqual(["cancelled", "cancelled"]);
    expect(
      (await request(`/${ids[0]}/action`, "POST", admin, { action: "run_now" }))
        .status,
    ).toBe(409);
    expect(
      (
        await request("/actions", "POST", admin, {
          ids: [ids[0], ids[0]],
          action: "retry",
        })
      ).status,
    ).toBe(422);
  });

  it("recovers a stale queued record whose native instance was never created", async () => {
    const admin = await identity(true);
    await run("orphaned-create");
    await env.DB.prepare(
      "UPDATE job_runs SET created_at=? WHERE id='orphaned-create'",
    )
      .bind(new Date(Date.now() - 600_000).toISOString())
      .run();
    const stale = await getRun(env.DB, "orphaned-create");
    assert(stale);
    const unavailable = {
      ...env,
      JOBS: {
        get: () => Promise.reject(new Error("Control API unavailable")),
      } as unknown as Workflow<JobParams>,
    };
    expect(await reconcile(unavailable, stale)).toMatchObject({
      status: "queued",
    });
    const detail = await (
      await request("/orphaned-create", "GET", admin)
    ).json<{ run: JobRun }>();
    expect(detail.run).toMatchObject({
      status: "creation_failed",
      startedAt: null,
    });
    await request("/pause", "PUT", admin, { paused: true });
    await using all = await introspectWorkflow(env.JOBS);
    const retried = await request("/orphaned-create/action", "POST", admin, {
      action: "retry",
    });
    expect(retried.status).toBe(200);
    const child = (await retried.json<{ run: JobRun }>()).run;
    expect(child.parentId).toBe("orphaned-create");
    expect(
      (
        await request(`/${child.id}/action`, "POST", admin, {
          action: "cancel",
        })
      ).status,
    ).toBe(200);
  });

  it("discards failed records without needing an available native control API", async () => {
    const admin = await identity(true);
    await run("failed-delivery", "errored");
    await run("failed-create", "creation_failed");
    const unavailable = {
      ...env,
      JOBS: {
        get: () => Promise.reject(new Error("Control API unavailable")),
      } as unknown as Workflow<JobParams>,
    };
    const result = await request(
      "/actions",
      "POST",
      admin,
      { ids: ["failed-delivery", "failed-create"], action: "cancel" },
      unavailable,
    );
    expect(result.status).toBe(200);
    expect(
      (await result.json<{ runs: JobRun[] }>()).runs.map((item) => item.status),
    ).toEqual(["cancelled", "cancelled"]);
    expect(await getRun(env.DB, "failed-delivery")).toMatchObject({
      error: "Observed upstream failure",
      status: "cancelled",
    });
  });

  it("allows only stopping work while maintenance freezes job dispatch", async () => {
    const admin = await identity(true);
    await run("failed", "errored");
    const bindings = { ...env, MAINTENANCE_MODE: "true" };
    for (const [path, method, body] of [
      ["/", "POST", { type: "deliver_hashes", season: 2026, week: 1 }],
      ["/failed/action", "POST", { action: "retry" }],
      ["/failed/action", "POST", { action: "resume" }],
      ["/pause", "PUT", { paused: false }],
    ] as const) {
      expect((await request(path, method, admin, body, bindings)).status).toBe(
        503,
      );
    }
    expect(
      (await request("/pause", "PUT", admin, { paused: true }, bindings))
        .status,
    ).toBe(200);
    expect(
      (
        await request(
          "/failed/action",
          "POST",
          admin,
          { action: "cancel" },
          bindings,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await (
          await request("/", "GET", admin, undefined, bindings)
        ).json<JobsData>()
      ).paused,
    ).toBe(true);
    expect(await getRun(env.DB, "failed")).toMatchObject({
      status: "cancelled",
    });
  });

  it("does not publish a pause fence when the native handle lookup is unavailable", async () => {
    const admin = await identity(true);
    await run("active", "running");
    await env.DB.exec("CREATE TABLE observed_pauses(id TEXT)");
    await env.DB.prepare(
      `CREATE TRIGGER observe_pause AFTER UPDATE OF status ON job_runs
      WHEN NEW.status='paused' BEGIN INSERT INTO observed_pauses VALUES(NEW.id); END`,
    ).run();
    const unavailable = {
      ...env,
      JOBS: {
        get: () => Promise.reject(new Error("Control API unavailable")),
      } as unknown as Workflow<JobParams>,
    };
    try {
      expect(
        (
          await request(
            "/active/action",
            "POST",
            admin,
            { action: "pause" },
            unavailable,
          )
        ).status,
      ).toBe(503);
      expect(
        await env.DB.prepare("SELECT id FROM observed_pauses").all(),
      ).toMatchObject({ results: [] });
      expect(await getRun(env.DB, "active")).toMatchObject({
        status: "running",
      });
    } finally {
      await env.DB.batch([
        env.DB.prepare("DROP TRIGGER observe_pause"),
        env.DB.prepare("DROP TABLE observed_pauses"),
      ]);
    }
  });
});

describe("D1 durable delivery state", () => {
  it("atomically excludes overlapping effects and recovers an expired lease without stale-owner completion", async () => {
    const claims = await Promise.all([
      claimEffect(env.DB, "effect", "first"),
      claimEffect(env.DB, "effect", "second"),
    ]);
    expect(claims.sort()).toEqual(["busy", "claimed"]);
    const original = await env.DB.prepare(
      "SELECT owner FROM job_effects WHERE key='effect'",
    ).first<string>("owner");
    assert(original !== null);
    await env.DB.prepare(
      "UPDATE job_effects SET lease_until=0 WHERE key='effect'",
    ).run();
    expect(await claimEffect(env.DB, "effect", "recovery")).toBe("claimed");
    await expect(finishEffect(env.DB, "effect", original)).rejects.toThrow(
      "lease was lost",
    );
    await releaseEffect(env.DB, "effect", original);
    await finishEffect(env.DB, "effect", "recovery");
    expect(await claimEffect(env.DB, "effect", "late")).toBe("suppressed");
  });

  it("expires both completed-group and winner suppression after one week", async () => {
    await mark(env.DB, ["standings:2026:1:sunday", "standings:2026:1:winner"]);
    expect(await hasMarker(env.DB, "standings:2026:1:winner")).toBe(true);
    const expiration = await env.DB.prepare(
      "SELECT expires_at FROM job_markers WHERE key='standings:2026:1:winner'",
    ).first<number>("expires_at");
    assert(expiration !== null);
    expect(expiration - Date.now()).toBeGreaterThan(7 * 86400_000 - 5000);
    expect(expiration - Date.now()).toBeLessThanOrEqual(7 * 86400_000);
    await env.DB.prepare("UPDATE job_markers SET expires_at=0").run();
    expect(await hasMarker(env.DB, "standings:2026:1:sunday")).toBe(false);
    expect(await hasMarker(env.DB, "standings:2026:1:winner")).toBe(false);
  });

  it("retains terminal history after platform retention and cannot overwrite cancellation with late completion", async () => {
    await run("historical", "errored");
    const original = await getRun(env.DB, "historical");
    assert(original);
    const expired = {
      ...env,
      JOBS: {
        get: () => Promise.reject(new Error("Workflow instance not found")),
      } as unknown as Workflow<JobParams>,
    };
    expect(await reconcile(expired, original)).toEqual(original);
    await run("cancelled", "cancelled");
    await setStatus(env.DB, "cancelled", "complete");
    expect(await getRun(env.DB, "cancelled")).toMatchObject({
      status: "cancelled",
    });
  });
});
