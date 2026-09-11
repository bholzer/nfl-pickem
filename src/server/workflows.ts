import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  JOB_TYPES,
  type JobParams,
  type SeasonWeek,
} from "../shared/contracts";
import { seasonForDate, validSeason, validWeek } from "../shared/season";
import type { Env } from "./env";
import { listUsers, listWeekSubmissions } from "./db";
import { getCurrentPeriod, fetchScoreboard } from "./services/espn";
import { calculateStandings, earliestGameTime } from "./services/scoring";
import { completedGroups } from "./services/groups";
import {
  DiscordError,
  renderHashes,
  renderStandings,
  sendChannelMessage,
  sendSubmissionLink,
  splitDiscordMessage,
} from "./services/discord";
import {
  claimEffect,
  deliveryMessage,
  errorMessage,
  finishEffect,
  getRun,
  hasMarker,
  insertRun,
  mark,
  nowIso,
  recordDelivery,
  releaseEffect,
  requireRun,
  schedules,
  setStatus,
  terminal,
} from "./jobs/store";

const ioRetry = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
} satisfies WorkflowStepConfig;

function workflowParams(event: WorkflowEvent<JobParams>): JobParams {
  const scheduled = event.schedule;
  const type = scheduled
    ? schedules.find((item) => item.cron === scheduled.cron)?.type
    : event.payload.type;
  if (!type || !JOB_TYPES.includes(type)) {
    throw new NonRetryableError("Unknown workflow schedule or job type");
  }
  return scheduled
    ? {
        type,
        season: seasonForDate(new Date(scheduled.scheduledTime)),
        week: null,
        runId: event.instanceId,
      }
    : {
        ...event.payload,
        type,
        runId: event.instanceId,
        weekOffset: event.payload.weekOffset ?? 0,
      };
}

function validateTiming(weekOffset: unknown, notBefore: string | undefined) {
  if (weekOffset !== undefined && weekOffset !== 0 && weekOffset !== 1) {
    throw new NonRetryableError("Invalid week resolution policy");
  }
  if (notBefore !== undefined && !Number.isFinite(Date.parse(notBefore))) {
    throw new NonRetryableError("Invalid planned execution time");
  }
}

async function resolvePeriod(params: JobParams): Promise<SeasonWeek> {
  if (!validSeason(params.season)) {
    throw new NonRetryableError("A valid pinned season is required");
  }
  if (params.week !== null) {
    if (!validWeek(params.week)) {
      throw new NonRetryableError("Week is outside the regular season (1–18)");
    }
    return { season: params.season, week: params.week };
  }
  const current = await getCurrentPeriod();
  if (!current || current.season !== params.season) {
    throw new NonRetryableError(
      "Current week cannot resolve outside the pinned regular season; create a job with an explicit season and week",
    );
  }
  const offset = await linkWeekOffset(params, current);
  const week = current.week + offset;
  if (!validWeek(week)) {
    throw new NonRetryableError(
      "Resolved week is outside the regular season (1–18)",
    );
  }
  return { season: params.season, week };
}

async function linkWeekOffset(params: JobParams, current: SeasonWeek) {
  if (params.weekOffset !== undefined) {
    return params.weekOffset;
  }
  if (params.type !== "deliver_submission_links") {
    return 0;
  }
  const scoreboard = await fetchScoreboard(current);
  const kickoff = earliestGameTime(scoreboard);
  return kickoff && Date.parse(kickoff) <= Date.now() ? 1 : 0;
}

type Delivery = {
  id: string;
  key: string;
  send: () => Promise<void>;
  beforeSend?: () => Promise<"ready" | "busy" | "suppressed">;
  suppressionTtl?: number | null;
};

type DeliveryAttempt = Delivery & {
  suppressionTtl: number | null;
  attempt: number;
};

type DeliveryResult = {
  state: "paused" | "busy" | "done" | "retry";
  delay: number;
};

