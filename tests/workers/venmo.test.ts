import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ensureTokenUser } from "../../src/server/db";
import type {
  ApiError,
  PaymentEntry,
  PaymentsData,
  User,
  VenmoImportResponse,
} from "../../src/shared/contracts";
import { app, login, mockEspn, origin, testEnv } from "./auth-helpers";

const context = { season: 2026, type: 2, week: 1 };

type Headers = Record<string, string>;

function request(
  path: string,
  headers: Headers,
  init: { method?: string; body?: unknown } = {},
) {
  const { method = "POST", body } = init;
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

function player(discordId: string, username: string): Promise<User> {
  return ensureTokenUser(env.DB, { discordId, username });
}

const header =
  ",ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (fee)";

/** The banker (Robin Ledger) trades with three players and two strangers. */
const statement = [
  "Account Statement - (@Robin-Ledger),,,,,,,,,",
  "Account Activity,,,,,,,,,",
  header,
  ',9001,2026-09-10T18:22:11,Payment,Complete,"Pickem week 1, thanks!",Avery Quinn,Robin Ledger,+ $5.00,0',
  ",9002,2026-09-11T01:05:00,Charge,Complete,PICKEM fees,Robin Ledger,jordan  blake,+ $15.00,0",
  ',9003,2026-09-12T09:00:00,Payment,Complete,"Dinner, split",Casey Morgan,Robin Ledger,"+ $1,250.50",0',
  ",9004,2026-09-14T16:30:00,Payment,Complete,pickem winnings,Robin Ledger,Avery Quinn,- $20.00,0",
  ",9005,2026-09-15T12:00:00,Standard Transfer,Issued,,,,- $50.00,0",
  ",9006,2026-09-16T10:00:00,Charge,Complete,Pickem buy-in,Taylor Reed,Robin Ledger,- $5.00,0",
  ",9007,2027-01-05T03:15:00,Payment,Complete,pickem playoffs,Jordan Blake,Robin Ledger,+ $10.00,0",
  ",,,,,,,,,",
  "In case of errors contact the synthetic support line.,,,,,,,,,",
].join("\r\n");

function entry(data: PaymentsData, transactionId: string): PaymentEntry {
  const found = data.entries.find(
    (item) => item.venmoTransactionId === transactionId,
  );
  assert(found, `Missing entry ${transactionId}`);
  return found;
}

function balance(data: PaymentsData, userId: number): number | undefined {
  return data.players.find((item) => item.user.id === userId)?.paidInCents;
}

async function entryCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM payment_entries",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function importStatement(headers: Headers, season = 2026) {
  const response = await request(`/import?season=${season}`, headers, {
    body: { csv: statement },
  });
  expect(response.status).toBe(200);
  return response.json<VenmoImportResponse>();
}

/** An administrator, three named players, and the `pickem` keyword. */
async function configuredPool() {
  const admin = await login("333333333333333333", true);
  mockEspn(context, {});
  const avery = await player("700000000000000001", "avery");
  const jordan = await player("700000000000000002", "jordan");
  const casey = await player("700000000000000003", "casey");
  const accounts: [User, string[]][] = [
    [avery, ["Avery Quinn"]],
    [jordan, ["Jordan Blake", "J Blake"]],
    [casey, ["Casey Morgan"]],
  ];
  for (const [user, displayNames] of accounts) {
    const response = await request(`/venmo/${user.id}`, admin.headers, {
      method: "PUT",
      body: { username: null, displayNames },
    });
    expect(response.status).toBe(200);
  }
  const response = await request("/keywords", admin.headers, {
    method: "PUT",
    body: { keywords: ["pickem"] },
  });
  expect(response.status).toBe(200);
  return { admin, avery, jordan, casey };
}

