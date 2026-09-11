import assert from "node:assert/strict";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureTokenUser, getUserByDiscordId } from "../../src/server/db";
import { generateSubmissionToken } from "../../src/server/tokens";
import type {
  SessionData,
  StandingsData,
  SubmissionDetail,
  User,
} from "../../src/shared/contracts";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import worker from "../../src/server/index";

let board = espnScoreboard();

beforeEach(() => {
  board = espnScoreboard();
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "site.web.api.espn.com") {
      throw new Error("Unexpected integration-test upstream");
    }
    return Promise.resolve(Response.json(board));
  });
});

function request(path: string, init: RequestInit = {}) {
  return exports.default.fetch(
    new Request(new URL(path, env.APP_ORIGIN), { redirect: "manual", ...init }),
  );
}

async function login(user: User) {
  const token = await generateSubmissionToken(
    user,
    { season: 2026, week: 1 },
    env.SUBMISSION_TOKEN_SECRET,
  );
  const response = await request(
    `/submissions/new?token=${encodeURIComponent(token)}`,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).not.toContain(token);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const sessionResponse = await request("/api/session", {
    headers: { Cookie: cookie },
  });
  const session = await sessionResponse.json<SessionData>();
  expect(session.user?.id).toBe(user.id);
  expect(session.csrfToken).toEqual(expect.any(String));
  assert(session.csrfToken);
  return { cookie, csrf: session.csrfToken };
}

it("upgrades remote authentication to HTTPS before setting state while retaining local HTTP", async () => {
  const bindings = {
    ...env,
    APP_ENV: "staging" as const,
    APP_ORIGIN: "https://pickem-staging.bholzer.me",
  };
  const path = "/auth/discord?return_to=%2Fstandings%3Fweek%3D1";
  const redirect = await worker.fetch(
    new Request(`http://pickem-staging.bholzer.me${path}`),
    bindings,
  );
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("Location")).toBe(
    `${bindings.APP_ORIGIN}${path}`,
  );
  expect(redirect.headers.get("Set-Cookie")).toBeNull();
  expect(redirect.headers.get("Cache-Control")).toBe("no-store");

  const secureLocation = redirect.headers.get("Location");
  assert(secureLocation);
  const secure = await worker.fetch(new Request(secureLocation), bindings);
  expect(secure.status).toBe(302);
  const providerLocation = secure.headers.get("Location");
  assert(providerLocation);
  expect(new URL(providerLocation).origin).toBe("https://discord.com");
  expect(secure.headers.get("Set-Cookie")).toContain("Secure");

  const local = await worker.fetch(new Request("http://localhost:8787/up"), {
    ...env,
    APP_ENV: "local",
  });
  expect(local.status).toBe(200);
  expect(await local.json()).toEqual({ status: "ok" });
});

it("supports token login, pick submission, private detail and standings through the Worker entrypoint", async () => {
  const user = await ensureTokenUser(env.DB, {
    discordId: "1001",
    username: "Local Player",
  });
  const { cookie, csrf } = await login(user);
  const saved = await request("/api/submissions/1?season=2026", {
    method: "PUT",
    headers: {
      Cookie: cookie,
      Origin: env.APP_ORIGIN,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ picks: { "401": "home-401" }, tiebreaker: 41 }),
  });
  expect(saved.ok).toBe(true);
  const { submission } = await saved.json<{ submission: { id: number } }>();
  const detailResponse = await request(`/api/submissions/${submission.id}`, {
    headers: { Cookie: cookie },
  });
  expect(detailResponse.headers.get("Cache-Control")).toBe("no-store");
  const detail = await detailResponse.json<SubmissionDetail>();
  expect(detail.submission.user.id).toBe(user.id);
  expect(detail.submission.picks).toEqual({ "401": "home-401" });
  expect(detail.summary).toContain("Local Player");
  expect(detail.verificationHash).toMatch(/^[0-9a-f]{64}$/);
  const standings = await request("/api/standings?season=2026&week=1", {
    headers: { Cookie: cookie },
  });
  expect(standings.status).toBe(200);
  expect(
    (await standings.json<StandingsData>()).standings.map((row) => row.user.id),
  ).toEqual([user.id]);
});

