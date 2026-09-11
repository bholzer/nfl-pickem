import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ensureTokenUser, listUsers } from "../../src/server/db";
import {
  base64url,
  generateSubmissionToken,
  signToken,
} from "../../src/server/tokens";
import { app, cookieHeader, login, origin, testEnv } from "./auth-helpers";

async function startOAuth(returnTo = "/submissions/new?week=9") {
  const response = await app.request(
    `${origin}/auth/discord?return_to=${encodeURIComponent(returnTo)}`,
    {},
    testEnv,
  );
  expect(response.status).toBe(302);
  const location = response.headers.get("Location");
  assert(location);
  const provider = new URL(location);
  const state = provider.searchParams.get("state");
  assert(state);
  return {
    provider,
    cookie: cookieHeader(response, "pickem_oauth"),
    state,
  };
}

function providerIdentity(id: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new Request(input, init).url;
    if (url === "https://discord.com/api/v10/oauth2/token") {
      const body = init?.body;
      assert(body instanceof URLSearchParams);
      expect(body.get("redirect_uri")).toBe(`${origin}/auth/discord/callback`);
      expect(body.get("code_verifier")).toMatch(/^[\w-]{43}$/);
      return Promise.resolve(
        Response.json({
          access_token: "synthetic-access",
          token_type: "Bearer",
          scope: "identify",
        }),
      );
    }
    if (url === "https://discord.com/api/v10/users/@me") {
      return Promise.resolve(Response.json({ id }));
    }
    throw new Error("Unexpected outbound request");
  });
}