describe("Venmo administration access", () => {
  it("requires an administrator and a CSRF token on every Venmo route", async () => {
    const admin = await login("333333333333333333", true);
    const member = await login();
    const writes: [string, string, unknown][] = [
      ["PUT", `/venmo/${member.user.id}`, { username: null, displayNames: [] }],
      ["PUT", "/keywords", { keywords: ["pickem"] }],
      ["POST", "/import", { csv: statement }],
      ["POST", "/1/approve", { userId: member.user.id, season: 2026 }],
      ["POST", "/1/ignore", undefined],
      ["POST", "/1/reopen", undefined],
    ];
    const noCsrf = Object.fromEntries(
      Object.entries(admin.headers).filter(([name]) => name !== "X-CSRF-Token"),
    );
    for (const [method, path, body] of writes) {
      expect((await request(path, {}, { method, body })).status).toBe(401);
      expect(
        (await request(path, member.headers, { method, body })).status,
      ).toBe(403);
      expect((await request(path, noCsrf, { method, body })).status).toBe(403);
    }
    expect(await entryCount()).toBe(0);
  });
});

describe("Venmo accounts and keywords", () => {
  it("validates, normalizes, and lists accounts", async () => {
    const admin = await login("333333333333333333", true);
    mockEspn(context, {});
    const avery = await player("700000000000000001", "avery");
    const jordan = await player("700000000000000002", "jordan");
    const invalid: [unknown, string][] = [
      [{ username: "abcd", displayNames: [] }, "username"],
      [{ username: "has space", displayNames: [] }, "username"],
      [{ username: `@${"a".repeat(31)}`, displayNames: [] }, "username"],
      [{ username: 7, displayNames: [] }, "username"],
      [{ username: null, displayNames: "Avery" }, "displayNames"],
      [{ username: null, displayNames: ["  "] }, "displayNames"],
      [{ username: null, displayNames: [3] }, "displayNames"],
      [{ username: null, displayNames: ["x".repeat(101)] }, "displayNames"],
      [
        { username: null, displayNames: ["a", "b", "c", "d", "e", "f"] },
        "displayNames",
      ],
      [null, "displayNames"],
    ];
    for (const [body, field] of invalid) {
      const response = await request(`/venmo/${avery.id}`, admin.headers, {
        method: "PUT",
        body,
      });
      expect(response.status).toBe(422);
      expect((await response.json<ApiError>()).fields).toHaveProperty(field);
    }
    const account = { username: null, displayNames: [] };
    expect(
      (
        await request("/venmo/abc", admin.headers, {
          method: "PUT",
          body: account,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/venmo/9999", admin.headers, {
          method: "PUT",
          body: account,
        })
      ).status,
    ).toBe(404);

    let response = await request(
      `/venmo/${avery.id}?season=2025`,
      admin.headers,
      {
        method: "PUT",
        body: {
          username: " @Avery-Quinn_1 ",
          // Six entries, but only five once case-insensitive repeats are dropped.
          displayNames: [
            " Avery Quinn ",
            "AVERY QUINN",
            "Avery Q",
            "AQ",
            "Ave",
            "Avery",
          ],
        },
      },
    );
    expect(response.status).toBe(200);
    let data = await response.json<PaymentsData>();
    expect(data.season).toBe(2025);
    expect(data.venmoAccounts).toEqual([
      {
        userId: avery.id,
        username: "Avery-Quinn_1",
        displayNames: ["Avery Quinn", "Avery Q", "AQ", "Ave", "Avery"],
      },
    ]);

    // A name another player already uses is rejected, in any case or spacing.
    response = await request(`/venmo/${jordan.id}`, admin.headers, {
      method: "PUT",
      body: { username: "jordan-b", displayNames: ["Jordan", "avery  q"] },
    });
    expect(response.status).toBe(422);
    expect((await response.json<ApiError>()).fields).toEqual({
      displayNames: "Already used by another player: avery  q",
    });

    // Re-saving one's own names succeeds; a username alone still lists the player.
    response = await request(`/venmo/${avery.id}`, admin.headers, {
      method: "PUT",
      body: { username: "", displayNames: ["avery q"] },
    });
    expect(response.status).toBe(200);
    response = await request(`/venmo/${jordan.id}`, admin.headers, {
      method: "PUT",
      body: { username: "@jordan-b", displayNames: [] },
    });
    data = await response.json<PaymentsData>();
    expect(data.season).toBe(2026);
    expect(data.venmoAccounts).toEqual([
      { userId: avery.id, username: null, displayNames: ["avery q"] },
      { userId: jordan.id, username: "jordan-b", displayNames: [] },
    ]);

    // Clearing everything removes the player from the list.
    response = await request(`/venmo/${avery.id}`, admin.headers, {
      method: "PUT",
      body: { username: null, displayNames: [] },
    });
    data = await response.json<PaymentsData>();
    expect(data.venmoAccounts.map((item) => item.userId)).toEqual([jordan.id]);
  });

  it("validates, normalizes, and replaces keywords", async () => {
    const admin = await login("333333333333333333", true);
    mockEspn(context, {});
    for (const keywords of [
      ["x"],
      ["y".repeat(41)],
      [3],
      "pickem",
      Array.from({ length: 21 }, (_, index) => `word${index}`),
    ]) {
      const response = await request("/keywords", admin.headers, {
        method: "PUT",
        body: { keywords },
      });
      expect(response.status).toBe(422);
      expect((await response.json<ApiError>()).fields).toHaveProperty(
        "keywords",
      );
    }
    let response = await request("/keywords?season=2025", admin.headers, {
      method: "PUT",
      body: { keywords: [" Pickem ", "NFL", "pickem", "football pool"] },
    });
    expect(response.status).toBe(200);
    let data = await response.json<PaymentsData>();
    expect(data.season).toBe(2025);
    expect(data.keywords).toEqual(["football pool", "nfl", "pickem"]);

    response = await request("/keywords", admin.headers, {
      method: "PUT",
      body: { keywords: [] },
    });
    data = await response.json<PaymentsData>();
    expect(data.keywords).toEqual([]);
  });
});

