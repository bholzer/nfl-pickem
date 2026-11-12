import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { saveSubmission } from "../../src/server/db";
import type {
  ApiError,
  ManualPaymentInput,
  PaymentsData,
} from "../../src/shared/contracts";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { app, login, mockEspn, origin, testEnv } from "./auth-helpers";

const context = { season: 2026, type: 2, week: 1 };
const finalBoard = {
  "2026:1": espnScoreboard([espnEvent({ status: "STATUS_FINAL" })]),
};

function request(
  path: string,
  headers: Record<string, string>,
  init: { method?: string; body?: unknown } = {},
) {
  const { method = "GET", body } = init;
  return app.request(
    `${origin}/api/admin/payments${path}`,
    {
      method,
      headers,
      body:
        body === undefined || typeof body === "string"
          ? body
          : JSON.stringify(body),
    },
    testEnv,
  );
}

async function entryCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM payment_entries",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

function withoutCsrf(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== "X-CSRF-Token"),
  );
}

/** The administrator wins week 1 of 2026 against one rival at the $5 default. */
async function playedSeason() {
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
  mockEspn(context, finalBoard);
  return { admin, rival };
}

function payment(
  userId: number,
  overrides: Partial<ManualPaymentInput> = {},
): ManualPaymentInput {
  return {
    season: 2026,
    userId,
    direction: "in",
    amountCents: 500,
    paidAt: "2026-09-10T08:00:00-04:00",
    note: null,
    ...overrides,
  };
}