describe("signed links and browser sessions", () => {
  it("provisions legitimate Discord-string identity and removes bearer token from the URL", async () => {
    const token = await signToken(
      {
        user_id: "999999999999999999",
        username: "New player",
        season: 2025,
        week: 7,
        exp: Math.floor(Date.now() / 1000) + 1000,
      },
      testEnv.SUBMISSION_TOKEN_SECRET,
    );
    const response = await app.request(
      `${origin}/submissions/new?token=${token}&season=2026&week=1`,
      {},
      { ...testEnv, APP_ENV: "staging", APP_ORIGIN: "https://pool.example" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/submissions/new?season=2025&week=7",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2678400");
    const users = await listUsers(env.DB);
    const generatedId: unknown = expect.any(Number);
    expect(users).toEqual([
      {
        id: generatedId,
        discordId: "999999999999999999",
        username: "New player",
        admin: false,
      },
    ]);
  });

  it("keeps the active identity while taking the verified link's season and week", async () => {
    const first = await login();
    const other = {
      id: 900,
      discordId: "222222222222222222",
      username: "Other",
      admin: true,
    };
    const token = await generateSubmissionToken(
      other,
      { season: 2025, week: 12 },
      testEnv.SUBMISSION_TOKEN_SECRET,
    );
    const response = await app.request(
      `${origin}/submissions/new?token=${token}&season=2026&week=12`,
      { headers: { Cookie: first.cookie } },
      testEnv,
    );
    expect(response.headers.get("Location")).toBe(
      "/submissions/new?season=2025&week=12",
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await listUsers(env.DB)).toEqual([first.user]);
    const session = await app.request(
      `${origin}/api/session`,
      { headers: { Cookie: first.cookie } },
      testEnv,
    );
    expect(await session.json()).toEqual({
      user: first.user,
      csrfToken: first.csrf,
    });
  });

  it("rejects expired, algorithm-switched, invalid-signature, and malformed identity tokens", async () => {
    const payload = {
      user_id: "123456789012345678",
      username: "Player",
      season: 2026,
      week: 1,
      exp: Math.floor(Date.now() / 1000) + 1000,
    };
    const valid = await signToken(payload, testEnv.SUBMISSION_TOKEN_SECRET);
    const wrongAlg = `${base64url(new TextEncoder().encode(JSON.stringify({ alg: "none" })))}.${valid.split(".")[1]}.${valid.split(".")[2]}`;
    const wrongSeason = `${valid.split(".")[0]}.${base64url(new TextEncoder().encode(JSON.stringify({ ...payload, season: 2025 })))}.${valid.split(".")[2]}`;
    const tokens = [
      await signToken(
        { ...payload, exp: Math.floor(Date.now() / 1000) },
        testEnv.SUBMISSION_TOKEN_SECRET,
      ),
      await signToken(
        { ...payload, user_id: 123 },
        testEnv.SUBMISSION_TOKEN_SECRET,
      ),
      await signToken(
        { ...payload, week: 19 },
        testEnv.SUBMISSION_TOKEN_SECRET,
      ),
      await signToken(
        payload,
        "a-different-synthetic-signing-secret-0123456789",
      ),
      wrongAlg,
      wrongSeason,
      "not-a-jwt",
    ];
    for (const token of tokens) {
      const response = await app.request(
        `${origin}/submissions/new?token=${token}`,
        {},
        testEnv,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect(await listUsers(env.DB)).toEqual([]);
  });

  it("rejects yearless signed links without provisioning a user", async () => {
    const token = await signToken(
      {
        user_id: "123456789012345678",
        username: "Legacy player",
        week: 1,
        exp: Math.floor(Date.now() / 1000) + 1000,
      },
      testEnv.SUBMISSION_TOKEN_SECRET,
    );
    const response = await app.request(
      `${origin}/submissions/new?token=${token}&season=2026`,
      {},
      testEnv,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await listUsers(env.DB)).toEqual([]);
  });

  it("fails closed for absent, weak, shared signing keys and unsafe application origins", async () => {
    const token = await signToken(
      {
        user_id: "123",
        username: "Player",
        season: 2026,
        week: 1,
        exp: Math.floor(Date.now() / 1000) + 1000,
      },
      testEnv.SUBMISSION_TOKEN_SECRET,
    );
    for (const overrides of [
      { SESSION_SECRET: "" },
      { SESSION_SECRET: "short" },
      { SESSION_SECRET: testEnv.SUBMISSION_TOKEN_SECRET },
      { APP_ENV: "production" as const, APP_ORIGIN: "http://pool.example" },
    ]) {
      const response = await app.request(
        `${origin}/submissions/new?token=${token}`,
        {},
        { ...testEnv, ...overrides },
      );
      expect(response.status).toBe(503);
    }
    expect(await listUsers(env.DB)).toEqual([]);
  });

  it("returns anonymous sessions and rejects expired or tampered session authority", async () => {
    expect(
      await (await app.request(`${origin}/api/session`, {}, testEnv)).json(),
    ).toEqual({ user: null, csrfToken: null });
    const identity = await login();
    const expired = await signToken(
      {
        purpose: "session",
        userId: identity.user.id,
        csrf: identity.csrf,
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      testEnv.SESSION_SECRET,
    );
    for (const cookie of [
      `pickem_session=${expired}`,
      `${identity.cookie}corrupted`,
    ]) {
      expect(
        (
          await app.request(
            `${origin}/api/submissions`,
            { headers: { Cookie: cookie } },
            testEnv,
          )
        ).status,
      ).toBe(401);
    }
  });

  it("requires origin and session-bound CSRF to end a session", async () => {
    const first = await login();
    const second = await login("222222222222222222");
    const rejectedHeaders: Record<string, string>[] = [
      { Cookie: first.cookie },
      { ...first.headers, Origin: "https://evil.example" },
      { ...first.headers, "X-CSRF-Token": second.csrf },
    ];
    for (const headers of rejectedHeaders) {
      expect(
        (
          await app.request(
            `${origin}/logout`,
            { method: "DELETE", headers },
            testEnv,
          )
        ).status,
      ).toBe(403);
    }
    const response = await app.request(
      `${origin}/logout`,
      { method: "DELETE", headers: first.headers },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await response.json()).toEqual({ user: null, csrfToken: null });
  });
});

describe("Discord OAuth", () => {
  it("admits existing accounts using identify scope and restores a local return path", async () => {
    const user = await ensureTokenUser(env.DB, {
      discordId: "123456789012345678",
      username: "Existing",
    });
    const flow = await startOAuth();
    expect(flow.provider.searchParams.get("scope")).toBe("identify");
    expect(flow.provider.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    providerIdentity(user.discordId);
    const response = await app.request(
      `${origin}/auth/discord/callback?state=${flow.state}&code=synthetic-code`,
      { headers: { Cookie: flow.cookie } },
      testEnv,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/submissions/new?week=9");
    expect(
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith("pickem_oauth=")),
    ).toContain("Max-Age=0");
    const session = await app.request(
      `${origin}/api/session`,
      { headers: { Cookie: cookieHeader(response, "pickem_session") } },
      testEnv,
    );
    const csrfToken: unknown = expect.any(String);
    expect(await session.json()).toEqual({
      user,
      csrfToken,
    });
  });

  it("denies unregistered accounts without creating users", async () => {
    const flow = await startOAuth();
    providerIdentity("987654321098765432");
    const response = await app.request(
      `${origin}/auth/discord/callback?state=${flow.state}&code=synthetic-code`,
      { headers: { Cookie: flow.cookie } },
      testEnv,
    );
    expect(response.status).toBe(403);
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("pickem_session=")),
    ).toBe(false);
    expect(await listUsers(env.DB)).toEqual([]);
  });

  it("rejects mismatched, tampered and expired state before contacting Discord", async () => {
    const flow = await startOAuth();
    const fetch = vi.spyOn(globalThis, "fetch");
    const expired = await signToken(
      {
        purpose: "oauth",
        nonce: flow.state,
        verifier: "x",
        returnTo: "/standings",
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      testEnv.SESSION_SECRET,
    );
    for (const [state, cookie] of [
      ["wrong-state", flow.cookie],
      [flow.state, `${flow.cookie}corrupted`],
      [flow.state, `pickem_oauth=${expired}`],
      [flow.state, ""],
    ] as const) {
      const response = await app.request(
        `${origin}/auth/discord/callback?state=${state}&code=synthetic-code`,
        { headers: { Cookie: cookie } },
        testEnv,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not permit external or credential-bearing return URLs", async () => {
    await ensureTokenUser(env.DB, {
      discordId: "123456789012345678",
      username: "Existing",
    });
    providerIdentity("123456789012345678");
    for (const path of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/submissions/new?token=secret",
      "/auth/discord",
    ]) {
      const flow = await startOAuth(path);
      const response = await app.request(
        `${origin}/auth/discord/callback?state=${flow.state}&code=synthetic-code`,
        { headers: { Cookie: flow.cookie } },
        testEnv,
      );
      expect(response.headers.get("Location")).toBe("/standings");
    }
  });

  it("reports malformed provider responses without exposing tokens or secrets", async () => {
    const flow = await startOAuth();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "secret-provider-value",
        token_type: "unexpected",
      }),
    );
    const response = await app.request(
      `${origin}/auth/discord/callback?state=${flow.state}&code=synthetic-code`,
      { headers: { Cookie: flow.cookie } },
      testEnv,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(
      /secret-provider-value|synthetic-oauth-secret|synthetic-code/,
    );
    expect(await listUsers(env.DB)).toEqual([]);
  });
});
