import { env, type WorkflowStep } from "cloudflare:workers";
import {
  introspectWorkflow,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureTokenUser,
  saveSubmission,
  listWeekSubmissions,
} from "../../src/server/db";
import { controlRun, setGlobalPause } from "../../src/server/jobs/routes";
import {
  enqueue,
  getRun,
  hasMarker,
  insertRun,
} from "../../src/server/jobs/store";
import {
  renderHashes,
  splitDiscordMessage,
} from "../../src/server/services/discord";
import { normalizeScoreboard } from "../../src/server/services/espn";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { PickemWorkflow } from "../../src/server/workflows";
import type { Env } from "../../src/server/env";
import type { JobParams } from "../../src/shared/contracts";

type InterceptState = {
  scoreboard: {
    season: { year: number; type: number };
    week: { number: number };
    events: unknown[];
  };
  espnFailures: number;
  messages: Array<{ channel: string; content: string }>;
  failures: number[];
  beforeMessage: null | (() => void | Promise<void>);
  beforeScoreboard: null | (() => Promise<void>);
};

async function discordResponse(
  request: Request,
  url: URL,
  state: InterceptState,
) {
  if (url.origin !== "https://discord.com" || request.method !== "POST") {
    throw new Error(`Unexpected outbound ${request.url}`);
  }
  const body = await request.json<{
    recipient_id?: string;
    content?: string;
  }>();
  if (
    url.pathname === "/api/v10/users/@me/channels" &&
    ["1001", "1002"].includes(body.recipient_id ?? "")
  ) {
    return Response.json({
      id: `8${body.recipient_id}`,
      type: 1,
      recipients: [{ id: body.recipient_id }],
    });
  }
  return discordMessageResponse(url, state, body.content);
}

async function discordMessageResponse(
  url: URL,
  state: InterceptState,
  content: unknown,
) {
  const channel = /^\/api\/v10\/channels\/(9999|81001|81002)\/messages$/.exec(
    url.pathname,
  )?.[1];
  if (!channel || typeof content !== "string") {
    throw new Error(`Unapproved mocked destination ${url.href}`);
  }
  if (state.beforeMessage) {
    await state.beforeMessage();
  }
  const failure = state.failures.shift();
  if (failure) {
    return Response.json(
      { retry_after: 0.01 },
      { status: failure, headers: { "Retry-After": "0.01" } },
    );
  }
  state.messages.push({ channel, content });
  return Response.json({ id: "7777" });
}

function intercept(initial = espnScoreboard()) {
  const state: InterceptState = {
    scoreboard: initial,
    espnFailures: 0,
    messages: [],
    failures: [],
    beforeMessage: null,
    beforeScoreboard: null,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === "https://site.web.api.espn.com" &&
      url.pathname.endsWith("/scoreboard")
    ) {
      if (state.beforeScoreboard) {
        await state.beforeScoreboard();
      }
      if (state.espnFailures > 0) {
        state.espnFailures--;
        return new Response("Upstream unavailable", { status: 503 });
      }
      return Response.json(state.scoreboard);
    }
    return discordResponse(request, url, state);
  });
  return state;
}

async function seed(discordId = "1001", season = 2026) {
  const user = await ensureTokenUser(env.DB, {
    discordId,
    username: `Player ${discordId}`,
  });
  await saveSubmission(env.DB, {
    userId: user.id,
    season,
    week: 1,
    picks: { "401": "home-401" },
    tiebreaker: 41,
    locked: false,
  });
  return user;
}

function linkPeriod(message: { content: string }) {
  const link = message.content.match(/\]\((https?:\/\/[^)]+)\)/)?.[1];
  if (!link) {
    throw new Error("Delivery has no submission URL");
  }
  const payload = new URL(link).searchParams.get("token")?.split(".")[1];
  if (!payload) {
    throw new Error("Submission URL has no signed payload");
  }
  const claims = JSON.parse(
    atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
  ) as {
    season: number;
    week: number;
  };
  return { season: claims.season, week: claims.week };
}

