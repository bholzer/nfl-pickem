import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/server/env";
import type {
  Scoreboard,
  Standing,
  SubmissionWithUser,
  User,
} from "../../src/shared/contracts";
import {
  DiscordError,
  getChannelDestination,
  renderHashes,
  renderStandings,
  sendChannelMessage,
  sendDirectMessage,
  sendSubmissionLink,
  splitDiscordMessage,
} from "../../src/server/services/discord";
import { network } from "../setup-network";

const api = "https://discord.com/api/v10";
const recipient = "111111111111111111";
const channelId = "222222222222222222";
const dmId = "333333333333333333";

function decodeBase64Url(value: string) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
const user: User = {
  id: 1,
  discordId: recipient,
  username: "Alice",
  admin: false,
};
const config = (overrides: Partial<Env> = {}): Env =>
  ({
    APP_ENV: "staging",
    APP_ORIGIN: "https://picks.example.test",
    DISCORD_SEND_ENABLED: "true",
    DISCORD_BOT_TOKEN: "synthetic-test-bot-token",
    DISCORD_ALLOWED_USER_IDS: recipient,
    DISCORD_ALLOWED_CHANNEL_IDS: channelId,
    SUBMISSION_TOKEN_SECRET: "synthetic-submission-key-long-enough-for-tests",
    ...overrides,
  }) as Env;

