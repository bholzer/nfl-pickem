import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ensureTokenUser, saveSubmission } from "../../src/server/db";
import type { FrozenReceipt } from "../../src/server/receipts";
import {
  submissionSummary,
  verificationHash,
} from "../../src/server/services/summary";
import type {
  Picks,
  PublicReceipt,
  SeasonWeek,
  SubmissionWithUser,
} from "../../src/shared/contracts";
import { espnEvent, espnScoreboard, scoreboardFixture } from "../fixtures/espn";
import { app, mockScoreboard, origin, testEnv } from "./auth-helpers";

async function createSubmission(
  discordId = "111111111111111111",
  picks: Picks = { "401": "home-401", "402": "home-402" },
  period: SeasonWeek = { season: 2026, week: 1 },
): Promise<SubmissionWithUser> {
  const user = await ensureTokenUser(env.DB, {
    discordId,
    username: "Zoë — frozen name",
  });
  const submission = await saveSubmission(env.DB, {
    ...period,
    userId: user.id,
    picks,
    tiebreaker: 913,
    locked: false,
  });
  assert(submission);
  return { ...submission, user };
}

async function freezeReceipt(
  submission: SubmissionWithUser,
  options: { published?: boolean; gameIds?: string[] } = {},
): Promise<FrozenReceipt> {
  const publicationId = crypto.randomUUID();
  const scoreboard = scoreboardFixture(
    [{ id: "401" }, { id: "402" }],
    submission.week,
    submission.season,
  );
  const receipt: FrozenReceipt = {
    id: crypto.randomUUID(),
    season: submission.season,
    week: submission.week,
    submissionId: submission.id,
    username: submission.user.username,
    summary: submissionSummary(submission, scoreboard),
    verificationHash: await verificationHash(submission, scoreboard),
    gameIds: options.gameIds ?? ["401", "402"],
    snapshotAt: "2026-09-13T17:05:00.000Z",
    originalMessageUrl:
      options.published === false
        ? null
        : "https://discord.com/channels/8888/9999/123456789",
  };
  const statements = [
    env.DB.prepare(
      `INSERT INTO hash_publications
       (snapshot_key, id, season, week, channel_id, guild_id, snapshot_at)
       VALUES (?, ?, ?, ?, '9999', '8888', ?)`,
    ).bind(
      `receipt-test:${publicationId}`,
      publicationId,
      receipt.season,
      receipt.week,
      receipt.snapshotAt,
    ),
    env.DB.prepare(
      `INSERT INTO hash_receipts
       (id, publication_id, submission_id, username, summary, verification_hash, game_ids, part_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      receipt.id,
      publicationId,
      receipt.submissionId,
      receipt.username,
      receipt.summary,
      receipt.verificationHash,
      JSON.stringify(receipt.gameIds),
    ),
  ];
  if (receipt.originalMessageUrl) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO hash_publication_parts
         (publication_id, part_index, channel_id, message_id, published_at)
         VALUES (?, 0, '9999', '123456789', ?)`,
      ).bind(publicationId, receipt.snapshotAt),
    );
  }
  await env.DB.batch(statements);
  return receipt;
}

function requestReceipt(id: string, query = "") {
  return app.request(`${origin}/api/receipts/${id}${query}`, {}, testEnv);
}

function finalBoard() {
  return espnScoreboard([
    espnEvent({ id: "401", status: "STATUS_FINAL" }),
    espnEvent({ id: "402", status: "STATUS_FINAL" }),
  ]);
}