export class PickemWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const id = event.instanceId;
    try {
      const params = await step.do("initialize run", ioRetry, async () => {
        const existing = await getRun(this.env.DB, id);
        const params = existing?.params ?? workflowParams(event);
        if (!validSeason(params.season)) {
          throw new NonRetryableError("A valid pinned season is required");
        }
        validateTiming(params.weekOffset, params.notBefore);
        await insertRun(
          this.env.DB,
          params,
          event.schedule ? "scheduled" : "manual",
        );
        if (event.schedule && this.env.SCHEDULES_ENABLED !== "true") {
          throw new NonRetryableError("Scheduled jobs are disabled by policy");
        }
        if (this.env.DISCORD_SEND_ENABLED !== "true") {
          throw new NonRetryableError("Discord sends are disabled by policy");
        }
        return params;
      });
      await this.gate(step, id, "dispatch");
      if (params.notBefore) {
        await step.do("plan imported execution", ioRetry, async () => {
          // planned_at is reserved for a computed kickoff; imported dispatch
          // timing remains in params.notBefore so rollback cannot confuse them.
          await this.env.DB.prepare(
            "UPDATE job_runs SET status='sleeping',updated_at=? WHERE id=? AND status='running'",
          )
            .bind(nowIso(), id)
            .run();
        });
        await step.sleep(
          "wait for imported execution",
          Math.max(0, Date.parse(params.notBefore) - Date.now()),
        );
        await this.gate(step, id, "imported execution");
      }
      const period = await step.do(
        "resolve season and week",
        ioRetry,
        async () => {
          // D1 also covers a crash after commit but before the workflow checkpoint,
          // and migrated native executions with cached yearless initialization.
          const stored = await requireRun(this.env.DB, id);
          const period = await resolvePeriod(stored.params);
          await this.env.DB.prepare(
            "UPDATE job_runs SET season=?,week=?,params=?,updated_at=? WHERE id=?",
          )
            .bind(
              period.season,
              period.week,
              JSON.stringify({ ...stored.params, ...period }),
              nowIso(),
              id,
            )
            .run();
          return period;
        },
      );
      const scope = await step.do("delivery scope", async () => {
        const scope = await this.env.DB.prepare(
          "SELECT delivery_scope FROM job_runs WHERE id=?",
        )
          .bind(id)
          .first<string>("delivery_scope");
        if (scope === null) {
          throw new Error(`Job ${id} is missing its delivery scope`);
        }
        return scope;
      });

      if (params.type === "schedule_hash_delivery") {
        const kickoff = await step.do("plan kickoff", ioRetry, async () => {
          const kickoff = earliestGameTime(await fetchScoreboard(period));
          if (!kickoff) {
            throw new NonRetryableError(
              "No kickoff is available for hash delivery",
            );
          }
          await this.env.DB.prepare(
            "UPDATE job_runs SET planned_at=?,status=CASE WHEN status='paused' THEN status ELSE 'sleeping' END,updated_at=? WHERE id=? AND status IN ('running','paused')",
          )
            .bind(kickoff, nowIso(), id)
            .run();
          return kickoff;
        });
        // Late starts and resumed executions may already be past kickoff.
        // sleepUntil rejects past timestamps; a zero relative wait is valid.
        await step.sleep(
          "wait for kickoff",
          Math.max(0, Date.parse(kickoff) - Date.now()),
        );
      }
      await this.gate(step, id, "delivery");
      await this.dispatchDelivery(step, {
        id,
        period,
        scope,
        type: params.type,
      });
      await step.do("complete run", ioRetry, () =>
        setStatus(this.env.DB, id, "complete"),
      );
      return { runId: id, ...period };
    } catch (error) {
      // Operator controls fence D1 before interrupting the native execution.
      // Do not record/cache a failure step for a pause or termination interrupt.
      const status = await this.env.DB.prepare(
        "SELECT status FROM job_runs WHERE id=?",
      )
        .bind(id)
        .first<string>("status");
      if (status === "paused" || (status && terminal[status])) {
        throw error;
      }
      await step.do("record failure", ioRetry, () =>
        setStatus(this.env.DB, id, "errored", errorMessage(error)),
      );
      throw error;
    }
  }

  private async dispatchDelivery(
    step: WorkflowStep,
    {
      id,
      period,
      scope,
      type,
    }: {
      id: string;
      period: SeasonWeek;
      scope: string;
      type: JobParams["type"];
    },
  ) {
    if (type === "deliver_submission_links") {
      const users = await step.do("load recipients", ioRetry, () =>
        listUsers(this.env.DB, true),
      );
      for (const user of users) {
        await this.deliver(step, `link ${user.id}`, {
          id,
          key: `${scope}:link:${user.id}`,
          send: async () => {
            if (!user.discordId) {
              throw new NonRetryableError(
                `User ${user.id} has no Discord identity`,
              );
            }
            await sendSubmissionLink(this.env, user, period);
          },
        });
      }
      return;
    }
    if (type === "deliver_standings") {
      await this.standings(step, id, period);
      return;
    }
    // This persisted read deliberately happens after the durable kickoff sleep.
    const message = await step.do("read hashes at delivery", ioRetry, () =>
      deliveryMessage(this.env.DB, `${scope}:hash`, async () => {
        const submissions = await listWeekSubmissions(this.env.DB, period);
        const scoreboard = await fetchScoreboard(period);
        try {
          return await renderHashes(submissions, scoreboard);
        } catch (error) {
          if (error instanceof DiscordError && !error.retryable) {
            throw new NonRetryableError(errorMessage(error));
          }
          throw error;
        }
      }),
    );
    for (const [index, part] of splitDiscordMessage(message).entries()) {
      await this.deliver(step, `hash part ${index}`, {
        id,
        key: `${scope}:hash:${index}`,
        send: () =>
          sendChannelMessage(this.env, this.env.DISCORD_CHANNEL_ID, part),
      });
    }
  }

  private async gate(step: WorkflowStep, id: string, name: string) {
    for (let index = 0; ; index++) {
      const paused = await step.do(`${name} gate ${index}`, ioRetry, async () =>
        this.checkGate(id),
      );
      if (!paused) {
        return;
      }
      await step.waitForEvent(`${name} paused ${index}`, {
        type: "delivery-resume",
        timeout: "365 days",
      });
    }
  }

  private async checkGate(id: string) {
    // Register the wait atomically with reading the global flag. Unpause either
    // observes this registration and sends an event, or this query sees unpaused.
    const run = await this.env.DB.prepare(
      `UPDATE job_runs SET gate_paused =
      CASE WHEN status='paused' OR (SELECT paused FROM job_settings WHERE id=1)=1 OR ?=1 THEN 1 ELSE 0 END
      WHERE id=? RETURNING status,source,season,gate_paused`,
    )
      .bind(this.env.MAINTENANCE_MODE === "true" ? 1 : 0, id)
      .first<{
        status: string;
        source: string;
        season: number;
        gate_paused: number;
      }>();
    if (!run || terminal[run.status]) {
      throw new NonRetryableError("Run is no longer active");
    }
    if (run.gate_paused === 1) {
      return true;
    }
    if (this.env.DISCORD_SEND_ENABLED !== "true") {
      throw new NonRetryableError("Discord sends are disabled by policy");
    }
    await this.checkAutomaticSeason(run);
    await setStatus(this.env.DB, id, "running");
    return false;
  }

  private async checkAutomaticSeason(run: { source: string; season: number }) {
    if (run.source !== "scheduled") {
      return;
    }
    if (this.env.SCHEDULES_ENABLED !== "true") {
      throw new NonRetryableError("Scheduled jobs are disabled by policy");
    }
    const current = await getCurrentPeriod();
    if (!current || current.season !== run.season) {
      throw new NonRetryableError(
        "Automatic delivery is outside its regular season",
      );
    }
  }

  private async deliver(
    step: WorkflowStep,
    name: string,
    { id, key, send, beforeSend, suppressionTtl = null }: Delivery,
  ) {
    for (let attempt = 0, wait = 0; ; wait++) {
      const result = await step.do(
        `${name} attempt ${wait}`,
        {
          retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
          timeout: "1 minute",
        },
        () =>
          this.attemptDelivery({
            id,
            key,
            send,
            beforeSend,
            suppressionTtl,
            attempt,
          }),
      );
      if (result.state === "done") {
        return;
      }
      if (result.state === "retry") {
        attempt++;
      }
      if (result.state === "paused") {
        await step.waitForEvent(`${name} paused ${wait}`, {
          type: "delivery-resume",
          timeout: "365 days",
        });
      } else {
        await step.sleep(`${name} ${result.state} ${wait}`, result.delay);
      }
    }
  }

  private async attemptDelivery(
    delivery: DeliveryAttempt,
  ): Promise<DeliveryResult> {
    const { id, key, beforeSend, suppressionTtl } = delivery;
    if (await this.checkGate(id)) {
      return { state: "paused", delay: 30_000 };
    }
    const prerequisite = await beforeSend?.();
    if (prerequisite === "busy") {
      return { state: "busy", delay: 30_000 };
    }
    if (prerequisite === "suppressed") {
      await recordDelivery(this.env.DB, id, key, "suppressed");
      return { state: "done", delay: 0 };
    }
    const owner = crypto.randomUUID();
    const claim = await claimEffect(this.env.DB, key, owner, suppressionTtl);
    if (claim === "busy") {
      return { state: "busy", delay: 30_000 };
    }
    if (claim === "suppressed") {
      await recordDelivery(this.env.DB, id, key, "suppressed");
      return { state: "done", delay: 0 };
    }
    return this.sendClaimedDelivery(delivery, owner);
  }

  private async sendClaimedDelivery(
    { id, key, send, attempt }: DeliveryAttempt,
    owner: string,
  ): Promise<DeliveryResult> {
    try {
      // Re-read global pause immediately before the remote effect, including runs
      // that were already delivering when the operator paused dispatch.
      if (await this.checkGate(id)) {
        await releaseEffect(this.env.DB, key, owner);
        return { state: "paused", delay: 30_000 };
      }
      await recordDelivery(this.env.DB, id, key, "sending");
      await send();
      await finishEffect(this.env.DB, key, owner);
      await recordDelivery(this.env.DB, id, key, "sent");
      return { state: "done", delay: 0 };
    } catch (error) {
      await releaseEffect(this.env.DB, key, owner);
      await recordDelivery(this.env.DB, id, key, "failed", errorMessage(error));
      if (
        error instanceof NonRetryableError ||
        (error instanceof DiscordError && !error.retryable)
      ) {
        throw new NonRetryableError(errorMessage(error));
      }
      if (attempt >= 4) {
        throw new NonRetryableError(
          `Delivery exhausted retries: ${errorMessage(error)}`,
        );
      }
      const delay =
        error instanceof DiscordError && error.retryAfterSeconds !== null
          ? Math.max(error.retryAfterSeconds * 1000, 1000)
          : 5000 * 2 ** attempt;
      return { state: "retry", delay };
    }
  }

  private async standings(step: WorkflowStep, id: string, period: SeasonWeek) {
    const data = await step.do("read standings", ioRetry, async () => {
      const scoreboard = await fetchScoreboard(period);
      const groups = completedGroups(scoreboard);
      if (!groups.length) {
        return { groups, winner: false, message: "" };
      }
      const snapshot = await deliveryMessage(
        this.env.DB,
        `standings:${period.season}:${period.week}:${groups.join("_")}:${this.env.DISCORD_CHANNEL_ID}:snapshot`,
        async () => {
          const standings = calculateStandings(
            await listWeekSubmissions(this.env.DB, period),
            scoreboard,
          );
          try {
            return JSON.stringify({
              winner: standings.some((item) => item.winner),
              message: renderStandings(standings, period),
            });
          } catch (error) {
            if (error instanceof DiscordError && !error.retryable) {
              throw new NonRetryableError(errorMessage(error));
            }
            throw error;
          }
        },
        7 * 86400_000,
      );
      return {
        groups,
        ...(JSON.parse(snapshot) as { winner: boolean; message: string }),
      };
    });
    const groupKey = `standings:${period.season}:${period.week}:${data.groups.join("_")}`;
    const winnerKey = `standings:${period.season}:${period.week}:winner`;
    if (!data.groups.length) {
      await step.do("no completed groups", () =>
        recordDelivery(
          this.env.DB,
          id,
          groupKey,
          "suppressed",
          "No game groups are complete",
        ),
      );
      return;
    }
    // Serialize all group snapshots for a week, not merely identical snapshots.
    const lock = `standings:${period.season}:${period.week}:lock`;
    try {
      for (const [index, part] of splitDiscordMessage(data.message).entries()) {
        await this.deliver(step, `standings part ${index}`, {
          id,
          key: `${groupKey}:${this.env.DISCORD_CHANNEL_ID}:${index}`,
          send: () =>
            sendChannelMessage(this.env, this.env.DISCORD_CHANNEL_ID, part),
          beforeSend: async () => {
            if (
              (await hasMarker(this.env.DB, groupKey)) ||
              (await hasMarker(this.env.DB, winnerKey))
            ) {
              return "suppressed";
            }
            if ((await claimEffect(this.env.DB, lock, id)) !== "claimed") {
              return "busy";
            }
            return (await hasMarker(this.env.DB, groupKey)) ||
              (await hasMarker(this.env.DB, winnerKey))
              ? "suppressed"
              : "ready";
          },
          suppressionTtl: 7 * 86400_000,
        });
      }
      for (let attempt = 0; ; attempt++) {
        const complete = await step.do(
          `mark standings delivered ${attempt}`,
          ioRetry,
          async () => {
            if (
              (await hasMarker(this.env.DB, groupKey)) ||
              (await hasMarker(this.env.DB, winnerKey))
            ) {
              return true;
            }
            if ((await claimEffect(this.env.DB, lock, id)) !== "claimed") {
              return false;
            }
            if (
              (await hasMarker(this.env.DB, groupKey)) ||
              (await hasMarker(this.env.DB, winnerKey))
            ) {
              return true;
            }
            await mark(
              this.env.DB,
              data.winner ? [groupKey, winnerKey] : [groupKey],
            );
            return true;
          },
        );
        if (complete) {
          break;
        }
        await step.sleep(`standings completion busy ${attempt}`, "30 seconds");
      }
    } finally {
      const status = await this.env.DB.prepare(
        "SELECT status FROM job_runs WHERE id=?",
      )
        .bind(id)
        .first<string>("status");
      if (status !== "paused") {
        await step.do("release standings lock", ioRetry, () =>
          releaseEffect(this.env.DB, lock, id),
        );
      }
    }
  }
}
