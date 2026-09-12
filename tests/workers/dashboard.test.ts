import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { saveSubmission } from "../../src/server/db";
import type { DashboardData } from "../../src/shared/contracts";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { app, login, mockScoreboard, origin, testEnv } from "./auth-helpers";

function mockDashboard(
  context: { season: number; type: number; week: number },
  boards: Record<string, unknown>,
) {
  return mockScoreboard().mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const week = url.searchParams.get("week");
    if (week === null) {
      return Promise.resolve(
        Response.json({
          season: { year: context.season, type: context.type },
          week: { number: context.week },
        }),
      );
    }
    const board = boards[`${url.searchParams.get("dates")}:${week}`];
    if (url.searchParams.get("seasontype") !== "2" || board === undefined) {
      throw new Error("Unexpected scoreboard period");
    }
    return Promise.resolve(Response.json(board));
  });
}

async function loadDashboard(headers: Record<string, string>, query = "") {
  const response = await app.request(
    `${origin}/api/dashboard${query}`,
    { headers },
    testEnv,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json<DashboardData>();
}

describe("personal weekly dashboard", () => {
  it("requires authentication and reports upstream failure without private error details", async () => {
    expect(
      (await app.request(`${origin}/api/dashboard`, {}, testEnv)).status,
    ).toBe(401);
    const viewer = await login();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("private upstream"),
    );
    const response = await app.request(
      `${origin}/api/dashboard`,
      { headers: viewer.headers },
      testEnv,
    );
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(
      "private upstream",
    );
  });

  it("uses one current snapshot for personal results and standing without exposing rivals", async () => {
    const viewer = await login();
    const rival = await login("222222222222222222");
    const own = await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2026,
      week: 2,
      picks: { "401": "home-401", "402": "home-402" },
      tiebreaker: 30,
      locked: false,
    });
    await saveSubmission(env.DB, {
      userId: rival.user.id,
      season: 2026,
      week: 2,
      picks: { "401": "away-401", "402": "away-402" },
      tiebreaker: 57,
      locked: false,
    });
    const current = espnScoreboard(
      [
        espnEvent({ status: "STATUS_FINAL" }),
        espnEvent({ id: "402", date: "2099-09-13T17:00:00Z" }),
      ],
      2,
    );
    const changed = espnScoreboard(
      [
        espnEvent({ status: "STATUS_FINAL", homeScore: 0, awayScore: 7 }),
        espnEvent({ id: "402", status: "STATUS_FINAL" }),
      ],
      2,
    );
    mockScoreboard(changed)
      .mockResolvedValueOnce(Response.json(espnScoreboard([], 2)))
      .mockResolvedValueOnce(Response.json(current));
    const startedAt = Date.now();
    const data = await loadDashboard(viewer.headers, "?season=2025&week=18");
    assert(data.current);
    expect(data).toMatchObject({
      season: 2026,
      phase: "regular",
      previous: null,
    });
    expect(data.current.submission).toEqual(own);
    expect(data.current.scoreboard).toMatchObject({ season: 2026, week: 2 });
    expect(data.current.standing).toMatchObject({
      user: { id: viewer.user.id, username: viewer.user.username },
      rank: 1,
      correctPicks: 1,
      remainingCount: 1,
      tiebreaker: null,
      tiebreakerDiff: null,
    });
    expect(data.current.playerCount).toBe(2);
    expect(
      data.current.picks.map((pick) => [pick.competitionId, pick.correct]),
    ).toEqual([
      ["401", true],
      ["402", false],
    ]);
    expect(data.current.picks[1]?.winningTeamId).toBeNull();
    expect(data.current.action.kind).toBe("locked");
    expect(JSON.stringify(data)).not.toContain(rival.user.username);
    expect(JSON.stringify(data)).not.toMatch(
      /remainingPicks|discordId|verificationHash/,
    );
    expect(data.current.standing?.user).toEqual({
      id: viewer.user.id,
      username: viewer.user.username,
    });
    expect(Date.parse(data.checkedAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(data.checkedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("permits late first entry but locks existing picks at the clock boundary even with stale scheduled status", async () => {
    const firstKickoff = "2099-09-13T17:00:00.000Z";
    const nextKickoff = "2099-09-13T20:00:00.000Z";
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(firstKickoff) - 1);
    const viewer = await login();
    mockDashboard(
      { season: 2026, type: 2, week: 1 },
      {
        "2026:1": espnScoreboard([
          espnEvent({ date: firstKickoff }),
          espnEvent({ id: "402", date: nextKickoff }),
        ]),
      },
    );
    expect((await loadDashboard(viewer.headers)).current?.action).toEqual({
      kind: "make",
      eligibleGames: 2,
      deadline: firstKickoff,
    });
    clock.mockReturnValue(Date.parse(firstKickoff));
    expect((await loadDashboard(viewer.headers)).current?.action).toEqual({
      kind: "make",
      eligibleGames: 1,
      deadline: nextKickoff,
    });
    await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2026,
      week: 1,
      picks: { "402": "home-402" },
      tiebreaker: 30,
      locked: false,
    });
    const locked = await loadDashboard(viewer.headers);
    expect(locked.current?.locked).toBe(true);
    expect(locked.current?.action).toEqual({
      kind: "locked",
      eligibleGames: 0,
      deadline: null,
    });
    clock.mockReturnValue(Date.parse(nextKickoff));
    expect((await loadDashboard(viewer.headers)).current?.action).toEqual({
      kind: "closed",
      eligibleGames: 0,
      deadline: null,
    });
  });

  it("offers review before kickoff and rejects unavailable regular-season game data", async () => {
    const viewer = await login();
    await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2026,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 30,
      locked: false,
    });
    mockDashboard(
      { season: 2026, type: 2, week: 1 },
      {
        "2026:1": espnScoreboard([espnEvent({ date: "2099-09-13T17:00:00Z" })]),
      },
    );
    expect((await loadDashboard(viewer.headers)).current?.action).toEqual({
      kind: "review",
      eligibleGames: 1,
      deadline: "2099-09-13T17:00:00.000Z",
    });
    mockDashboard(
      { season: 2026, type: 2, week: 1 },
      {
        "2026:1": espnScoreboard([]),
      },
    );
    const unavailable = await app.request(
      `${origin}/api/dashboard`,
      { headers: viewer.headers },
      testEnv,
    );
    expect(unavailable.status).toBe(502);
  });

  it("recaps only the exact same-season previous submission and marks partial results honestly", async () => {
    const viewer = await login();
    const previous = await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2026,
      week: 1,
      picks: { "401": "home-401", "402": "away-402" },
      tiebreaker: 30,
      locked: false,
    });
    assert(previous);
    await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2025,
      week: 2,
      picks: { "401": "away-401" },
      tiebreaker: 77,
      locked: false,
    });
    mockDashboard(
      { season: 2026, type: 2, week: 2 },
      {
        "2026:2": espnScoreboard([espnEvent()], 2),
        "2026:1": espnScoreboard([
          espnEvent({ status: "STATUS_FINAL" }),
          espnEvent({ id: "402", date: "2099-09-13T17:00:00Z" }),
        ]),
      },
    );
    expect((await loadDashboard(viewer.headers)).previous).toMatchObject({
      season: 2026,
      week: 1,
      submissionId: previous.id,
      complete: false,
      hasResults: true,
      playerCount: 1,
      standing: { correctPicks: 1, remainingCount: 1, tiebreaker: null },
    });
    mockDashboard(
      { season: 2026, type: 2, week: 3 },
      {
        "2026:3": espnScoreboard([espnEvent()], 3),
      },
    );
    expect((await loadDashboard(viewer.headers)).previous).toBeNull();
  });

  it("never invents a week zero or crosses a season boundary for the prior recap", async () => {
    const viewer = await login();
    await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2025,
      week: 18,
      picks: { "401": "home-401" },
      tiebreaker: 30,
      locked: false,
    });
    mockDashboard(
      { season: 2026, type: 2, week: 1 },
      {
        "2026:1": espnScoreboard([espnEvent()]),
      },
    );
    expect((await loadDashboard(viewer.headers)).previous).toBeNull();
    mockDashboard({ season: 2026, type: 4, week: 1 }, {});
    expect(await loadDashboard(viewer.headers)).toMatchObject({
      season: 2026,
      phase: "offseason",
      current: null,
      previous: null,
    });
  });

  it("separates preseason from postseason and offseason recaps pinned to regular week eighteen", async () => {
    const viewer = await login();
    const submission = await saveSubmission(env.DB, {
      userId: viewer.user.id,
      season: 2026,
      week: 18,
      picks: { "401": "home-401" },
      tiebreaker: 30,
      locked: false,
    });
    assert(submission);
    mockDashboard({ season: 2026, type: 1, week: 2 }, {});
    expect(await loadDashboard(viewer.headers)).toMatchObject({
      season: 2026,
      phase: "preseason",
      current: null,
      previous: null,
    });
    for (const [type, phase] of [
      [3, "postseason"],
      [4, "offseason"],
    ] as const) {
      mockDashboard(
        { season: 2026, type, week: 2 },
        {
          "2026:18": espnScoreboard(
            [espnEvent({ status: "STATUS_FINAL" })],
            18,
          ),
        },
      );
      expect(await loadDashboard(viewer.headers)).toMatchObject({
        season: 2026,
        phase,
        current: null,
        previous: {
          season: 2026,
          week: 18,
          submissionId: submission.id,
          complete: true,
          hasResults: true,
          standing: { correctPicks: 1, remainingCount: 0 },
        },
      });
    }
  });
});
