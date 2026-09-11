import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  getSubmission,
  listUserSubmissions,
  saveSubmission,
} from "../../src/server/db";
import type {
  Submission,
  SubmissionDetail,
  WeekData,
} from "../../src/shared/contracts";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { app, login, mockScoreboard, origin, testEnv } from "./auth-helpers";

const body = JSON.stringify({ picks: { "401": "home-401" }, tiebreaker: 40 });

describe("submission requests with real D1", () => {
  it("replaces the complete picks map while preserving identity and creation time", async () => {
    const identity = await login();
    const fetch = mockScoreboard(
      espnScoreboard([espnEvent(), espnEvent({ id: "402" })]),
    );
    const first = await app.request(
      `${origin}/api/submissions/1?season=2026`,
      {
        method: "PUT",
        headers: identity.headers,
        body: JSON.stringify({
          picks: { "401": "home-401", "402": "away-402" },
          tiebreaker: 0,
        }),
      },
      testEnv,
    );
    expect(first.status).toBe(200);
    const original = (await first.json<{ submission: Submission }>())
      .submission;
    const second = await app.request(
      `${origin}/api/submissions/1?season=2026`,
      { method: "PUT", headers: identity.headers, body },
      testEnv,
    );
    expect(second.status).toBe(200);
    const updated = (await second.json<{ submission: Submission }>())
      .submission;
    expect(updated).toMatchObject({
      id: original.id,
      userId: identity.user.id,
      createdAt: original.createdAt,
      picks: { "401": "home-401" },
      tiebreaker: 40,
    });
    expect(await listUserSubmissions(env.DB, identity.user.id)).toEqual([
      updated,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("denies anonymous, cross-origin, missing-CSRF and other-session-CSRF writes", async () => {
    const first = await login();
    const second = await login("222222222222222222");
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(
      (
        await app.request(
          `${origin}/api/submissions/1?season=2026`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body,
          },
          testEnv,
        )
      ).status,
    ).toBe(401);
    const rejectedHeaders: Record<string, string>[] = [
      { ...first.headers, Origin: "https://evil.example" },
      {
        Cookie: first.cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      { ...first.headers, "X-CSRF-Token": second.csrf },
      { ...first.headers, Origin: "null" },
    ];
    for (const headers of rejectedHeaders) {
      expect(
        (
          await app.request(
            `${origin}/api/submissions/1?season=2026`,
            { method: "PUT", headers, body },
            testEnv,
          )
        ).status,
      ).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await getSubmission(env.DB, first.user.id, { season: 2026, week: 1 }),
    ).toBeNull();
  });

  it("rejects unknown fields, invalid tiebreakers, empty picks, and unrecognized teams without persisting", async () => {
    const identity = await login();
    mockScoreboard();
    const error: unknown = expect.any(String);
    const fields: unknown = expect.any(Object);
    for (const candidate of [
      {
        picks: { "401": "home-401" },
        tiebreaker: 40,
        userId: 999,
        admin: true,
      },
      { picks: { "401": "home-401" }, tiebreaker: -1 },
      { picks: { "401": "home-401" }, tiebreaker: 1.5 },
      { picks: { "401": "home-401" }, tiebreaker: "40" },
      { picks: {}, tiebreaker: 40 },
      { picks: [], tiebreaker: 40 },
      { picks: { missing: "home-401" }, tiebreaker: 40 },
      { picks: { "401": "not-playing" }, tiebreaker: 40 },
    ]) {
      const response = await app.request(
        `${origin}/api/submissions/1?season=2026`,
        {
          method: "PUT",
          headers: identity.headers,
          body: JSON.stringify(candidate),
        },
        testEnv,
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error,
        fields,
      });
    }
    expect(
      await getSubmission(env.DB, identity.user.id, { season: 2026, week: 1 }),
    ).toBeNull();
  });

  it("rejects malformed JSON, incorrect content types and invalid week parameters", async () => {
    const identity = await login();
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(
      (
        await app.request(
          `${origin}/api/submissions/1?season=2026`,
          { method: "PUT", headers: identity.headers, body: "{" },
          testEnv,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `${origin}/api/submissions/1?season=2026`,
          {
            method: "PUT",
            headers: { ...identity.headers, "Content-Type": "text/plain" },
            body,
          },
          testEnv,
        )
      ).status,
    ).toBe(415);
    for (const week of ["0", "19", "1.1", "1e0", "01", "current"]) {
      expect(
        (
          await app.request(
            `${origin}/api/submissions/${week}?season=2026`,
            { method: "PUT", headers: identity.headers, body },
            testEnv,
          )
        ).status,
      ).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("locks existing submissions at the upstream scheduled-to-started boundary", async () => {
    const identity = await login();
    const fetch = mockScoreboard();
    expect(
      (
        await app.request(
          `${origin}/api/submissions/1?season=2026`,
          { method: "PUT", headers: identity.headers, body },
          testEnv,
        )
      ).status,
    ).toBe(200);
    const original = await getSubmission(env.DB, identity.user.id, {
      season: 2026,
      week: 1,
    });
    fetch.mockResolvedValue(
      Response.json(
        espnScoreboard([
          espnEvent({ status: "STATUS_IN_PROGRESS" }),
          espnEvent({ id: "402" }),
        ]),
      ),
    );
    const locked = await app.request(
      `${origin}/api/submissions/1?season=2026`,
      {
        method: "PUT",
        headers: identity.headers,
        body: JSON.stringify({ picks: { "402": "home-402" }, tiebreaker: 80 }),
      },
      testEnv,
    );
    expect(locked.status).toBe(409);
    expect(
      await getSubmission(env.DB, identity.user.id, { season: 2026, week: 1 }),
    ).toEqual(original);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("permits one late first entry, removes started games, and atomically rejects the concurrent loser", async () => {
    const identity = await login();
    const raw = espnScoreboard([
      espnEvent({ status: "STATUS_IN_PROGRESS" }),
      espnEvent({ id: "402" }),
    ]);
    const fetch = mockScoreboard(raw);
    const candidates = [41, 42].map(async (tiebreaker) =>
      app.request(
        `${origin}/api/submissions/1?season=2026`,
        {
          method: "PUT",
          headers: identity.headers,
          body: JSON.stringify({
            picks: { "401": "home-401", "402": "away-402" },
            tiebreaker,
          }),
        },
        testEnv,
      ),
    );
    const responses = await Promise.all(candidates);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const successfulResponse = responses.find(
      (response) => response.status === 200,
    );
    assert(successfulResponse);
    const winner = await successfulResponse.json<{ submission: Submission }>();
    expect(winner.submission.picks).toEqual({ "402": "away-402" });
    expect(await listUserSubmissions(env.DB, identity.user.id)).toEqual([
      winner.submission,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects late first entries with no eligible picks", async () => {
    const identity = await login();
    mockScoreboard(espnScoreboard([espnEvent({ status: "STATUS_FINAL" })]));
    expect(
      (
        await app.request(
          `${origin}/api/submissions/1?season=2026`,
          { method: "PUT", headers: identity.headers, body },
          testEnv,
        )
      ).status,
    ).toBe(422);
    expect(await listUserSubmissions(env.DB, identity.user.id)).toEqual([]);
  });

  it("scores historical ID details using their stored season and denies another owner", async () => {
    const owner = await login();
    const other = await login("222222222222222222");
    const saved = await saveSubmission(env.DB, {
      season: 2025,
      userId: owner.user.id,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 40,
      locked: false,
    });
    assert(saved);
    await saveSubmission(env.DB, {
      season: 2026,
      week: 1,
      userId: owner.user.id,
      picks: { "401": "away-401" },
      tiebreaker: 50,
      locked: false,
    });
    const fetch = mockScoreboard(
      espnScoreboard(
        [espnEvent({ status: "STATUS_FINAL", date: "2025-09-07T17:00:00Z" })],
        1,
        2025,
      ),
    );
    const history = await app.request(
      `${origin}/api/submissions?userId=${owner.user.id}`,
      { headers: other.headers },
      testEnv,
    );
    expect(await history.json()).toEqual({ submissions: [] });
    const denied = await app.request(
      `${origin}/api/submissions/${saved.id}?userId=${owner.user.id}&season=2026`,
      { headers: other.headers },
      testEnv,
    );
    expect(denied.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const detail = await app.request(
      `${origin}/api/submissions/${saved.id}?season=2026`,
      { headers: owner.headers },
      testEnv,
    );
    const data = await detail.json<SubmissionDetail>();
    expect(data.submission).toMatchObject({ ...saved, user: owner.user });
    expect(data.scoreboard.season).toBe(2025);
    expect(data.correctPicks).toBe(1);
    expect(data.verificationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.summary).toContain("Home 401");
    expect(detail.headers.get("Cache-Control")).toBe("no-store");
  });

  it("resolves the current regular-season week and exposes lock state", async () => {
    const identity = await login();
    mockScoreboard(
      espnScoreboard([espnEvent({ status: "STATUS_IN_PROGRESS" })], 4),
    );
    const response = await app.request(
      `${origin}/api/weeks/current`,
      { headers: identity.headers },
      testEnv,
    );
    expect(response.status).toBe(200);
    const data = await response.json<WeekData>();
    expect(data.scoreboard.week).toBe(4);
    expect(data.locked).toBe(true);
    expect(data.submission).toBeNull();
    expect(data.earliestGameTime).toBe("2026-09-13T17:00:00.000Z");
  });

  it("never saves on unavailable, malformed or wrong-week ESPN responses", async () => {
    const identity = await login();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const response of [
      new Response("upstream secret failure", { status: 503 }),
      Response.json({ events: [] }),
      Response.json(espnScoreboard([espnEvent()], 2)),
      Response.json(espnScoreboard([espnEvent()], 1, 2025)),
    ]) {
      fetch.mockResolvedValue(response);
      const result = await app.request(
        `${origin}/api/submissions/1?season=2026`,
        { method: "PUT", headers: identity.headers, body },
        testEnv,
      );
      expect(result.status).toBe(502);
      expect(await result.text()).not.toContain("upstream secret failure");
    }
    expect(
      await getSubmission(env.DB, identity.user.id, { season: 2026, week: 1 }),
    ).toBeNull();
  });

  it("requires an explicit valid season before saving or fetching upstream games", async () => {
    const identity = await login();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const query of [
      "",
      "?season=2026.5",
      "?season=1919",
      "?season=current",
    ]) {
      const response = await app.request(
        `${origin}/api/submissions/1${query}`,
        { method: "PUT", headers: identity.headers, body },
        testEnv,
      );
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await listUserSubmissions(env.DB, identity.user.id)).toEqual([]);
  });
});