describe("public winner receipts", () => {
  it("reveals a published final winner's exact frozen receipt without authentication", async () => {
    const winner = await createSubmission();
    await createSubmission("222222222222222222", {
      "401": "away-401",
      "402": "away-402",
    });
    const receipt = await freezeReceipt(winner);
    mockScoreboard(finalBoard());

    const response = await requestReceipt(receipt.id);
    expect(response.status).toBe(200);
    const data = await response.json<PublicReceipt>();
    expect(data).toEqual({
      id: receipt.id,
      season: 2026,
      week: 1,
      username: receipt.username,
      verificationHash: receipt.verificationHash,
      snapshotAt: receipt.snapshotAt,
      originalMessageUrl: receipt.originalMessageUrl,
      summary: receipt.summary,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    for (const path of [
      "standings",
      `submissions/${winner.id}`,
      `admin/submissions/${winner.id}`,
    ]) {
      expect(
        (await app.request(`${origin}/api/${path}`, {}, testEnv)).status,
      ).toBe(401);
    }
  });

  it("reveals the exact receipt once a winner clinches with another game still live", async () => {
    const winner = await createSubmission();
    await createSubmission("222222222222222222", {
      "401": "away-401",
      "402": "home-402",
    });
    const receipt = await freezeReceipt(winner);
    const fetch = mockScoreboard(
      espnScoreboard([
        espnEvent({ id: "401", status: "STATUS_IN_PROGRESS" }),
        espnEvent({ id: "402", status: "STATUS_IN_PROGRESS" }),
      ]),
    );

    expect((await requestReceipt(receipt.id)).status).toBe(404);

    fetch.mockResolvedValue(
      Response.json(
        espnScoreboard([
          espnEvent({ id: "401", status: "STATUS_FINAL" }),
          espnEvent({ id: "402", status: "STATUS_IN_PROGRESS" }),
        ]),
      ),
    );
    const response = await requestReceipt(receipt.id);
    expect(response.status).toBe(200);
    const data = await response.json<PublicReceipt>();
    expect(data.summary).toBe(receipt.summary);
    expect(data.summary).toContain("Tiebreaker: 913");
    expect(data.verificationHash).toBe(receipt.verificationHash);
  });

  it("does not reveal a current leader while another player can still tie", async () => {
    const leader = await createSubmission();
    await createSubmission("222222222222222222", {
      "401": "away-401",
      "402": "away-402",
    });
    const receipt = await freezeReceipt(leader);
    mockScoreboard(
      espnScoreboard([
        espnEvent({ id: "401", status: "STATUS_FINAL" }),
        espnEvent({ id: "402", status: "STATUS_IN_PROGRESS" }),
      ]),
    );

    const response = await requestReceipt(receipt.id);
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("summary");
  });

  it("does not expose known IDs for nonwinners or unconfirmed publications", async () => {
    await createSubmission();
    const loser = await createSubmission("222222222222222222", {
      "401": "away-401",
    });
    const losingReceipt = await freezeReceipt(loser);
    const unpublished = await freezeReceipt(
      await createSubmission("333333333333333333"),
      { published: false },
    );
    mockScoreboard(finalBoard());

    for (const id of [
      losingReceipt.id,
      unpublished.id,
      crypto.randomUUID(),
      "not-a-uuid",
    ]) {
      const response = await requestReceipt(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Receipt not found" });
    }
  });

  it("denies empty or missing snapshot coverage, including games the winner never picked", async () => {
    const winner = await createSubmission(undefined, { "401": "home-401" });
    const receipt = await freezeReceipt(winner);
    const fetch = mockScoreboard(
      espnScoreboard([espnEvent({ id: "401", status: "STATUS_FINAL" })]),
    );
    const missing = await requestReceipt(receipt.id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Receipt not found" });

    fetch.mockResolvedValue(Response.json(espnScoreboard([])));
    expect((await requestReceipt(receipt.id)).status).toBe(502);
    fetch.mockResolvedValue(Response.json(finalBoard()));
    const emptySnapshot = await freezeReceipt(winner, { gameIds: [] });
    expect((await requestReceipt(emptySnapshot.id)).status).toBe(404);
  });

  it("reveals a clinched winner's receipt even with an additional scheduled game", async () => {
    const receipt = await freezeReceipt(await createSubmission());
    mockScoreboard(
      espnScoreboard([
        ...finalBoard().events,
        espnEvent({ id: "403", status: "STATUS_SCHEDULED" }),
      ]),
    );
    const response = await requestReceipt(receipt.id);
    expect(response.status).toBe(200);
    const data = await response.json<PublicReceipt>();
    expect(data.summary).toBe(receipt.summary);
  });

  it("ignores conflicting query periods and preserves frozen text despite name, picks and ESPN drift", async () => {
    const winner = await createSubmission();
    const receipt = await freezeReceipt(winner);
    await env.DB.prepare("UPDATE users SET discord_username = ? WHERE id = ?")
      .bind("Changed current name", winner.user.id)
      .run();
    await saveSubmission(env.DB, {
      userId: winner.user.id,
      season: 2026,
      week: 1,
      picks: { "401": "home-401" },
      tiebreaker: 7,
      locked: false,
    });
    await createSubmission(
      winner.user.discordId ?? undefined,
      {},
      { season: 2025, week: 2 },
    );
    const fetch = mockScoreboard(
      espnScoreboard([
        espnEvent({
          id: "401",
          status: "STATUS_FINAL",
          name: "Changed game name",
          homeName: "Changed team name",
        }),
        espnEvent({ id: "402", status: "STATUS_FINAL" }),
      ]),
    );

    const response = await requestReceipt(receipt.id, "?season=2025&week=2");
    expect(response.status).toBe(200);
    const data = await response.json<PublicReceipt>();
    expect(data).toMatchObject({
      season: 2026,
      week: 1,
      username: receipt.username,
      verificationHash: receipt.verificationHash,
      snapshotAt: receipt.snapshotAt,
      summary: receipt.summary,
    });
    const input = fetch.mock.calls[0]?.[0];
    assert(input);
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.searchParams.get("dates")).toBe("2026");
    expect(url.searchParams.get("week")).toBe("1");
  });

  it("fails closed with safe errors when ESPN is unavailable or returns the wrong period", async () => {
    const receipt = await freezeReceipt(await createSubmission());
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("private upstream diagnostic"));
    const unavailable = await requestReceipt(receipt.id);
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({
      error: "Game data is temporarily unavailable",
    });

    fetch.mockResolvedValue(
      Response.json(espnScoreboard(finalBoard().events, 2, 2025)),
    );
    const wrongPeriod = await requestReceipt(receipt.id);
    expect(wrongPeriod.status).toBe(502);
    expect(await wrongPeriod.json()).toEqual({
      error: "Game data is temporarily unavailable",
    });
  });
});