describe("Venmo statement import", () => {
  it("files payments by keyword and name, then dedupes a re-import", async () => {
    const { admin, avery, jordan, casey } = await configuredPool();
    const { result, data } = await importStatement(admin.headers);
    expect(result).toEqual({
      approved: 4,
      pending: 2,
      duplicates: 0,
      skipped: 1,
    });
    expect(data.season).toBe(2026);
    expect(entry(data, "9001")).toMatchObject({
      season: 2026,
      userId: avery.id,
      direction: "in",
      amountCents: 500,
      source: "venmo_csv",
      status: "approved",
      note: "Pickem week 1, thanks!",
      venmoName: "Avery Quinn",
      paidAt: "2026-09-10T18:22:11.000Z",
    });
    expect(entry(data, "9002")).toMatchObject({
      userId: jordan.id,
      status: "approved",
      venmoName: "jordan  blake",
    });
    // A known name without a keyword waits for review with the player filled in.
    expect(entry(data, "9003")).toMatchObject({
      userId: casey.id,
      status: "pending",
      amountCents: 125050,
    });
    expect(entry(data, "9004")).toMatchObject({
      userId: avery.id,
      direction: "out",
      status: "approved",
    });
    expect(entry(data, "9006")).toMatchObject({
      userId: null,
      direction: "out",
      status: "pending",
      venmoName: "Taylor Reed",
    });
    // A January payment belongs to the season that started the year before.
    expect(entry(data, "9007")).toMatchObject({
      season: 2026,
      userId: jordan.id,
      status: "approved",
    });
    expect(balance(data, avery.id)).toBe(500);
    expect(balance(data, casey.id)).toBe(0);

    const again = await importStatement(admin.headers);
    expect(again.result).toEqual({
      approved: 0,
      pending: 0,
      duplicates: 6,
      skipped: 1,
    });
    expect(await entryCount()).toBe(6);
  });

  it("files the season by payment date and reports data for the requested season", async () => {
    const { admin, jordan } = await configuredPool();
    const response = await request("/import", admin.headers, {
      body: {
        csv: [
          header,
          ",9100,2026-02-15T03:15:00,Payment,Complete,pickem playoffs,Jordan Blake,Robin Ledger,+ $10.00,0",
        ].join("\n"),
      },
    });
    expect(response.status).toBe(200);
    const { data, result } = await response.json<VenmoImportResponse>();
    expect(result).toEqual({
      approved: 1,
      pending: 0,
      duplicates: 0,
      skipped: 0,
    });
    // No season requested: the current season, which the February payment is not in.
    expect(data.season).toBe(2026);
    expect(data.entries).toEqual([]);
    const previous = await (
      await request("?season=2025", admin.headers, { method: "GET" })
    ).json<PaymentsData>();
    expect(previous.entries).toEqual([
      expect.objectContaining({ season: 2025, userId: jordan.id }),
    ]);
  });

  it("rejects missing, malformed, and oversized statements", async () => {
    const admin = await login("333333333333333333", true);
    mockEspn(context, {});
    for (const body of [{ csv: "" }, { csv: 7 }, {}, "not json"]) {
      const response = await request("/import", admin.headers, { body });
      expect(response.status).toBe(422);
      expect((await response.json<ApiError>()).fields).toHaveProperty("csv");
    }
    const response = await request("/import", admin.headers, {
      body: { csv: "Date,Amount\n2026-09-10,5" },
    });
    expect(response.status).toBe(422);
    expect((await response.json<ApiError>()).fields?.csv).toMatch(/header/);
    const large = await request("/import", admin.headers, {
      body: { csv: `${header}\n${"x".repeat(2 * 1024 * 1024)}` },
    });
    expect(large.status).toBe(413);
    expect(
      (
        await request("/import?season=26", admin.headers, {
          body: { csv: statement },
        })
      ).status,
    ).toBe(400);
    expect(await entryCount()).toBe(0);
  });
});

