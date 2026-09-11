import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { expect, vi } from "vitest";
import type { SeasonWeek, SessionData, User } from "../../src/shared/contracts";
import { authRoutes } from "../../src/server/auth";
import { apiRoutes } from "../../src/server/routes";
import type { AppBindings, Env } from "../../src/server/env";
import { ensureTokenUser } from "../../src/server/db";
import { generateSubmissionToken } from "../../src/server/tokens";
import { espnScoreboard } from "../fixtures/espn";

export const origin = "http://localhost";
export const testEnv: Env = {
  ...env,
  APP_ENV: "local",
  APP_ORIGIN: origin,
  SESSION_SECRET: "synthetic-session-secret-not-real-0123456789",
  SUBMISSION_TOKEN_SECRET: "synthetic-submission-secret-not-real-0123456789",
  DISCORD_CLIENT_ID: "synthetic-client",
  DISCORD_CLIENT_SECRET: "synthetic-oauth-secret",
};
export const app = new Hono<AppBindings>()
  .route("/", authRoutes)
  .route("/api", apiRoutes);

export function cookieHeader(response: Response, name: string): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Missing ${name} cookie`);
  }
  const separator = cookie.indexOf(";");
  return separator === -1 ? cookie : cookie.slice(0, separator);
}

export async function login(
  discordId = "123456789012345678",
  admin = false,
  period: SeasonWeek = { season: 2026, week: 1 },
): Promise<{
  user: User;
  cookie: string;
  csrf: string;
  headers: Record<string, string>;
}> {
  let user = await ensureTokenUser(env.DB, {
    discordId,
    username: `Player ${discordId}`,
  });
  if (admin) {
    await env.DB.prepare("UPDATE users SET admin = 1 WHERE id = ?")
      .bind(user.id)
      .run();
    user = { ...user, admin: true };
  }
  const token = await generateSubmissionToken(
    user,
    period,
    testEnv.SUBMISSION_TOKEN_SECRET,
  );
  const response = await app.request(
    `${origin}/submissions/new?token=${token}`,
    {},
    testEnv,
  );
  expect(response.status).toBe(302);
  const cookie = cookieHeader(response, "pickem_session");
  const session = await app.request(
    `${origin}/api/session`,
    { headers: { Cookie: cookie } },
    testEnv,
  );
  const data = await session.json<SessionData>();
  expect(data.user).toEqual(user);
  const csrf = data.csrfToken;
  assert(csrf);
  return {
    user,
    cookie,
    csrf,
    headers: {
      Cookie: cookie,
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
  };
}

export function mockScoreboard(raw = espnScoreboard()) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://site.web.api.espn.com" ||
      url.pathname !== "/apis/site/v2/sports/football/nfl/scoreboard"
    ) {
      throw new Error("Unexpected outbound request");
    }
    return Promise.resolve(Response.json(raw));
  });
}