it("blocks a cross-origin mutation and administrative job access through the combined routers", async () => {
  const user = await ensureTokenUser(env.DB, {
    discordId: "1001",
    username: "Local Player",
  });
  const { cookie, csrf } = await login(user);
  const write = await request("/api/submissions/1?season=2026", {
    method: "PUT",
    headers: {
      Cookie: cookie,
      Origin: "https://attacker.invalid",
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ picks: { "401": "home-401" }, tiebreaker: 41 }),
  });
  expect(write.status).toBe(403);
  expect(
    (await request("/api/admin/jobs", { headers: { Cookie: cookie } })).status,
  ).toBe(403);
  const history = await request("/api/submissions", {
    headers: { Cookie: cookie },
  });
  expect(await history.json()).toEqual({ submissions: [] });
});

it("never overwrites saved picks when refreshed upstream game data locks the week", async () => {
  const user = await ensureTokenUser(env.DB, {
    discordId: "1001",
    username: "Local Player",
  });
  const { cookie, csrf } = await login(user);
  const headers = {
    Cookie: cookie,
    Origin: env.APP_ORIGIN,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
  const initial = await request("/api/submissions/1?season=2026", {
    method: "PUT",
    headers,
    body: JSON.stringify({ picks: { "401": "home-401" }, tiebreaker: 41 }),
  });
  expect(initial.ok).toBe(true);
  const { submission } = await initial.json<{ submission: { id: number } }>();
  board = espnScoreboard([espnEvent({ status: "STATUS_IN_PROGRESS" })]);
  const changed = await request("/api/submissions/1?season=2026", {
    method: "PUT",
    headers,
    body: JSON.stringify({ picks: { "401": "away-401" }, tiebreaker: 10 }),
  });
  expect(changed.status).toBe(409);
  const detail = await (
    await request(`/api/submissions/${submission.id}`, {
      headers: { Cookie: cookie },
    })
  ).json<SubmissionDetail>();
  expect(detail.submission.picks).toEqual({ "401": "home-401" });
  expect(detail.submission.tiebreaker).toBe(41);
});

it("freezes submission and identity writes during migration while preserving read access and logout", async () => {
  const user = await ensureTokenUser(env.DB, {
    discordId: "1001",
    username: "Local Player",
  });
  const { cookie, csrf } = await login(user);
  const bindings = { ...env, MAINTENANCE_MODE: "true" };
  const headers = {
    Cookie: cookie,
    Origin: env.APP_ORIGIN,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
  const token = await generateSubmissionToken(
    { ...user, discordId: "1002", username: "New Player" },
    { season: 2026, week: 1 },
    env.SUBMISSION_TOKEN_SECRET,
  );
  for (const path of [
    `/submissions/new?token=${encodeURIComponent(token)}`,
    "/auth/discord/callback?code=unused",
  ]) {
    expect(
      (await worker.fetch(new Request(new URL(path, env.APP_ORIGIN)), bindings))
        .status,
    ).toBe(503);
  }
  expect(await getUserByDiscordId(env.DB, "1002")).toBeNull();
  const changed = await worker.fetch(
    new Request(new URL("/api/submissions/1?season=2026", env.APP_ORIGIN), {
      method: "PUT",
      headers,
      body: JSON.stringify({ picks: { "401": "home-401" }, tiebreaker: 41 }),
    }),
    bindings,
  );
  expect(changed.status).toBe(503);
  const history = await worker.fetch(
    new Request(new URL("/api/submissions", env.APP_ORIGIN), { headers }),
    bindings,
  );
  expect(await history.json()).toEqual({ submissions: [] });
  const logout = await worker.fetch(
    new Request(new URL("/logout", env.APP_ORIGIN), {
      method: "DELETE",
      headers,
    }),
    bindings,
  );
  expect(logout.status).toBe(200);
  expect(await logout.json()).toEqual({ user: null, csrfToken: null });
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
});
