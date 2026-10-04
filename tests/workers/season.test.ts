import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { saveScoreboardSnapshot, saveSubmission } from "../../src/server/db";
import type { Env } from "../../src/server/env";
import type { SeasonData } from "../../src/shared/contracts";
import { espnEvent, espnScoreboard, scoreboardFixture } from "../fixtures/espn";
import { app, login, mockEspn, origin, testEnv } from "./auth-helpers";

const context = { season: 2026, type: 2, week: 2 };
const future = "2099-09-13T17:00:00Z";

async function loadSeason(
  headers: Record<string, string>,
  query = "",
  bindings: Env = testEnv,
) {
  const response = await app.request(
    `${origin}/api/season${query}`,
    { headers },
    bindings,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json<SeasonData>();
}

async function snapshotCount() {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM scoreboard_snapshots",
  ).first<{ count: number }>();
  return row?.count;
}

/** Week 1 final, week 2 in progress (ESPN's current week), week 3 upcoming. */
async function seedSeason() {
  const viewer = await login();
  const rival = await login("222222222222222222");
  const picks = [
    [viewer, 1, { "401": "home-401", "402": "home-402" }],
    [rival, 1, { "401": "home-401", "402": "away-402" }],
    [viewer, 2, { "401": "away-401", "402": "home-402" }],
    [rival, 2, { "401": "home-401", "402": "away-402" }],
    [viewer, 3, { "401": "home-401" }],
    [rival, 3, { "401": "away-401" }],
  ] as const;
  for (const [member, week, entry] of picks) {
    await saveSubmission(env.DB, {
      userId: member.user.id,
      season: 2026,
      week,
      picks: entry,
      tiebreaker: 40,
      locked: false,
    });
  }
  return { viewer, rival };
}

const boards = {
  "2026:1": espnScoreboard([
    espnEvent({ status: "STATUS_FINAL" }),
    espnEvent({ id: "402", status: "STATUS_FINAL" }),
  ]),
  "2026:2": espnScoreboard(
    [
      espnEvent({ status: "STATUS_FINAL" }),
      espnEvent({ id: "402", status: "STATUS_IN_PROGRESS" }),
    ],
    2,
  ),
  "2026:3": espnScoreboard([espnEvent({ date: future })], 3),
};

describe("season totals", () => {
  it("requires authentication and validates the season before any upstream request", async () => {
    expect(
      (await app.request(`${origin}/api/season`, {}, testEnv)).status,
    ).toBe(401);
    const viewer = await login();
    const fetch = mockEspn(context, boards);
    const response = await app.request(
      `${origin}/api/season?season=20x6`,
      { headers: viewer.headers },
      testEnv,
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ranks the season, labels each week, and freezes only final boards", async () => {
    const { viewer, rival } = await seedSeason();
    const fetch = mockEspn(context, boards);
    const data = await loadSeason(viewer.headers);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(data).toMatchObject({
      season: 2026,
      phase: "in_progress",
      inProgressWeek: 2,
    });
    expect(data.weeks).toEqual([
      {
        week: 1,
        status: "final",
        playerCount: 2,
        winners: [{ id: viewer.user.id, username: viewer.user.username }],
      },
      { week: 2, status: "in_progress", playerCount: 2, winners: [] },
      { week: 3, status: "upcoming", playerCount: 2, winners: [] },
    ]);
    expect(data.players).toEqual([
      {
        user: { id: viewer.user.id, username: viewer.user.username },
        rank: 1,
        correctPicks: 2,
        decidedPicks: 3,
        accuracy: 2 / 3,
        weeklyWins: 1,
        weeksPlayed: 2,
        bestWeek: { week: 1, correctPicks: 2 },
        worstWeek: { week: 1, correctPicks: 2 },
        averageCorrect: 2,
      },
      {
        user: { id: rival.user.id, username: rival.user.username },
        rank: 2,
        correctPicks: 2,
        decidedPicks: 3,
        accuracy: 2 / 3,
        weeklyWins: 0,
        weeksPlayed: 2,
        bestWeek: { week: 1, correctPicks: 1 },
        worstWeek: { week: 1, correctPicks: 1 },
        averageCorrect: 1,
      },
    ]);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(
      /picks|remainingPicks|tiebreaker|discordId|verificationHash|admin/,
    );
    for (const player of data.players) {
      expect(Object.keys(player.user).sort()).toEqual(["id", "username"]);
    }
    expect(await snapshotCount()).toBe(1);

    // A later ESPN correction to a frozen week no longer changes the totals.
    const corrected = mockEspn(context, {
      ...boards,
      "2026:1": espnScoreboard([
        espnEvent({ status: "STATUS_FINAL", homeScore: 0, awayScore: 7 }),
        espnEvent({ id: "402", status: "STATUS_FINAL" }),
      ]),
    });
    corrected.mockClear();
    const again = await loadSeason(viewer.headers);
    expect(corrected).toHaveBeenCalledTimes(3);
    expect(again.players).toEqual(data.players);
    expect(again.weeks).toEqual(data.weeks);
    expect(await snapshotCount()).toBe(1);
  });

  it("serves totals without writing snapshots in maintenance mode", async () => {
    const { viewer } = await seedSeason();
    mockEspn(context, boards);
    const data = await loadSeason(viewer.headers, "", {
      ...testEnv,
      MAINTENANCE_MODE: "true",
    });
    expect(data.players).toHaveLength(2);
    expect(await snapshotCount()).toBe(0);
  });

  it("fails closed when any week's game data is unavailable", async () => {
    const { viewer } = await seedSeason();
    mockEspn(context, {
      "2026:1": boards["2026:1"],
      "2026:3": boards["2026:3"],
    });
    const response = await app.request(
      `${origin}/api/season`,
      { headers: viewer.headers },
      testEnv,
    );
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(
      "Unexpected scoreboard period",
    );
  });

  it("reads a fully frozen past season with only the season discovery request", async () => {
    const viewer = await login();
    for (const week of [1, 2]) {
      await saveSubmission(env.DB, {
        userId: viewer.user.id,
        season: 2025,
        week,
        picks: { "401": "home-401" },
        tiebreaker: 40,
        locked: false,
      });
      await saveScoreboardSnapshot(
        env.DB,
        scoreboardFixture([{ status: "STATUS_FINAL" }], week, 2025),
      );
    }
    const fetch = mockEspn(context, {});
    const data = await loadSeason(viewer.headers, "?season=2025");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({
      season: 2025,
      phase: "complete",
      inProgressWeek: null,
      weeks: [
        { week: 1, status: "final", playerCount: 1, winners: [] },
        { week: 2, status: "final", playerCount: 1, winners: [] },
      ],
      players: [{ rank: 1, correctPicks: 2, decidedPicks: 2, weeksPlayed: 2 }],
    });
  });

  it("returns an empty season when nobody has submitted", async () => {
    const viewer = await login();
    const fetch = mockEspn({ season: 2026, type: 1, week: 1 }, {});
    expect(await loadSeason(viewer.headers)).toMatchObject({
      season: 2026,
      phase: "upcoming",
      inProgressWeek: null,
      weeks: [],
      players: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