const scoreboard: Scoreboard = {
  season: 2026,
  week: 2,
  games: [
    {
      id: "b",
      date: "2026-09-14T23:00:00Z",
      neutralSite: false,
      moneyline: null,
      name: "Bears at Packers",
      status: "STATUS_SCHEDULED",
      statusDetail: "Scheduled",
      winnerId: null,
      homeTeam: {
        id: "gb",
        name: "Green Bay Packers",
        abbreviation: "GB",
        logo: "",
        score: null,
      },
      awayTeam: {
        id: "chi",
        name: "Chicago Bears",
        abbreviation: "CHI",
        logo: "",
        score: null,
      },
    },
    {
      id: "a",
      date: "2026-09-13T17:00:00Z",
      neutralSite: false,
      moneyline: null,
      name: "Chiefs at Bills",
      status: "STATUS_SCHEDULED",
      statusDetail: "Scheduled",
      winnerId: null,
      homeTeam: {
        id: "buf",
        name: "Buffalo Bills",
        abbreviation: "BUF",
        logo: "",
        score: null,
      },
      awayTeam: {
        id: "kc",
        name: "Kansas City Chiefs",
        abbreviation: "KC",
        logo: "",
        score: null,
      },
    },
  ],
};
const submission: SubmissionWithUser = {
  id: 1,
  userId: user.id,
  user,
  season: 2026,
  week: 2,
  picks: { b: "gb", a: "kc" },
  tiebreaker: 42,
  createdAt: "2026-09-10T10:00:00Z",
  updatedAt: "2026-09-10T10:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("Discord approval boundary", () => {
  it.each([
    { APP_ENV: "production", DISCORD_SEND_ENABLED: "false" },
    { DISCORD_SEND_ENABLED: "TRUE" },
    { DISCORD_SEND_ENABLED: " true " },
    { DISCORD_BOT_TOKEN: " " },
    { DISCORD_ALLOWED_USER_IDS: "" },
    { DISCORD_ALLOWED_USER_IDS: `${recipient}9` },
  ] satisfies Partial<Env>[])(
    "rejects an unapproved DM before channel creation: %j",
    async (overrides) => {
      const outbound = vi.spyOn(globalThis, "fetch");
      await expect(
        sendDirectMessage(config(overrides), recipient, "hello"),
      ).rejects.toMatchObject({ retryable: false });
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it("does not grant a channel permission from a recipient allowlist", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    await expect(
      sendChannelMessage(
        config({ DISCORD_ALLOWED_CHANNEL_IDS: "" }),
        recipient,
        "hello",
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("requires an approved real server channel before receipt publication", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    await expect(
      getChannelDestination(
        config({ DISCORD_ALLOWED_CHANNEL_IDS: "" }),
        channelId,
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(outbound).not.toHaveBeenCalled();
    network.use(
      http.get(`${api}/channels/${channelId}`, () =>
        HttpResponse.json({ id: channelId, type: 1 }),
      ),
    );
    await expect(
      getChannelDestination(config(), channelId),
    ).rejects.toMatchObject({ retryable: false });
    network.use(
      http.get(`${api}/channels/${channelId}`, () =>
        HttpResponse.json({ id: channelId, guild_id: "555555555555555555" }),
      ),
    );
    expect(await getChannelDestination(config(), channelId)).toEqual({
      channelId,
      guildId: "555555555555555555",
    });
  });

  it("permits only the approved recipient's newly created DM channel", async () => {
    const requests: Array<{
      path: string;
      body: unknown;
      authorization: string | null;
    }> = [];
    network.use(
      http.post(`${api}/*`, async ({ request }) => {
        const path = new URL(request.url).pathname;
        requests.push({
          path,
          body: await request.json(),
          authorization: request.headers.get("Authorization"),
        });
        return HttpResponse.json(
          path.endsWith("/@me/channels")
            ? { id: dmId, type: 1, recipients: [{ id: recipient }] }
            : { id: "444444444444444444", channel_id: dmId },
        );
      }),
    );
    await sendDirectMessage(
      config({
        DISCORD_ALLOWED_CHANNEL_IDS: "",
        DISCORD_ALLOWED_USER_IDS: ` 999, ${recipient} `,
      }),
      recipient,
      "hello @everyone",
    );
    expect(requests).toEqual([
      {
        path: "/api/v10/users/@me/channels",
        body: { recipient_id: recipient },
        authorization: "Bot synthetic-test-bot-token",
      },
      {
        path: `/api/v10/channels/${dmId}/messages`,
        body: { content: "hello @everyone", allowed_mentions: { parse: [] } },
        authorization: "Bot synthetic-test-bot-token",
      },
    ]);
    await expect(
      sendChannelMessage(
        config({ DISCORD_ALLOWED_CHANNEL_IDS: "" }),
        dmId,
        "hello",
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(requests).toHaveLength(2);
  });

  it.each([
    { id: dmId, type: 1, recipients: [{ id: "999" }] },
    { id: dmId, type: 3, recipients: [{ id: recipient }] },
    { id: "../unapproved", type: 1, recipients: [{ id: recipient }] },
    {},
  ])("never sends to an unexpected DM response: %j", async (response) => {
    const outbound = vi.spyOn(globalThis, "fetch");
    network.use(
      http.post(`${api}/users/@me/channels`, () => HttpResponse.json(response)),
    );
    await expect(
      sendDirectMessage(config(), recipient, "hello"),
    ).rejects.toBeInstanceOf(DiscordError);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("rejects missing recipient and empty messages without HTTP", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    await expect(
      sendSubmissionLink(config(), { ...user, discordId: null }, scoreboard),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      sendDirectMessage(config(), recipient, "\n "),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      sendChannelMessage(config(), channelId, ""),
    ).rejects.toMatchObject({ retryable: false });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("allows a production channel only when explicitly enabled", async () => {
    const contents: unknown[] = [];
    network.use(
      http.post(
        `${api}/channels/${channelId}/messages`,
        async ({ request }) => {
          contents.push(await request.json());
          return HttpResponse.json({
            id: "444444444444444444",
            channel_id: channelId,
          });
        },
      ),
    );
    await sendChannelMessage(
      config({ APP_ENV: "production", DISCORD_ALLOWED_CHANNEL_IDS: "" }),
      channelId,
      "production message",
    );
    expect(contents).toEqual([
      { content: "production message", allowed_mentions: { parse: [] } },
    ]);
  });
});

describe("Discord failure semantics", () => {
  it.each([
    {
      status: 429,
      body: { retry_after: 2.75 },
      header: "1",
      retryable: true,
      delay: 2.75,
    },
    {
      status: 429,
      body: { retry_after: 1 },
      header: "4",
      retryable: true,
      delay: 4,
    },
    { status: 503, body: {}, header: "6", retryable: true, delay: 6 },
    { status: 500, body: {}, header: null, retryable: true, delay: null },
    {
      status: 403,
      body: { message: "private response" },
      header: null,
      retryable: false,
      delay: null,
    },
    { status: 400, body: {}, header: null, retryable: false, delay: null },
  ])(
    "propagates $status for durable retry scheduling without retrying inline",
    async ({ status, body, header, retryable, delay }) => {
      const outbound = vi.spyOn(globalThis, "fetch");
      network.use(
        http.post(`${api}/channels/${channelId}/messages`, () =>
          HttpResponse.json(body, {
            status,
            headers: header ? { "Retry-After": header } : {},
          }),
        ),
      );
      await expect(
        sendChannelMessage(
          config(),
          channelId,
          "private-token-bearing-content",
        ),
      ).rejects.toMatchObject({
        name: "DiscordError",
        message: `Discord request failed (HTTP ${status})`,
        retryable,
        retryAfterSeconds: delay,
      });
      expect(outbound).toHaveBeenCalledTimes(1);
    },
  );

  it("honors Retry-After dates when Discord returns an unreadable error body", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-10T12:00:00Z"));
    network.use(
      http.post(
        `${api}/channels/${channelId}/messages`,
        () =>
          new HttpResponse("not JSON", {
            status: 429,
            headers: { "Retry-After": "Thu, 10 Sep 2026 12:00:07 GMT" },
          }),
      ),
    );
    await expect(
      sendChannelMessage(config(), channelId, "hello"),
    ).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 7 });
  });

  it("propagates transport failures without exposing secrets", async () => {
    network.use(
      http.post(`${api}/channels/${channelId}/messages`, () =>
        HttpResponse.error(),
      ),
    );
    await expect(
      sendChannelMessage(config(), channelId, "secret-link"),
    ).rejects.toMatchObject({
      message: "Discord network request failed",
      retryable: true,
    });
  });

  it("does not report malformed success as delivered", async () => {
    network.use(
      http.post(`${api}/channels/${channelId}/messages`, () =>
        HttpResponse.json({}),
      ),
    );
    await expect(
      sendChannelMessage(config(), channelId, "hello"),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("aborts a stalled request within its deadline and surfaces a retryable timeout", async () => {
    vi.useFakeTimers();
    const {
      promise: requestStarted,
      resolve: started,
    }: PromiseWithResolvers<void> = Promise.withResolvers();
    let aborted = false;
    network.use(
      http.post(
        `${api}/channels/${channelId}/messages`,
        async ({ request }) => {
          started();
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return HttpResponse.error();
        },
      ),
    );
    try {
      const result = expect(
        sendChannelMessage(config(), channelId, "hello"),
      ).rejects.toMatchObject({
        message: "Discord request timed out",
        retryable: true,
      });
      await requestStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Discord content", () => {
  it("preserves the custom-domain submission route and signs season-bound token claims", async () => {
    let message = "";
    network.use(
      http.post(`${api}/users/@me/channels`, () =>
        HttpResponse.json({
          id: dmId,
          type: 1,
          recipients: [{ id: recipient }],
        }),
      ),
      http.post(`${api}/channels/${dmId}/messages`, async ({ request }) => {
        message = ((await request.json()) as { content: string }).content;
        return HttpResponse.json({
          id: "444444444444444444",
          channel_id: dmId,
        });
      }),
    );
    await sendSubmissionLink(config(), user, scoreboard);
    const match = message.match(/\]\((https:\/\/[^)]+)\)/);
    expect(match).not.toBeNull();
    assert(match?.[1]);
    const url = new URL(match[1]);
    expect(url.origin + url.pathname).toBe(
      "https://picks.example.test/submissions/new",
    );
    const token = url.searchParams.get("token");
    assert(token);
    const [header, payload, signature] = token.split(".");
    assert(header && payload && signature);
    const tokenHeader: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(header)),
    );
    expect(tokenHeader).toMatchObject({ alg: "HS256" });
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      user_id: recipient,
      username: "Alice",
      season: 2026,
      week: 2,
    });
    expect(claims.exp).toBeGreaterThan(Date.now() / 1_000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config().SUBMISSION_TOKEN_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        decodeBase64Url(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it("orders player entries by rank rather than input order", () => {
    const base: Standing = {
      user,
      submissionId: 1,
      correctPicks: 1,
      remainingPicks: {},
      tiebreaker: 42,
      tiebreakerDiff: 0,
      contender: true,
      winner: true,
      rank: 1,
    };
    const message = renderStandings(
      [
        {
          ...base,
          user: { ...user, id: 2, username: "Bob" },
          rank: 2,
          correctPicks: 0,
          winner: false,
          contender: false,
          tiebreakerDiff: null,
        },
        base,
      ],
      scoreboard,
    );
    expect(
      [...message.matchAll(/Alice|Bob/g)].map((match) => match[0]),
    ).toEqual(["Alice", "Bob"]);
  });

  it("hashes the complete chronological Rails summary including picks and tiebreaker", async () => {
    const summary =
      "Alice\nChiefs at Bills: Kansas City Chiefs\nBears at Packers: Green Bay Packers\nTiebreaker: 42";
    const digest = createHash("sha256").update(summary).digest("hex");
    const rendered = await renderHashes([submission], scoreboard);
    expect(rendered.message).toContain(digest);
    expect(rendered.receipts[0]).toMatchObject({
      summary,
      verificationHash: digest,
    });
    expect(
      (
        await renderHashes([{ ...submission, season: 2025 }], {
          ...scoreboard,
          season: 2025,
        })
      ).message,
    ).toContain(digest);
    const changed = await renderHashes(
      [{ ...submission, tiebreaker: 43 }],
      scoreboard,
    );
    expect(changed.message).not.toContain(digest);
  });

  it("rejects empty reports instead of marking missing work delivered", async () => {
    expect(() => renderStandings([], scoreboard)).toThrow(DiscordError);
    await expect(renderHashes([], scoreboard)).rejects.toBeInstanceOf(
      DiscordError,
    );
    await expect(
      renderHashes([submission], { ...scoreboard, week: 3 }),
    ).rejects.toBeInstanceOf(DiscordError);
    await expect(
      renderHashes([submission], { ...scoreboard, season: 2025 }),
    ).rejects.toBeInstanceOf(DiscordError);
    await expect(
      renderHashes([submission], { ...scoreboard, games: [] }),
    ).rejects.toBeInstanceOf(DiscordError);
  });

  it("delivers every complete hash entry in deterministic bounded messages", async () => {
    const submissions = Array.from({ length: 45 }, (_, index) => ({
      ...submission,
      id: index + 1,
      user: { ...user, username: `Player ${index + 1}` },
    }));
    const { message: rendered } = await renderHashes(submissions, scoreboard);
    const parts = splitDiscordMessage(rendered);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 2_000)).toBe(true);
    for (const line of rendered
      .split("\n")
      .filter((line) => line.startsWith("**"))) {
      expect(
        parts.filter((part) => part.split("\n").includes(line)),
      ).toHaveLength(1);
    }
    const sent: string[] = [];
    network.use(
      http.post(
        `${api}/channels/${channelId}/messages`,
        async ({ request }) => {
          sent.push(((await request.json()) as { content: string }).content);
          return HttpResponse.json({
            id: "444444444444444444",
            channel_id: channelId,
          });
        },
      ),
    );
    await sendChannelMessage(config(), channelId, rendered);
    expect(sent).toEqual(parts);
  });

  it("rejects oversize entries before any HTTP even when preceded by valid content", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    await expect(
      sendDirectMessage(config(), recipient, `header\n${"x".repeat(2_001)}`),
    ).rejects.toMatchObject({ retryable: false });
    expect(outbound).not.toHaveBeenCalled();
    expect(splitDiscordMessage("x".repeat(2_000))).toEqual(["x".repeat(2_000)]);
  });

  it("does not silently skip failed chunks or send subsequent chunks", async () => {
    const received: string[] = [];
    network.use(
      http.post(
        `${api}/channels/${channelId}/messages`,
        async ({ request }) => {
          received.push(
            ((await request.json()) as { content: string }).content,
          );
          return received.length === 2
            ? HttpResponse.json({}, { status: 503 })
            : HttpResponse.json({
                id: "444444444444444444",
                channel_id: channelId,
              });
        },
      ),
    );
    await expect(
      sendChannelMessage(
        config(),
        channelId,
        ["a", "b", "c"].map((letter) => letter.repeat(1_500)).join("\n"),
      ),
    ).rejects.toMatchObject({ retryable: true });
    expect(received).toEqual(["a".repeat(1_500), "b".repeat(1_500)]);
  });
});