describe("payments ledger administration", () => {
  it("requires an administrator for reads and writes", async () => {
    expect((await request("?season=2026", {})).status).toBe(401);
    const member = await login();
    const writes: [string, { method: string; body: unknown }][] = [
      ["", { method: "POST", body: payment(member.user.id) }],
      ["/1/void", { method: "POST", body: {} }],
      ["/banker", { method: "PUT", body: { userId: member.user.id } }],
    ];
    expect((await request("?season=2026", member.headers)).status).toBe(403);
    for (const [path, init] of writes) {
      expect((await request(path, member.headers, init)).status).toBe(403);
    }
    expect(await entryCount()).toBe(0);
  });

  it("requires CSRF tokens and validates input before writing", async () => {
    const { admin } = await playedSeason();
    const headers = withoutCsrf(admin.headers);
    expect(
      (
        await request("", headers, {
          method: "POST",
          body: payment(admin.user.id),
        })
      ).status,
    ).toBe(403);
    expect((await request("/1/void", headers, { method: "POST" })).status).toBe(
      403,
    );
    expect(
      (
        await request("/banker", headers, {
          method: "PUT",
          body: { userId: null },
        })
      ).status,
    ).toBe(403);

    const id = admin.user.id;
    const invalid: [unknown, string][] = [
      [payment(id, { amountCents: 0 }), "amountCents"],
      [payment(id, { amountCents: 12.5 }), "amountCents"],
      [payment(id, { amountCents: 1_000_001 }), "amountCents"],
      [{ ...payment(id), amountCents: "500" }, "amountCents"],
      [{ ...payment(id), direction: "sideways" }, "direction"],
      [{ ...payment(id), season: 1919 }, "season"],
      [{ ...payment(id), season: "2026" }, "season"],
      [payment(id, { paidAt: "2026-09-10" }), "paidAt"],
      [payment(id, { paidAt: "2026-02-30T12:00:00Z" }), "paidAt"],
      [payment(id, { paidAt: "yesterday" }), "paidAt"],
      [payment(id, { note: "x".repeat(281) }), "note"],
      [{ ...payment(id), note: 7 }, "note"],
      [{ ...payment(id), userId: "1" }, "userId"],
      [payment(9999), "userId"],
      ["not json", "season"],
      [null, "season"],
    ];
    for (const [body, field] of invalid) {
      const response = await request("", admin.headers, {
        method: "POST",
        body,
      });
      expect(response.status).toBe(422);
      expect((await response.json<ApiError>()).fields).toHaveProperty(field);
    }
    for (const userId of [9999, "1", 0]) {
      const response = await request("/banker", admin.headers, {
        method: "PUT",
        body: { userId },
      });
      expect(response.status).toBe(422);
    }
    expect(await entryCount()).toBe(0);
    expect(
      (await request("/abc/void", admin.headers, { method: "POST" })).status,
    ).toBe(400);
    expect(
      (await request("/42/void", admin.headers, { method: "POST" })).status,
    ).toBe(404);
  });

  it("rejects an invalid season before any upstream request", async () => {
    const admin = await login("333333333333333333", true);
    const fetch = mockEspn(context, {});
    expect((await request("?season=26", admin.headers)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    // Omitting the season follows ESPN's current season.
    const response = await request("", admin.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = await response.json<PaymentsData>();
    expect(data).toMatchObject({
      season: 2026,
      bankerUserId: null,
      players: [],
      entries: [],
      users: [{ id: admin.user.id, username: admin.user.username }],
      venmoAccounts: [],
      keywords: [],
      emailFailures: [],
    });
  });

  it("records payments, voids them, and keeps voided history listed", async () => {
    const { admin, rival } = await playedSeason();
    let data = await (
      await request("?season=2026", admin.headers)
    ).json<PaymentsData>();
    expect(
      data.players.map((player) => [player.user.id, player.balanceCents]),
    ).toEqual([
      [rival.user.id, -500],
      [admin.user.id, 500],
    ]);

    let response = await request("", admin.headers, {
      method: "POST",
      body: payment(rival.user.id, { note: "  Venmo  " }),
    });
    expect(response.status).toBe(200);
    data = await response.json<PaymentsData>();
    const [entry] = data.entries;
    expect(data.entries).toEqual([
      {
        id: expect.any(Number) as unknown,
        season: 2026,
        userId: rival.user.id,
        direction: "in",
        amountCents: 500,
        source: "manual",
        status: "approved",
        note: "Venmo",
        venmoName: null,
        venmoTransactionId: null,
        paidAt: "2026-09-10T12:00:00.000Z",
        createdAt: expect.any(String) as unknown,
        voidedAt: null,
      },
    ]);
    expect(data.players[0]).toEqual({
      user: { id: rival.user.id, username: rival.user.username },
      banker: false,
      feesCents: 500,
      winningsCents: 0,
      paidInCents: 500,
      paidOutCents: 0,
      balanceCents: 0,
    });
    expect(data.summary).toEqual({
      collectedCents: 500,
      paidOutCents: 0,
      owedToBankerCents: 0,
      owedByBankerCents: 500,
      unawardedCents: 0,
    });

    // A later payout to the winner with a blank note sorts first.
    response = await request("", admin.headers, {
      method: "POST",
      body: payment(admin.user.id, {
        direction: "out",
        paidAt: "2026-09-12T00:00:00Z",
        note: "   ",
      }),
    });
    data = await response.json<PaymentsData>();
    expect(data.entries.map((item) => [item.direction, item.note])).toEqual([
      ["out", null],
      ["in", "Venmo"],
    ]);
    expect(data.summary.owedByBankerCents).toBe(0);

    assert(entry);
    response = await request(`/${entry.id}/void`, admin.headers, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    data = await response.json<PaymentsData>();
    expect(data.entries[1]).toMatchObject({
      id: entry.id,
      status: "voided",
      voidedAt: expect.any(String) as unknown,
    });
    expect(data.players[0]?.balanceCents).toBe(-500);
    expect(data.summary.collectedCents).toBe(0);

    response = await request(`/${entry.id}/void`, admin.headers, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(await entryCount()).toBe(2);
  });

  it("lists a player with only ledger entries in that season", async () => {
    const admin = await login("333333333333333333", true);
    const guest = await login("444444444444444444");
    mockEspn(context, {});
    const response = await request("", admin.headers, {
      method: "POST",
      body: payment(guest.user.id, { season: 2025 }),
    });
    const data = await response.json<PaymentsData>();
    expect(data.season).toBe(2025);
    expect(data.players).toEqual([
      expect.objectContaining({
        user: { id: guest.user.id, username: guest.user.username },
        feesCents: 0,
        balanceCents: 500,
      }),
    ]);
    const other = await (
      await request("?season=2026", admin.headers)
    ).json<PaymentsData>();
    expect(other.players).toEqual([]);
    expect(other.entries).toEqual([]);
  });

  it("sets and clears the banker, who never owes or is owed", async () => {
    const { admin, rival } = await playedSeason();
    let response = await request("/banker?season=2026", admin.headers, {
      method: "PUT",
      body: { userId: admin.user.id },
    });
    expect(response.status).toBe(200);
    let data = await response.json<PaymentsData>();
    expect(data.bankerUserId).toBe(admin.user.id);
    expect(
      data.players.map((player) => [
        player.user.id,
        player.banker,
        player.balanceCents,
      ]),
    ).toEqual([
      [rival.user.id, false, -500],
      [admin.user.id, true, 0],
    ]);
    expect(data.summary).toMatchObject({
      owedToBankerCents: 500,
      owedByBankerCents: 0,
    });

    response = await request("/banker", admin.headers, {
      method: "PUT",
      body: { userId: null },
    });
    data = await response.json<PaymentsData>();
    expect(data.season).toBe(2026);
    expect(data.bankerUserId).toBeNull();
    expect(data.players.every((player) => !player.banker)).toBe(true);
    expect(data.summary.owedByBankerCents).toBe(500);
  });
});
