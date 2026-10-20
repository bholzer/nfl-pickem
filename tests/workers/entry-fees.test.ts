import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { saveSubmission } from "../../src/server/db";
import type {
  ApiError,
  SeasonData,
  SeasonEntryFees,
} from "../../src/shared/contracts";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { app, login, mockEspn, origin, testEnv } from "./auth-helpers";

const context = { season: 2026, type: 2, week: 1 };
const defaults = Array.from({ length: 18 }, (_, index) => ({
  week: index + 1,
  feeCents: 500,
  configured: false,
}));

function fetchFees(headers: Record<string, string>, query = "?season=2026") {
  return app.request(
    `${origin}/api/admin/entry-fees${query}`,
    { headers },
    testEnv,
  );
}

function putFee(headers: Record<string, string>, body: unknown) {
  return app.request(
    `${origin}/api/admin/entry-fees`,
    {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    testEnv,
  );
}

describe("entry fee administration", () => {
  it("requires an administrator for reads and writes", async () => {
    expect((await fetchFees({})).status).toBe(401);
    const member = await login();
    expect((await fetchFees(member.headers)).status).toBe(403);
    expect(
      (await putFee(member.headers, { season: 2026, week: 1, feeCents: 700 }))
        .status,
    ).toBe(403);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM week_entry_fees",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("lists the default for every week and validates the season before any upstream request", async () => {
    const admin = await login("333333333333333333", true);
    const fetch = mockEspn(context, {});
    const response = await fetchFees(admin.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json<SeasonEntryFees>()).toEqual({
      season: 2026,
      defaultFeeCents: 500,
      weeks: defaults,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await fetchFees(admin.headers, "?season=26")).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();

    // Omitting the season follows ESPN's current season like the season page.
    const current = await fetchFees(admin.headers, "");
    expect((await current.json<SeasonEntryFees>()).season).toBe(2026);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects writes without a CSRF token or with an invalid fee", async () => {
    const admin = await login("333333333333333333", true);
    const withoutCsrf = Object.fromEntries(
      Object.entries(admin.headers).filter(([name]) => name !== "X-CSRF-Token"),
    );
    expect(
      (await putFee(withoutCsrf, { season: 2026, week: 1, feeCents: 700 }))
        .status,
    ).toBe(403);
    const invalid: unknown[] = [
      { season: 2026, week: 1, feeCents: 7.5 },
      { season: 2026, week: 1, feeCents: -1 },
      { season: 2026, week: 1, feeCents: 100_001 },
      { season: 2026, week: 1, feeCents: "700" },
      { season: 2026, week: 19, feeCents: 700 },
      { season: "2026", week: 1, feeCents: 700 },
      { season: 1919, week: 1, feeCents: 700 },
      "not json",
      null,
    ];
    for (const body of invalid) {
      const response = await putFee(admin.headers, body);
      expect(response.status).toBe(422);
      expect(
        Object.keys((await response.json<ApiError>()).fields ?? {}),
      ).not.toHaveLength(0);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM week_entry_fees",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("stores a season-scoped override that flows into season totals", async () => {
    const admin = await login("333333333333333333", true);
    const rival = await login("222222222222222222");
    for (const member of [admin, rival]) {
      await saveSubmission(env.DB, {
        userId: member.user.id,
        season: 2026,
        week: 1,
        picks: { "401": member === admin ? "home-401" : "away-401" },
        tiebreaker: 40,
        locked: false,
      });
    }
    let response = await putFee(admin.headers, {
      season: 2026,
      week: 1,
      feeCents: 1000,
    });
    expect(response.status).toBe(200);
    const updated = await response.json<SeasonEntryFees>();
    expect(updated.season).toBe(2026);
    expect(updated.weeks).toEqual([
      { week: 1, feeCents: 1000, configured: true },
      ...defaults.slice(1),
    ]);
    // A second write updates the same row instead of conflicting.
    response = await putFee(admin.headers, {
      season: 2026,
      week: 1,
      feeCents: 1200,
    });
    expect(response.status).toBe(200);
    expect((await response.json<SeasonEntryFees>()).weeks[0]).toEqual({
      week: 1,
      feeCents: 1200,
      configured: true,
    });
    // Another season keeps its own defaults.
    expect(
      (
        await (
          await fetchFees(admin.headers, "?season=2025")
        ).json<SeasonEntryFees>()
      ).weeks[0],
    ).toEqual(defaults[0]);

    mockEspn(context, {
      "2026:1": espnScoreboard([espnEvent({ status: "STATUS_FINAL" })]),
    });
    const season = await app.request(
      `${origin}/api/season?season=2026`,
      { headers: rival.headers },
      testEnv,
    );
    const data = await season.json<SeasonData>();
    expect(data.weeks).toEqual([
      expect.objectContaining({ week: 1, entryFeeCents: 1200, potCents: 2400 }),
    ]);
    expect(
      data.players.map((player) => [player.user.id, player.netCents]),
    ).toEqual([
      [admin.user.id, 1200],
      [rival.user.id, -1200],
    ]);
  });
});
