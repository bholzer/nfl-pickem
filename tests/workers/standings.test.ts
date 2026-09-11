import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { saveSubmission } from "../../src/server/db";
import type {
  StandingsData,
  SubmissionDetail,
} from "../../src/shared/contracts";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { app, login, mockScoreboard, origin, testEnv } from "./auth-helpers";

describe("standings and administrator submission APIs", () => {
  it("requires authentication for standings and DB-backed administrator authorization for private detail", async () => {
    const ordinary = await login();
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(
      (await app.request(`${origin}/api/standings`, {}, testEnv)).status,
    ).toBe(401);
    for (const path of [
      "/api/admin/submissions",
      "/api/admin/submissions/1?admin=true",
    ]) {
      const response = await app.request(
        `${origin}${path}`,
        { headers: ordinary.headers },
        testEnv,
      );
      expect(response.status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps competitors' unplayed picks and undisclosed tiebreakers private", async () => {
    const viewer = await login();
    const rival = await login("222222222222222222");
    const admin = await login("333333333333333333", true);
    await saveSubmission(env.DB, {
      season: 2026,
      userId: viewer.user.id,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 30,
      locked: false,
    });
    const submission = await saveSubmission(env.DB, {
      season: 2026,
      userId: rival.user.id,
      week: 1,
      picks: { "401": "away-401" },
      tiebreaker: 57,
      locked: false,
    });
    assert(submission);
    mockScoreboard(
      espnScoreboard([espnEvent({ date: "2099-09-13T17:00:00Z" })]),
    );
    const response = await app.request(
      `${origin}/api/standings?season=2026&week=1`,
      { headers: viewer.headers },
      testEnv,
    );
    const data = await response.json<StandingsData>();
    const other = data.standings.find((row) => row.user.id === rival.user.id);
    assert(other);
    expect(other).not.toHaveProperty("remainingPicks");
    expect(other).not.toHaveProperty("submissionId");
    expect(other).toMatchObject({
      remainingCount: 1,
      tiebreaker: null,
      tiebreakerDiff: null,
    });
    expect(other.user).toEqual({
      id: rival.user.id,
      username: rival.user.username,
    });
    expect(data.showTiebreaker).toBe(false);
    for (const [path, headers] of [
      [`/api/submissions/${submission.id}`, rival.headers],
      [`/api/admin/submissions/${submission.id}`, admin.headers],
    ] as const) {
      const detail = await (
        await app.request(`${origin}${path}`, { headers }, testEnv)
      ).json<SubmissionDetail>();
      expect(detail.submission).toMatchObject({
        picks: { "401": "away-401" },
        tiebreaker: 57,
      });
    }
  });

  it("orders scores, applies Monday tiebreakers, and exposes verifiable admin detail", async () => {
    const admin = await login("111111111111111111", true);
    const player = await login("222222222222222222");
    const outsider = await login("333333333333333333");
    const first = await saveSubmission(env.DB, {
      season: 2026,
      userId: admin.user.id,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 40,
      locked: false,
    });
    const second = await saveSubmission(env.DB, {
      season: 2026,
      userId: player.user.id,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 50,
      locked: false,
    });
    const third = await saveSubmission(env.DB, {
      season: 2026,
      userId: outsider.user.id,
      week: 1,
      picks: { "401": "away-401" },
      tiebreaker: 41,
      locked: false,
    });
    assert(first && second && third);
    const fetch = mockScoreboard(
      espnScoreboard([
        espnEvent({ date: "2026-09-15T00:00:00Z", status: "STATUS_FINAL" }),
      ]),
    );
    const response = await app.request(
      `${origin}/api/standings?season=2026&week=1`,
      { headers: player.headers },
      testEnv,
    );
    const data = await response.json<StandingsData>();
    expect(
      data.standings.map((standing) => ({
        id: standing.user.id,
        correct: standing.correctPicks,
        diff: standing.tiebreakerDiff,
        winner: standing.winner,
        rank: standing.rank,
      })),
    ).toEqual([
      { id: admin.user.id, correct: 1, diff: 1, winner: true, rank: 1 },
      { id: player.user.id, correct: 1, diff: 9, winner: false, rank: 2 },
      { id: outsider.user.id, correct: 0, diff: 0, winner: false, rank: 3 },
    ]);
    expect(data.showTiebreaker).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const listing = await app.request(
      `${origin}/api/admin/submissions?season=2026&week=1`,
      { headers: admin.headers },
      testEnv,
    );
    const list = await listing.json<{ submissions: SubmissionDetail[] }>();
    expect(
      list.submissions.map((detail) => [
        detail.submission.id,
        detail.correctPicks,
      ]),
    ).toEqual([
      [first.id, 1],
      [second.id, 1],
      [third.id, 0],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const detail = await app.request(
      `${origin}/api/admin/submissions/${second.id}`,
      { headers: admin.headers },
      testEnv,
    );
    expect(await detail.json()).toEqual(list.submissions[1]);
    expect(list.submissions[1]?.verificationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves nullable no-Monday differences and descending-guess ranking", async () => {
    const first = await login();
    const second = await login("222222222222222222");
    await saveSubmission(env.DB, {
      season: 2026,
      userId: first.user.id,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 10,
      locked: false,
    });
    await saveSubmission(env.DB, {
      season: 2026,
      userId: second.user.id,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 20,
      locked: false,
    });
    mockScoreboard(espnScoreboard([espnEvent({ status: "STATUS_FINAL" })]));
    const response = await app.request(
      `${origin}/api/standings`,
      { headers: first.headers },
      testEnv,
    );
    const data = await response.json<StandingsData>();
    expect(
      data.standings.map((standing) => ({
        id: standing.user.id,
        diff: standing.tiebreakerDiff,
        winner: standing.winner,
        rank: standing.rank,
      })),
    ).toEqual([
      { id: second.user.id, diff: null, winner: true, rank: 1 },
      { id: first.user.id, diff: null, winner: true, rank: 2 },
    ]);
  });

  it("revokes admin authority immediately when the database role changes", async () => {
    const admin = await login("111111111111111111", true);
    await env.DB.prepare("UPDATE users SET admin = 0 WHERE id = ?")
      .bind(admin.user.id)
      .run();
    expect(
      (
        await app.request(
          `${origin}/api/admin/submissions`,
          { headers: admin.headers },
          testEnv,
        )
      ).status,
    ).toBe(403);
  });

  it("reports missing records, invalid IDs and upstream failures distinctly", async () => {
    const admin = await login("111111111111111111", true);
    expect(
      (
        await app.request(
          `${origin}/api/admin/submissions/999`,
          { headers: admin.headers },
          testEnv,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `${origin}/api/admin/submissions/1e0`,
          { headers: admin.headers },
          testEnv,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `${origin}/api/standings?week=19`,
          { headers: admin.headers },
          testEnv,
        )
      ).status,
    ).toBe(400);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("private upstream error"),
    );
    const response = await app.request(
      `${origin}/api/standings?season=2026&week=1`,
      { headers: admin.headers },
      testEnv,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private upstream error");
  });
});