describe("native PickemWorkflow", () => {
  it("executes actual recipient delivery steps and resolves a manual null week inside the workflow", async () => {
    await seed();
    await env.DB.prepare(
      "INSERT INTO users(discord_username,created_at,updated_at) VALUES('Unlinked member',?,?)",
    )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    await seed("1002");
    const sent = intercept();
    sent.espnFailures = 2;
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await trace.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.JOBS.create({
      id,
      params: {
        type: "deliver_submission_links",
        season: 2026,
        week: null,
        runId: id,
      },
    });
    await trace.waitForStatus("complete");
    expect(sent.messages.map((item) => item.channel)).toEqual([
      "81001",
      "81002",
    ]);
    expect(sent.messages.map(linkPeriod)).toEqual([
      { season: 2026, week: 1 },
      { season: 2026, week: 1 },
    ]);
    expect(await getRun(env.DB, id)).toMatchObject({
      status: "complete",
      week: 1,
      params: { season: 2026, week: 1 },
      error: null,
    });
    const deliveries = await env.DB.prepare(
      "SELECT status FROM job_deliveries WHERE run_id=?",
    )
      .bind(id)
      .all();
    expect(deliveries.results).toEqual([
      { status: "sent" },
      { status: "sent" },
    ]);
  });

  it("suppresses an older standings snapshot when a winner commits just before lock acquisition", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: "2026-09-13T17:00:00Z", status: "STATUS_FINAL" }),
      ]),
    );
    // A concurrent sender commits its winner marker at the ownership boundary.
    await env.DB.prepare(
      `CREATE TRIGGER winner_at_lock AFTER INSERT ON job_effects
      WHEN NEW.key='standings:2026:1:lock' BEGIN
        INSERT INTO job_markers(key,expires_at) VALUES('standings:2026:1:winner',${Date.now() + 86400_000});
      END`,
    ).run();
    try {
      const id = crypto.randomUUID();
      await using trace = await introspectWorkflowInstance(env.JOBS, id);
      await env.JOBS.create({
        id,
        params: { type: "deliver_standings", season: 2026, week: 1, runId: id },
      });
      await trace.waitForStatus("complete");
      expect(sent.messages).toEqual([]);
      expect(await hasMarker(env.DB, "standings:2026:1:winner")).toBe(true);
    } finally {
      await env.DB.exec("DROP TRIGGER winner_at_lock");
    }
  });

  it("resolves a restored null week only after its original scheduled execution time", async () => {
    await seed();
    const sent = intercept();
    const id = crypto.randomUUID();
    // Native actor timers use the platform clock, not Vitest's isolated fake clock.
    const notBefore = new Date(Date.now() + 1000).toISOString();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        type: "deliver_submission_links",
        season: 2026,
        week: null,
        weekOffset: 1,
        notBefore,
        legacyJobId: id,
        runId: id,
      },
    });
    await trace.waitForStepResult({ name: "plan imported execution" });
    expect(sent.messages).toEqual([]);
    sent.scoreboard = espnScoreboard([], 8);
    await trace.waitForStatus("complete");
    expect(sent.messages.map(linkPeriod)).toEqual([{ season: 2026, week: 9 }]);
    expect(await getRun(env.DB, id)).toMatchObject({
      week: 9,
      status: "complete",
    });
  });

  it("does not resolve deferred work into a later season", async () => {
    await seed();
    const sent = intercept();
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        runId: id,
        type: "deliver_submission_links",
        season: 2026,
        week: null,
        notBefore: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await trace.waitForStepResult({ name: "plan imported execution" });
    sent.scoreboard = espnScoreboard([], 1, 2027);
    await trace.waitForStatus("errored");
    expect(sent.messages).toEqual([]);
    expect(await getRun(env.DB, id)).toMatchObject({
      season: 2026,
      week: null,
      params: { season: 2026, week: null },
    });
  });

  it("uses migrated durable parameters when an older native payload has no season", async () => {
    await seed("1001", 2025);
    const sent = intercept(espnScoreboard([], 1, 2027));
    const id = crypto.randomUUID();
    await insertRun(
      env.DB,
      {
        runId: id,
        type: "deliver_submission_links",
        season: 2025,
        week: 3,
      },
      "manual",
    );
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        runId: id,
        type: "deliver_submission_links",
        week: null,
      } as JobParams,
    });
    await trace.waitForStatus("complete");
    expect(sent.messages.map(linkPeriod)).toEqual([{ season: 2025, week: 3 }]);
  });

  it("plans a restored hash scheduler's kickoff separately from its imported dispatch time", async () => {
    await seed();
    const kickoff = new Date(Date.now() + 86400_000).toISOString();
    intercept(espnScoreboard([espnEvent({ date: kickoff })]));
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        type: "schedule_hash_delivery",
        season: 2026,
        week: 1,
        runId: id,
        notBefore: new Date(Date.now() - 3600_000).toISOString(),
      },
    });
    await trace.waitForStepResult({ name: "plan kickoff" });
    expect(await controlRun(env, id, "pause")).toMatchObject({
      plannedAt: kickoff,
      status: "paused",
    });
    await trace.waitForStatus("paused");
    expect(await controlRun(env, id, "resume")).toMatchObject({
      status: "sleeping",
    });
    await controlRun(env, id, "cancel");
    await trace.waitForStatus("terminated");
  });

  it("honors a retryable Discord failure without replaying an earlier successful recipient", async () => {
    await seed();
    await seed("1002");
    const sent = intercept();
    let requests = 0;
    sent.beforeMessage = () => {
      requests++;
      if (requests === 2) {
        sent.failures.push(429);
      }
    };
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await trace.modify(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    await env.JOBS.create({
      id,
      params: {
        type: "deliver_submission_links",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    await trace.waitForStatus("complete");
    expect(requests).toBe(3);
    expect(sent.messages.map((item) => item.channel)).toEqual([
      "81001",
      "81002",
    ]);
  });

  it("pins a resolved period across a year rollover and retries only unsent recipients", async () => {
    await seed();
    await seed("1002");
    const sent = intercept();
    let requests = 0;
    sent.beforeMessage = () => {
      requests++;
      if (requests === 2) {
        sent.failures.push(403);
      }
    };
    await using traces = await introspectWorkflow(env.JOBS);
    await traces.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    const first = await enqueue(env, "deliver_submission_links", {
      season: 2026,
      week: null,
    });
    const firstTrace = await introspectWorkflowInstance(env.JOBS, first.id);
    try {
      await firstTrace.waitForStatus("errored");
    } finally {
      await firstTrace.dispose();
    }
    expect(requests).toBe(2);
    expect(await getRun(env.DB, first.id)).toMatchObject({
      status: "errored",
      season: 2026,
      week: 1,
      params: { season: 2026, week: 1 },
    });
    expect((await getRun(env.DB, first.id))?.error).toContain("403");
    sent.scoreboard = espnScoreboard([], 2, 2027);
    const retried = await controlRun(env, first.id, "retry");
    const nextTrace = await introspectWorkflowInstance(env.JOBS, retried.id);
    try {
      await nextTrace.waitForStatus("complete");
    } finally {
      await nextTrace.dispose();
    }
    expect(retried.parentId).toBe(first.id);
    expect(sent.messages.map(linkPeriod)).toEqual([
      { season: 2026, week: 1 },
      { season: 2026, week: 1 },
    ]);
    expect(sent.messages.map((item) => item.channel)).toEqual([
      "81001",
      "81002",
    ]);
    expect(
      await env.DB.prepare(
        "SELECT status FROM job_deliveries WHERE run_id=? ORDER BY key",
      )
        .bind(retried.id)
        .all(),
    ).toMatchObject({
      results: [{ status: "suppressed" }, { status: "sent" }],
    });
  });

  it("stops after bounded retry exhaustion with a visible delivery error", async () => {
    await seed();
    const sent = intercept();
    sent.failures.push(503, 503, 503, 503, 503, 503);
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await trace.modify(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    await env.JOBS.create({
      id,
      params: { type: "deliver_hashes", season: 2026, week: 1, runId: id },
    });
    await trace.waitForStatus("errored");
    expect(sent.messages).toEqual([]);
    expect(sent.failures).toEqual([503]);
    expect(await getRun(env.DB, id)).toMatchObject({
      status: "errored",
    });
    expect((await getRun(env.DB, id))?.error).toContain("exhausted retries");
  });

  it("sleeps durably until kickoff and hashes submissions saved after scheduling", async () => {
    const user = await seed();
    const scoreboard = espnScoreboard([
      espnEvent({ date: new Date(Date.now() + 4000).toISOString() }),
    ]);
    const sent = intercept(scoreboard);
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        type: "schedule_hash_delivery",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    await trace.waitForStepResult({ name: "plan kickoff" });
    expect(sent.messages).toEqual([]);
    await saveSubmission(env.DB, {
      userId: user.id,
      season: 2026,
      week: 1,
      picks: { "401": "away-401" },
      tiebreaker: 50,
      locked: false,
    });
    const expected = await renderHashes(
      await listWeekSubmissions(env.DB, { season: 2026, week: 1 }),
      normalizeScoreboard(scoreboard),
    );
    await trace.waitForStatus("complete");
    expect(sent.messages).toEqual([{ channel: "9999", content: expected }]);
  }, 15_000);

  it("delivers a scheduled hash job immediately when its kickoff has already passed", async () => {
    await seed();
    const scoreboard = espnScoreboard([
      espnEvent({ date: new Date(Date.now() - 3600_000).toISOString() }),
    ]);
    const sent = intercept(scoreboard);
    const expected = await renderHashes(
      await listWeekSubmissions(env.DB, { season: 2026, week: 1 }),
      normalizeScoreboard(scoreboard),
    );
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        type: "schedule_hash_delivery",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    await trace.waitForStatus("complete");
    expect(sent.messages).toEqual([{ channel: "9999", content: expected }]);
  });

  it("retains a kickoff computed during pause so the resumed job can run now", async () => {
    await seed();
    const kickoff = new Date(Date.now() + 86400_000).toISOString();
    const sent = intercept(espnScoreboard([espnEvent({ date: kickoff })]));
    const id = crypto.randomUUID();
    sent.beforeScoreboard = async () => {
      sent.beforeScoreboard = null;
      // Pause fences D1 while the current native step finishes its fetch.
      await env.DB.prepare("UPDATE job_runs SET status='paused' WHERE id=?")
        .bind(id)
        .run();
    };
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    const instance = await env.JOBS.create({
      id,
      params: {
        type: "schedule_hash_delivery",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    await trace.waitForStepResult({ name: "plan kickoff" });
    await instance.pause();
    await trace.waitForStatus("paused");
    expect(await getRun(env.DB, id)).toMatchObject({
      status: "paused",
      plannedAt: kickoff,
    });
    expect(await controlRun(env, id, "resume")).toMatchObject({
      status: "sleeping",
    });
    const child = await controlRun(env, id, "run_now");
    await using replacement = await introspectWorkflowInstance(
      env.JOBS,
      child.id,
    );
    await replacement.waitForStatus("complete");
    expect(sent.messages).toEqual([
      {
        channel: "9999",
        content: await renderHashes(
          await listWeekSubmissions(env.DB, { season: 2026, week: 1 }),
          normalizeScoreboard(sent.scoreboard),
        ),
      },
    ]);
    expect(await getRun(env.DB, id)).toMatchObject({ status: "superseded" });
  });

  it("applies global pause to a run already between recipient deliveries", async () => {
    await seed();
    const second = await seed("1002");
    const sent = intercept();
    let paused = false;
    sent.beforeMessage = async () => {
      if (!paused) {
        paused = true;
        await setGlobalPause(env, true);
      }
    };
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await trace.modify(async (modifier) => {
      await modifier.disableSleeps();
    });
    await env.JOBS.create({
      id,
      params: {
        type: "deliver_submission_links",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    expect(
      await trace.waitForStepResult({ name: `link ${second.id} attempt 0` }),
    ).toMatchObject({ state: "paused" });
    expect(sent.messages.map((item) => item.channel)).toEqual(["81001"]);
    await setGlobalPause(env, false);
    await trace.waitForStatus("complete");
    expect(sent.messages.map((item) => item.channel)).toEqual([
      "81001",
      "81002",
    ]);
  });

  it("supports native pause/resume/cancel and rejects run_now for unrelated jobs", async () => {
    await seed();
    intercept(
      espnScoreboard([
        espnEvent({ date: new Date(Date.now() + 86400_000).toISOString() }),
      ]),
    );
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: {
        type: "schedule_hash_delivery",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    await trace.waitForStepResult({ name: "plan kickoff" });
    expect(await controlRun(env, id, "pause")).toMatchObject({
      status: "paused",
    });
    await trace.waitForStatus("paused");
    await expect(controlRun(env, id, "pause")).rejects.toMatchObject({
      status: 409,
    });
    expect(await controlRun(env, id, "resume")).toMatchObject({
      status: "sleeping",
    });
    expect((await (await env.JOBS.get(id)).status()).status).toBe("running");
    expect(await controlRun(env, id, "cancel")).toMatchObject({
      status: "cancelled",
    });
    await trace.waitForStatus("terminated");
    await expect(controlRun(env, id, "run_now")).rejects.toMatchObject({
      status: 409,
    });
    await expect(controlRun(env, id, "resume")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("runs a sleeping hash job immediately by terminating its old instance with no later duplicate", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: new Date(Date.now() + 86400_000).toISOString() }),
      ]),
    );
    await using all = await introspectWorkflow(env.JOBS);
    const original = await enqueue(env, "schedule_hash_delivery", {
      season: 2026,
      week: 1,
    });
    const trace = await introspectWorkflowInstance(env.JOBS, original.id);
    try {
      await trace.waitForStepResult({ name: "plan kickoff" });
      const immediate = await controlRun(env, original.id, "run_now");
      const child = await introspectWorkflowInstance(env.JOBS, immediate.id);
      try {
        await child.waitForStatus("complete");
      } finally {
        await child.dispose();
      }
      await trace.waitForStatus("terminated");
      expect(await getRun(env.DB, original.id)).toMatchObject({
        status: "superseded",
      });
      expect(immediate).toMatchObject({
        type: "deliver_hashes",
        parentId: original.id,
      });
      expect(sent.messages).toHaveLength(1);
      await expect(
        controlRun(env, original.id, "run_now"),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await trace.dispose();
    }
  });

  it("suppresses overlapping manual standings and all later groups once a winner was delivered", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: "2026-09-13T17:00:00Z", status: "STATUS_FINAL" }),
      ]),
    );
    await using all = await introspectWorkflow(env.JOBS);
    await all.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
    });
    const runs = await Promise.all([
      enqueue(env, "deliver_standings", { season: 2026, week: 1 }),
      enqueue(env, "deliver_standings", { season: 2026, week: 1 }),
    ]);
    for (const run of runs) {
      const trace = await introspectWorkflowInstance(env.JOBS, run.id);
      try {
        await trace.waitForStatus("complete");
      } finally {
        await trace.dispose();
      }
    }
    expect(sent.messages).toHaveLength(1);
    expect(await hasMarker(env.DB, "standings:2026:1:winner")).toBe(true);
    sent.scoreboard = espnScoreboard([
      espnEvent({ date: "2026-09-13T17:00:00Z", status: "STATUS_FINAL" }),
      espnEvent({
        id: "402",
        date: "2026-09-14T23:00:00Z",
        status: "STATUS_FINAL",
      }),
    ]);
    const later = await enqueue(env, "deliver_standings", {
      season: 2026,
      week: 1,
    });
    const trace = await introspectWorkflowInstance(env.JOBS, later.id);
    try {
      await trace.waitForStatus("complete");
    } finally {
      await trace.dispose();
    }
    expect(sent.messages).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT status FROM job_deliveries WHERE run_id=?")
        .bind(later.id)
        .all(),
    ).toMatchObject({ results: [{ status: "suppressed" }] });
  });

  it("isolates standings snapshots and winner suppression for the same week across seasons", async () => {
    await seed();
    await seed("1002", 2025);
    const sent = intercept();
    for (const season of [2026, 2025]) {
      sent.scoreboard = espnScoreboard(
        [espnEvent({ date: "2026-09-13T17:00:00Z", status: "STATUS_FINAL" })],
        1,
        season,
      );
      const id = crypto.randomUUID();
      await using trace = await introspectWorkflowInstance(env.JOBS, id);
      await env.JOBS.create({
        id,
        params: { type: "deliver_standings", season, week: 1, runId: id },
      });
      await trace.waitForStatus("complete");
      expect(await hasMarker(env.DB, `standings:${season}:1:winner`)).toBe(
        true,
      );
    }
    expect(sent.messages.map((item) => item.channel)).toEqual(["9999", "9999"]);
    expect(sent.messages[0]?.content).toContain("Player 1001");
    expect(sent.messages[0]?.content).not.toContain("Player 1002");
    expect(sent.messages[1]?.content).toContain("Player 1002");
    expect(sent.messages[1]?.content).not.toContain("Player 1001");
  });

  it("resumes standings after a native pause and reacquires an expired ownership lease", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: "2026-09-13T17:00:00Z", status: "STATUS_FINAL" }),
      ]),
    );
    sent.failures.push(429);
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: { type: "deliver_standings", season: 2026, week: 1, runId: id },
    });
    expect(
      await trace.waitForStepResult({ name: "standings part 0 attempt 0" }),
    ).toMatchObject({ state: "retry" });
    await controlRun(env, id, "pause");
    await trace.waitForStatus("paused");
    await env.DB.prepare(
      "UPDATE job_effects SET owner='abandoned',lease_until=0 WHERE key='standings:2026:1:lock'",
    ).run();
    await controlRun(env, id, "resume");
    await trace.waitForStatus("complete");
    expect(sent.messages.map((message) => message.channel)).toEqual(["9999"]);
    expect(sent.messages[0]?.content).toContain("Player 1001");
    expect(await hasMarker(env.DB, "standings:2026:1:winner")).toBe(true);
  });

  it("wakes a registered delivery when rolling back a failed native pause", async () => {
    await seed();
    await seed("1002");
    const sent = intercept();
    await setGlobalPause(env, true);
    const id = crypto.randomUUID();
    const trace = await introspectWorkflowInstance(env.JOBS, id);
    onTestFinished(() => trace.dispose());
    await env.JOBS.create({
      id,
      params: {
        type: "deliver_submission_links",
        season: 2026,
        week: 1,
        runId: id,
      },
    });
    expect(await trace.waitForStepResult({ name: "dispatch gate 0" })).toBe(
      true,
    );
    // Reproduce the durable boundary: the gate is open but its waiter still needs
    // notification, as when a delivery observes the fence before pause fails.
    await env.DB.prepare("UPDATE job_settings SET paused=0 WHERE id=1").run();
    const instance = await env.JOBS.get(id);
    const bindings = {
      ...env,
      JOBS: {
        get: () =>
          Promise.resolve({
            status: instance.status.bind(instance),
            sendEvent: instance.sendEvent.bind(instance),
            pause: () =>
              Promise.reject(new Error("Injected pause transport failure")),
          }),
      },
    } as unknown as Env;
    await expect(controlRun(bindings, id, "pause")).rejects.toMatchObject({
      status: 503,
    });
    await trace.waitForStatus("complete");
    expect(sent.messages.map((item) => item.channel)).toEqual([
      "81001",
      "81002",
    ]);
    expect(await getRun(env.DB, id)).toMatchObject({ status: "complete" });
  });

  it("keeps a multipart hash snapshot stable when a retry follows later submission changes", async () => {
    const user = await seed();
    for (let index = 0; index < 35; index++) {
      await seed(String(2000 + index));
    }
    const sent = intercept();
    const expected = splitDiscordMessage(
      await renderHashes(
        await listWeekSubmissions(env.DB, { season: 2026, week: 1 }),
        normalizeScoreboard(sent.scoreboard),
      ),
    );
    expect(expected.length).toBeGreaterThan(1);
    let requests = 0;
    sent.beforeMessage = () => {
      requests++;
      if (requests === 2) {
        sent.failures.push(403);
      }
    };
    await using all = await introspectWorkflow(env.JOBS);
    const original = await enqueue(env, "deliver_hashes", {
      season: 2026,
      week: 1,
    });
    const failed = await introspectWorkflowInstance(env.JOBS, original.id);
    try {
      await failed.waitForStatus("errored");
    } finally {
      await failed.dispose();
    }
    await saveSubmission(env.DB, {
      userId: user.id,
      season: 2026,
      week: 1,
      picks: { "401": "away-401" },
      tiebreaker: 99,
      locked: false,
    });
    const retried = await controlRun(env, original.id, "retry");
    const trace = await introspectWorkflowInstance(env.JOBS, retried.id);
    try {
      await trace.waitForStatus("complete");
    } finally {
      await trace.dispose();
    }
    expect(sent.messages.map((item) => item.content)).toEqual(expected);
    await expect(controlRun(env, original.id, "retry")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("records suppression rather than failing when no game groups are complete", async () => {
    const sent = intercept();
    const id = crypto.randomUUID();
    await using trace = await introspectWorkflowInstance(env.JOBS, id);
    await env.JOBS.create({
      id,
      params: { type: "deliver_standings", season: 2026, week: 1, runId: id },
    });
    await trace.waitForStatus("complete");
    expect(sent.messages).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT status,error FROM job_deliveries WHERE run_id=?",
      )
        .bind(id)
        .all(),
    ).toMatchObject({ results: [{ status: "suppressed" }] });
  });
});

