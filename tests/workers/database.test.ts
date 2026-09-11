import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureTokenUser,
  getSubmission,
  getSubmissionById,
  getUser,
  getUserByDiscordId,
  listUserSubmissions,
  listUsers,
  listWeekSubmissions,
  saveSubmission,
} from "../../src/server/db";

const createdAt = "2026-09-10T12:00:00.000Z";
const updatedAt = "2026-09-10T13:00:00.000Z";

const insertSubmission = (userId: number, week: number) =>
  env.DB.prepare(
    `
  INSERT INTO submissions (user_id, season, week, picks, tiebreaker, created_at, updated_at)
  VALUES (?, 2026, ?, '{}', 40, ?, ?)`,
  )
    .bind(userId, week, createdAt, createdAt)
    .run();

describe("D1 business persistence", () => {
  it("keeps Discord identity stable across concurrent stale tokens without overwriting metadata", async () => {
    const current = await ensureTokenUser(env.DB, {
      discordId: "discord-1",
      username: "current-name",
    });
    await env.DB.prepare("UPDATE users SET admin = 1 WHERE id = ?")
      .bind(current.id)
      .run();

    const users = await Promise.all([
      ensureTokenUser(env.DB, { discordId: "discord-1", username: "old-name" }),
      ensureTokenUser(env.DB, {
        discordId: "discord-1",
        username: "even-older-name",
      }),
    ]);
    const expected = { ...current, admin: true };
    expect(users).toEqual([expected, expected]);
    expect(await getUserByDiscordId(env.DB, "discord-1")).toEqual(expected);

    const other = await ensureTokenUser(env.DB, {
      discordId: "discord-2",
      username: "current-name",
    });
    expect(other.id).not.toBe(current.id);
    expect(await listUsers(env.DB)).toEqual([expected, other]);
  });

  it("creates one identity when first-use signed links race", async () => {
    const users = await Promise.all([
      ensureTokenUser(env.DB, { discordId: "first-use", username: "name" }),
      ensureTokenUser(env.DB, { discordId: "first-use", username: "name" }),
    ]);
    expect(users[0]).toEqual(users[1]);
    expect(await listUsers(env.DB)).toEqual([users[0]]);
  });

  it("preserves imported numeric IDs and nullable Discord metadata without confusing new users", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, discord_user_id, discord_username, admin, created_at, updated_at)
        VALUES (500, NULL, NULL, 1, ?, ?), (501, NULL, 'legacy', 0, ?, ?)`,
      ).bind(createdAt, createdAt, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO submissions (id, user_id, season, week, picks, tiebreaker, created_at, updated_at)
        VALUES (750, 500, 2025, 1, '{"game":"team"}', 0, ?, ?)`,
      ).bind("2025-10-29 16:47:27.123456", "2025-10-29 17:00:00.000000"),
    ]);

    const imported = { id: 500, discordId: null, username: null, admin: true };
    expect(await listUsers(env.DB)).toEqual([
      imported,
      { id: 501, discordId: null, username: "legacy", admin: false },
    ]);
    expect(await getUser(env.DB, 500)).toEqual(imported);
    expect(await getSubmissionById(env.DB, 750)).toEqual({
      id: 750,
      userId: 500,
      season: 2025,
      week: 1,
      picks: { game: "team" },
      tiebreaker: 0,
      createdAt: "2025-10-29T16:47:27.123Z",
      updatedAt: "2025-10-29T17:00:00.000Z",
      user: imported,
    });

    const fresh = await ensureTokenUser(env.DB, {
      discordId: "new-discord",
      username: "legacy",
    });
    expect(fresh.id).toBeGreaterThan(501);
    const submission = await saveSubmission(env.DB, {
      season: 2026,
      userId: fresh.id,
      week: 1,
      picks: {},
      tiebreaker: 0,
      locked: false,
    });
    assert(submission);
    expect(submission.id).toBeGreaterThan(750);
    expect(await getUser(env.DB, 501)).toEqual({
      id: 501,
      discordId: null,
      username: "legacy",
      admin: false,
    });
  });

  it("enforces Discord uniqueness, one submission per user/week, and foreign keys in D1", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "unique",
      username: "name",
    });
    await expect(
      env.DB.prepare(
        `INSERT INTO users (discord_user_id, created_at, updated_at)
      VALUES (?, ?, ?)`,
      )
        .bind("unique", createdAt, createdAt)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    await insertSubmission(user.id, 1);
    await expect(insertSubmission(user.id, 1)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(insertSubmission(user.id + 1000, 1)).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
    await expect(
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(await getUser(env.DB, user.id)).toEqual(user);
    expect(
      (await listUserSubmissions(env.DB, user.id)).map(
        (submission) => submission.week,
      ),
    ).toEqual([1]);
  });

  it("replaces the entire picks map while preserving submission identity and creation time", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "editor",
      username: "name",
    });
    const original = await saveSubmission(env.DB, {
      season: 2026,
      userId: user.id,
      week: 1,
      picks: { first: "home", removed: "away" },
      tiebreaker: 40,
      locked: false,
      now: createdAt,
    });
    const edited = await saveSubmission(env.DB, {
      season: 2026,
      userId: user.id,
      week: 1,
      picks: { first: "away" },
      tiebreaker: 45,
      locked: false,
      now: updatedAt,
    });
    expect(edited).toEqual({
      ...original,
      picks: { first: "away" },
      tiebreaker: 45,
      updatedAt,
    });
    expect(
      await getSubmission(env.DB, user.id, { season: 2026, week: 1 }),
    ).toEqual(edited);
    expect(await listUserSubmissions(env.DB, user.id)).toEqual([edited]);
  });

  it("refuses every concurrent locked edit without modifying an existing submission", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "locked-editor",
      username: "name",
    });
    const original = await saveSubmission(env.DB, {
      season: 2026,
      userId: user.id,
      week: 1,
      picks: { game: "home" },
      tiebreaker: 40,
      locked: false,
      now: createdAt,
    });
    const results = await Promise.all([
      saveSubmission(env.DB, {
        season: 2026,
        userId: user.id,
        week: 1,
        picks: { game: "away" },
        tiebreaker: 0,
        locked: true,
        now: updatedAt,
      }),
      saveSubmission(env.DB, {
        season: 2026,
        userId: user.id,
        week: 1,
        picks: {},
        tiebreaker: 100,
        locked: true,
        now: updatedAt,
      }),
    ]);
    expect(results).toEqual([null, null]);
    expect(
      await getSubmission(env.DB, user.id, { season: 2026, week: 1 }),
    ).toEqual(original);
  });

  it("allows exactly one new locked submission when first submissions race", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "late-new",
      username: "name",
    });
    const results = await Promise.all([
      saveSubmission(env.DB, {
        season: 2026,
        userId: user.id,
        week: 1,
        picks: {},
        tiebreaker: 40,
        locked: true,
        now: createdAt,
      }),
      saveSubmission(env.DB, {
        season: 2026,
        userId: user.id,
        week: 1,
        picks: { unstarted: "away" },
        tiebreaker: 45,
        locked: true,
        now: updatedAt,
      }),
    ]);
    expect(results.filter((submission) => submission === null)).toEqual([null]);
    const accepted = results.find((submission) => submission !== null);
    expect(await listUserSubmissions(env.DB, user.id)).toEqual([accepted]);
    expect(
      await getSubmission(env.DB, user.id, { season: 2026, week: 1 }),
    ).toEqual(accepted);
  });

  it("atomically upserts concurrent unlocked submissions without mixing their picks", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "concurrent-editor",
      username: "name",
    });
    const firstPicks = { first: "home", second: "away" };
    const secondPicks = { third: "home" };
    const results = await Promise.all([
      saveSubmission(env.DB, {
        season: 2026,
        userId: user.id,
        week: 1,
        picks: firstPicks,
        tiebreaker: 40,
        locked: false,
        now: createdAt,
      }),
      saveSubmission(env.DB, {
        season: 2026,
        userId: user.id,
        week: 1,
        picks: secondPicks,
        tiebreaker: 45,
        locked: false,
        now: updatedAt,
      }),
    ]);
    const [first, second] = results;
    assert(first && second);
    expect(first.id).toBe(second.id);
    expect(first.createdAt).toBe(second.createdAt);
    const persisted = await getSubmission(env.DB, user.id, {
      season: 2026,
      week: 1,
    });
    assert(persisted);
    expect(results).toContainEqual(persisted);
    expect([firstPicks, secondPicks]).toContainEqual(persisted.picks);
    expect(await listUserSubmissions(env.DB, user.id)).toEqual([persisted]);
  });

  it("scopes history to its user and week standings to their week with correct joined identities", async () => {
    const first = await ensureTokenUser(env.DB, {
      discordId: "first",
      username: "same-name",
    });
    const second = await ensureTokenUser(env.DB, {
      discordId: "second",
      username: "same-name",
    });
    const firstWeek = await saveSubmission(env.DB, {
      season: 2026,
      userId: first.id,
      week: 1,
      picks: { game: "home" },
      tiebreaker: 40,
      locked: false,
    });
    const nextWeek = await saveSubmission(env.DB, {
      season: 2026,
      userId: first.id,
      week: 2,
      picks: { game: "away" },
      tiebreaker: 45,
      locked: false,
    });
    const otherUser = await saveSubmission(env.DB, {
      season: 2026,
      userId: second.id,
      week: 1,
      picks: { game: "away" },
      tiebreaker: 50,
      locked: false,
    });
    expect(await listUserSubmissions(env.DB, first.id)).toEqual([
      nextWeek,
      firstWeek,
    ]);
    expect(
      await listWeekSubmissions(env.DB, { season: 2026, week: 1 }),
    ).toEqual([
      { ...firstWeek, user: first },
      { ...otherUser, user: second },
    ]);
    assert(otherUser);
    expect(await getSubmissionById(env.DB, otherUser.id)).toEqual({
      ...otherUser,
      user: second,
    });
    expect(
      await getSubmission(env.DB, second.id, { season: 2026, week: 2 }),
    ).toBeNull();
    expect(await getSubmissionById(env.DB, 9999)).toBeNull();
    expect(await getUser(env.DB, 9999)).toBeNull();
    expect(await getUserByDiscordId(env.DB, "missing")).toBeNull();
    expect(await listUserSubmissions(env.DB, 9999)).toEqual([]);
    expect(
      await listWeekSubmissions(env.DB, { season: 2026, week: 3 }),
    ).toEqual([]);
  });

  it("keeps same-numbered weeks independent across seasons, including locked first entries and history order", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "season-player",
      username: "Player",
    });
    const prior = await saveSubmission(env.DB, {
      userId: user.id,
      season: 2025,
      week: 1,
      picks: { oldGame: "oldTeam" },
      tiebreaker: 35,
      locked: false,
      now: "2025-09-01T12:00:00.000Z",
    });
    const current = await saveSubmission(env.DB, {
      userId: user.id,
      season: 2026,
      week: 1,
      picks: { newGame: "newTeam" },
      tiebreaker: 45,
      locked: true,
    });
    assert(prior && current);
    expect(current.id).not.toBe(prior.id);
    expect(
      await getSubmission(env.DB, user.id, { season: 2025, week: 1 }),
    ).toEqual(prior);
    expect(
      await getSubmission(env.DB, user.id, { season: 2026, week: 1 }),
    ).toEqual(current);
    expect(await listUserSubmissions(env.DB, user.id)).toEqual([
      current,
      prior,
    ]);
    expect(
      await listWeekSubmissions(env.DB, { season: 2025, week: 1 }),
    ).toEqual([{ ...prior, user }]);
    expect(
      await listWeekSubmissions(env.DB, { season: 2026, week: 1 }),
    ).toEqual([{ ...current, user }]);
  });

  it("refuses season migration while old native work remains resumable", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 2));
    await env.DB.prepare(
      "INSERT INTO job_runs(id,type,week,params,source,status,created_at,updated_at,delivery_scope) VALUES('old-paused','deliver_hashes',1,'{\"runId\":\"old-paused\",\"type\":\"deliver_hashes\",\"week\":1}','manual','paused',?,?, 'scope')",
    )
      .bind(createdAt, createdAt)
      .run();
    await expect(
      applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(2)),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT status FROM job_runs WHERE id='old-paused'",
      ).first("status"),
    ).toBe("paused");
    await env.DB.prepare(
      "UPDATE job_runs SET status='cancelled' WHERE id='old-paused'",
    ).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(2));
    expect(
      await env.DB.prepare(
        "SELECT season FROM job_runs WHERE id='old-paused'",
      ).first("season"),
    ).toBe(2026);
  });

  it("migrates January history without losing submission IDs, job references or resolved periods", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 2));
    const timestamp = "2026-01-04 12:00:00.000000";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id, discord_user_id, discord_username, admin, created_at, updated_at) VALUES(50, 'historic', 'Original', 1, ?, ?)",
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO submissions(id, user_id, week, picks, tiebreaker, created_at, updated_at) VALUES(70, 50, 18, '{\"old\":\"team\"}', 42, ?, ?), (999, 50, 17, '{}', 0, ?, ?)",
      ).bind(timestamp, timestamp, timestamp, timestamp),
      env.DB.prepare("DELETE FROM submissions WHERE id = 999"),
      env.DB.prepare(
        "INSERT INTO job_runs(id, type, week, params, source, status, created_at, updated_at, delivery_scope) VALUES('parent', 'deliver_hashes', 18, '{\"runId\":\"parent\",\"type\":\"deliver_hashes\",\"week\":null}', 'scheduled', 'complete', ?, ?, 'scope')",
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO job_runs(id, type, week, params, source, status, planned_at, started_at, finished_at, created_at, updated_at, error, delivery_scope, parent_id, control, gate_paused, control_until) VALUES('child', 'deliver_hashes', 18, '{\"runId\":\"child\",\"type\":\"deliver_hashes\",\"week\":null,\"weekOffset\":1}', 'manual', 'errored', ?, ?, ?, ?, ?, 'historic failure', 'scope', 'parent', 'pause', 1, 123)",
      ).bind(timestamp, timestamp, timestamp, timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO job_deliveries(run_id, key, status, error, updated_at) VALUES('child', 'hash', 'sent', NULL, ?)",
      ).bind(timestamp),
    ]);
    const originalJobs = await env.DB.prepare(
      "SELECT * FROM job_runs ORDER BY id",
    ).all();
    const originalUsers = await env.DB.prepare("SELECT * FROM users").all();
    const originalDeliveries = await env.DB.prepare(
      "SELECT * FROM job_deliveries",
    ).all();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(2));
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toEqual(
      originalUsers.results,
    );
    expect(
      (await env.DB.prepare("SELECT * FROM job_deliveries").all()).results,
    ).toEqual(originalDeliveries.results);
    const migratedJobs = await env.DB.prepare(
      "SELECT * FROM job_runs ORDER BY id",
    ).all();
    expect(migratedJobs.results).toEqual(
      originalJobs.results.map((row) => ({
        ...row,
        season: 2025,
        params: JSON.stringify({
          ...(JSON.parse(String(row.params)) as Record<string, unknown>),
          season: 2025,
          week: 18,
        }),
      })),
    );
    const historical = await getSubmission(env.DB, 50, {
      season: 2025,
      week: 18,
    });
    expect(historical).toMatchObject({
      id: 70,
      userId: 50,
      season: 2025,
      week: 18,
      picks: { old: "team" },
      tiebreaker: 42,
      createdAt: "2026-01-04T12:00:00.000Z",
      updatedAt: "2026-01-04T12:00:00.000Z",
    });
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    await expect(
      env.DB.prepare("DELETE FROM job_runs WHERE id = 'parent'").run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    const next = await saveSubmission(env.DB, {
      userId: 50,
      season: 2026,
      week: 18,
      picks: { new: "team" },
      tiebreaker: 30,
      locked: false,
    });
    assert(next);
    expect(next.id).toBeGreaterThan(999);
    expect(await getSubmission(env.DB, 50, { season: 2025, week: 18 })).toEqual(
      historical,
    );
  });
});