describe("Venmo review queue", () => {
  it("approves a pending payment into a chosen player and season", async () => {
    const { admin, casey } = await configuredPool();
    const { data } = await importStatement(admin.headers);
    const dinner = entry(data, "9003");
    const stranger = entry(data, "9006");

    const invalid: [unknown, string][] = [
      [{ userId: casey.id, season: 1919 }, "season"],
      [{ userId: casey.id, season: "2026" }, "season"],
      [{ userId: 0, season: 2026 }, "userId"],
      [{ userId: 9999, season: 2026 }, "userId"],
      [null, "userId"],
    ];
    for (const [body, field] of invalid) {
      const response = await request(`/${dinner.id}/approve`, admin.headers, {
        body,
      });
      expect(response.status).toBe(422);
      expect((await response.json<ApiError>()).fields).toHaveProperty(field);
    }
    const approval = { userId: casey.id, season: 2026 };
    expect(
      (await request("/9999/approve", admin.headers, { body: approval }))
        .status,
    ).toBe(404);
    expect(
      (await request("/abc/approve", admin.headers, { body: approval })).status,
    ).toBe(400);

    let response = await request(`/${dinner.id}/approve`, admin.headers, {
      body: approval,
    });
    expect(response.status).toBe(200);
    let updated = await response.json<PaymentsData>();
    expect(entry(updated, "9003").status).toBe("approved");
    expect(balance(updated, casey.id)).toBe(125050);
    expect(
      (
        await request(`/${dinner.id}/approve`, admin.headers, {
          body: approval,
        })
      ).status,
    ).toBe(409);

    // An unmatched payment can be assigned to anyone and moved to another season.
    response = await request(`/${stranger.id}/approve`, admin.headers, {
      body: { userId: casey.id, season: 2025 },
    });
    expect(response.status).toBe(200);
    updated = await response.json<PaymentsData>();
    expect(updated.season).toBe(2025);
    expect(updated.entries).toEqual([
      expect.objectContaining({
        id: stranger.id,
        season: 2025,
        userId: casey.id,
        status: "approved",
      }),
    ]);
    expect(updated.players).toEqual([
      expect.objectContaining({
        user: { id: casey.id, username: casey.username },
        paidOutCents: 500,
      }),
    ]);
  });

  it("ignores pending payments and reopens reviewed Venmo payments", async () => {
    const { admin, avery, casey } = await configuredPool();
    const { data } = await importStatement(admin.headers);
    const dinner = entry(data, "9003");
    const fee = entry(data, "9001");

    let response = await request(`/${dinner.id}/ignore`, admin.headers);
    expect(response.status).toBe(200);
    let updated = await response.json<PaymentsData>();
    expect(entry(updated, "9003").status).toBe("ignored");
    expect(balance(updated, casey.id)).toBe(0);
    expect((await request(`/${dinner.id}/ignore`, admin.headers)).status).toBe(
      409,
    );
    expect((await request(`/${fee.id}/ignore`, admin.headers)).status).toBe(
      409,
    );
    expect((await request("/9999/ignore", admin.headers)).status).toBe(404);

    // Ignored and approved Venmo entries both return to the queue.
    response = await request(`/${dinner.id}/reopen`, admin.headers);
    expect(response.status).toBe(200);
    updated = await response.json<PaymentsData>();
    expect(entry(updated, "9003")).toMatchObject({
      status: "pending",
      userId: casey.id,
    });
    response = await request(`/${fee.id}/reopen`, admin.headers);
    updated = await response.json<PaymentsData>();
    expect(entry(updated, "9001")).toMatchObject({
      status: "pending",
      userId: avery.id,
    });
    expect(balance(updated, avery.id)).toBe(0);
    expect((await request(`/${fee.id}/reopen`, admin.headers)).status).toBe(
      409,
    );
    expect((await request("/9999/reopen", admin.headers)).status).toBe(404);

    // A voided Venmo entry stays voided; a manual entry is corrected by voiding.
    const winnings = entry(data, "9004");
    expect((await request(`/${winnings.id}/void`, admin.headers)).status).toBe(
      200,
    );
    expect(
      (await request(`/${winnings.id}/reopen`, admin.headers)).status,
    ).toBe(409);
    response = await request("", admin.headers, {
      body: {
        season: 2026,
        userId: avery.id,
        direction: "in",
        amountCents: 500,
        paidAt: "2026-09-10T12:00:00Z",
        note: null,
      },
    });
    updated = await response.json<PaymentsData>();
    const manual = updated.entries.find((item) => item.source === "manual");
    assert(manual);
    expect((await request(`/${manual.id}/reopen`, admin.headers)).status).toBe(
      409,
    );
  });

  it("fills in the player on unassigned pending entries when names are saved", async () => {
    const admin = await login("333333333333333333", true);
    mockEspn(context, {});
    const avery = await player("700000000000000001", "avery");
    await request("/keywords", admin.headers, {
      method: "PUT",
      body: { keywords: ["pickem"] },
    });
    const { data, result } = await importStatement(admin.headers);
    expect(result).toMatchObject({ approved: 0, pending: 6 });
    const fee = entry(data, "9001");
    const winnings = entry(data, "9004");
    await request(`/${winnings.id}/ignore`, admin.headers);

    const response = await request(`/venmo/${avery.id}`, admin.headers, {
      method: "PUT",
      body: { username: null, displayNames: ["avery quinn"] },
    });
    const updated = await response.json<PaymentsData>();
    // Prefilled but never approved retroactively; ignored entries stay untouched.
    expect(entry(updated, "9001")).toMatchObject({
      id: fee.id,
      userId: avery.id,
      status: "pending",
    });
    expect(entry(updated, "9004")).toMatchObject({
      userId: null,
      status: "ignored",
    });
    expect(entry(updated, "9006").userId).toBeNull();
    expect(balance(updated, avery.id)).toBe(0);
  });
});