// Miniflare's installed native binding does not emit cron metadata. This small
// semantic harness covers that event boundary; engine durability is tested above.
describe("scheduled workflow event semantics", () => {
  const steps = {
    do: async (
      _name: string,
      configOrCallback: unknown,
      callback?: () => Promise<unknown>,
    ) => (callback ?? (configOrCallback as () => Promise<unknown>))(),
  } as unknown as WorkflowStep;

  async function scheduledLinks(
    id: string,
    scheduledAt = "2026-09-08T13:00:00Z",
  ) {
    const workflow = Object.create(PickemWorkflow.prototype) as PickemWorkflow;
    Object.defineProperty(workflow, "env", { value: env });
    return workflow.run(
      {
        instanceId: id,
        timestamp: new Date("2027-09-08T13:00:00Z"),
        workflowName: "test",
        schedule: {
          cron: "0 13 * * TUE",
          scheduledTime: Date.parse(scheduledAt),
        },
        payload: { runId: id, type: "deliver_hashes", season: 2025, week: 8 },
      },
      steps,
    );
  }

  it("sends week one before the first kickoff instead of skipping opening week", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: new Date(Date.now() + 86400_000).toISOString() }),
      ]),
    );
    await scheduledLinks(crypto.randomUUID());
    expect(sent.messages.map(linkPeriod)).toEqual([{ season: 2026, week: 1 }]);
  });

  it("uses the starting year of the original January schedule", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard(
        [espnEvent({ date: new Date(Date.now() + 86400_000).toISOString() })],
        18,
        2026,
      ),
    );
    await scheduledLinks(crypto.randomUUID(), "2027-01-05T13:00:00Z");
    expect(sent.messages.map(linkPeriod)).toEqual([{ season: 2026, week: 18 }]);
  });

  it("never wraps completed week eighteen into another season", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard(
        [espnEvent({ date: new Date(Date.now() - 3600_000).toISOString() })],
        18,
      ),
    );
    await expect(scheduledLinks(crypto.randomUUID())).rejects.toThrow(
      "regular season",
    );
    expect(sent.messages).toEqual([]);
  });

  it.each([1, 3])(
    "blocks automatic links outside regular-season metadata type %s",
    async (type) => {
      await seed();
      const sent = intercept();
      sent.scoreboard.season.type = type;
      await expect(scheduledLinks(crypto.randomUUID())).rejects.toThrow(
        "regular season",
      );
      expect(sent.messages).toEqual([]);
    },
  );

  it("fences an automatic run whose original schedule belongs to another season", async () => {
    await seed();
    const sent = intercept(espnScoreboard([], 1, 2027));
    await expect(scheduledLinks(crypto.randomUUID())).rejects.toThrow(
      "regular season",
    );
    expect(sent.messages).toEqual([]);
  });

  it("uses native schedule metadata rather than manual payload and sends next week's link", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: new Date(Date.now() - 3600_000).toISOString() }),
      ]),
    );
    const id = crypto.randomUUID();
    const workflow = Object.create(PickemWorkflow.prototype) as PickemWorkflow;
    Object.defineProperty(workflow, "env", { value: env });
    await workflow.run(
      {
        instanceId: id,
        timestamp: new Date("2026-09-15T13:00:00Z"),
        workflowName: "test",
        schedule: {
          cron: "0 13 * * TUE",
          scheduledTime: Date.parse("2026-09-15T13:00:00Z"),
        },
        payload: { runId: id, type: "deliver_hashes", season: 2025, week: 8 },
      },
      steps,
    );
    expect(sent.messages.map(linkPeriod)).toEqual([{ season: 2026, week: 2 }]);
    expect(await getRun(env.DB, id)).toMatchObject({
      type: "deliver_submission_links",
      source: "scheduled",
      week: 2,
      status: "complete",
    });
  });

  it("preserves unresolved scheduled next-week policy through multiple retry children", async () => {
    await seed();
    const sent = intercept(
      espnScoreboard([
        espnEvent({ date: new Date(Date.now() - 3600_000).toISOString() }),
      ]),
    );
    sent.espnFailures = 1;
    const id = crypto.randomUUID();
    const workflow = Object.create(PickemWorkflow.prototype) as PickemWorkflow;
    Object.defineProperty(workflow, "env", { value: env });
    await expect(
      workflow.run(
        {
          instanceId: id,
          timestamp: new Date("2026-09-15T13:00:00Z"),
          workflowName: "test",
          schedule: {
            cron: "0 13 * * TUE",
            scheduledTime: Date.parse("2026-09-15T13:00:00Z"),
          },
          payload: {
            runId: id,
            type: "deliver_submission_links",
            season: 2026,
            week: null,
          },
        },
        steps,
      ),
    ).rejects.toThrow("503");
    await using all = await introspectWorkflow(env.JOBS);
    await all.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    sent.espnFailures = 5;
    const retry = await controlRun(env, id, "retry");
    const failed = await introspectWorkflowInstance(env.JOBS, retry.id);
    try {
      await failed.waitForStatus("errored");
    } finally {
      await failed.dispose();
    }
    sent.espnFailures = 0;
    const next = await controlRun(env, retry.id, "retry");
    const complete = await introspectWorkflowInstance(env.JOBS, next.id);
    try {
      await complete.waitForStatus("complete");
    } finally {
      await complete.dispose();
    }
    expect(sent.messages.map(linkPeriod)).toEqual([{ season: 2026, week: 2 }]);
    expect(await getRun(env.DB, next.id)).toMatchObject({ week: 2 });
  });

  it("records disabled schedules as a permanent failure without fetching or sending", async () => {
    const id = crypto.randomUUID();
    const workflow = Object.create(PickemWorkflow.prototype) as PickemWorkflow;
    Object.defineProperty(workflow, "env", {
      value: { ...env, SCHEDULES_ENABLED: "false" },
    });
    await expect(
      workflow.run(
        {
          instanceId: id,
          timestamp: new Date(),
          workflowName: "test",
          schedule: { cron: "0 13 * * TUE", scheduledTime: Date.now() },
          payload: {
            runId: id,
            type: "deliver_submission_links",
            season: 2026,
            week: null,
          },
        },
        steps,
      ),
    ).rejects.toThrow("disabled by policy");
    expect(await getRun(env.DB, id)).toMatchObject({
      status: "errored",
      source: "scheduled",
    });
    expect((await getRun(env.DB, id))?.error).toContain("disabled by policy");
  });
});
