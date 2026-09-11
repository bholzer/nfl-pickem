import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { User } from "../shared/contracts";
import { validSeason, validWeek } from "../shared/season";
import { ensureTokenUser, getUser, getUserByDiscordId } from "./db";
import type { AppBindings, Env } from "./env";
import { isTrustedWebOrigin } from "./services/origin";
import {
  base64url,
  signToken,
  TokenConfigurationError,
  verifyToken,
} from "./tokens";

const sessionCookie = "pickem_session";
const stateCookie = "pickem_oauth";
const sessionAge = 31 * 86400;

function appOrigin(env: Env): string {
  try {
    const url = new URL(env.APP_ORIGIN);
    if (!isTrustedWebOrigin(url, env.APP_ENV)) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new HTTPException(503, {
      message: "Authentication is not configured",
    });
  }
}

function cookieOptions(env: Env, maxAge: number) {
  const origin = appOrigin(env);
  return {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

function safeReturnTo(value: string | undefined, origin: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/standings";
  }
  for (const character of value) {
    if (character === "\\" || character.charCodeAt(0) <= 32) {
      return "/standings";
    }
  }
  const url = new URL(value, origin);
  if (
    url.origin !== origin ||
    url.searchParams.has("token") ||
    url.pathname.startsWith("/auth/")
  ) {
    return "/standings";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function isSessionClaims(
  claims: Record<string, unknown> | null,
): claims is Record<string, unknown> & { userId: number; csrf: string } {
  return (
    claims !== null &&
    claims.purpose === "session" &&
    typeof claims.userId === "number" &&
    Number.isSafeInteger(claims.userId) &&
    claims.userId >= 1 &&
    typeof claims.csrf === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(claims.csrf)
  );
}

export async function readSession(
  c: Context<AppBindings>,
): Promise<{ user: User; csrfToken: string } | null> {
  // Configuration failure must never be mistaken for a logged-out identity.
  if (
    !c.env.SESSION_SECRET ||
    new TextEncoder().encode(c.env.SESSION_SECRET).length < 32
  ) {
    throw new TokenConfigurationError();
  }
  const token = getCookie(c, sessionCookie);
  if (!token) {
    return null;
  }
  const claims = await verifyToken(token, c.env.SESSION_SECRET);
  if (!isSessionClaims(claims)) {
    return null;
  }
  const user = await getUser(c.env.DB, claims.userId);
  return user ? { user, csrfToken: claims.csrf } : null;
}

async function establishSession(
  c: Context<AppBindings>,
  user: User,
): Promise<void> {
  const csrf = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const token = await signToken(
    {
      purpose: "session",
      userId: user.id,
      csrf,
      exp: Math.floor(Date.now() / 1000) + sessionAge,
    },
    c.env.SESSION_SECRET,
  );
  setCookie(c, sessionCookie, token, cookieOptions(c.env, sessionAge));
}

export const requireUser = createMiddleware<AppBindings>(async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const session = await readSession(c);
  if (!session) {
    return c.json({ error: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  c.set("csrfToken", session.csrfToken);
  await next();
});

export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.var.user.admin) {
    return c.json({ error: "Administrator access required" }, 403);
  }
  await next();
});

export const requireCsrf = createMiddleware<AppBindings>(async (c, next) => {
  const origin = appOrigin(c.env);
  const supplied = c.req.header("X-CSRF-Token");
  if (
    c.req.header("Origin") !== origin ||
    !c.var.csrfToken ||
    supplied !== c.var.csrfToken
  ) {
    return c.json({ error: "Invalid request origin or CSRF token" }, 403);
  }
  await next();
});

export const authRoutes = new Hono<AppBindings>();

authRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

authRoutes.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof TokenConfigurationError) {
    return c.json({ error: "Authentication is not configured" }, 503);
  }
  return c.json({ error: "Authentication failed" }, 500);
});

function isSubmissionIdentity(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 128;
}

authRoutes.get("/submissions/new", async (c) => {
  const token = c.req.query("token");
  if (token === undefined) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  const claims = await verifyToken(token, c.env.SUBMISSION_TOKEN_SECRET);
  if (
    !claims ||
    !isSubmissionIdentity(claims.user_id) ||
    !isSubmissionIdentity(claims.username) ||
    !validWeek(claims.week)
  ) {
    return c.json({ error: "Invalid or expired submission link" }, 401);
  }
  if (!validSeason(claims.season)) {
    return c.json(
      {
        error:
          "This submission link has no valid season. Request a replacement link from your pool administrator.",
      },
      401,
    );
  }
  if (c.env.SESSION_SECRET === c.env.SUBMISSION_TOKEN_SECRET) {
    throw new TokenConfigurationError();
  }
  const session = await readSession(c);
  if (!session) {
    // Verify configuration before provisioning a legitimate signed-link user.
    cookieOptions(c.env, sessionAge);
    const user = await ensureTokenUser(c.env.DB, {
      discordId: claims.user_id,
      username: claims.username,
    });
    await establishSession(c, user);
  }
  return c.redirect(
    `/submissions/new?season=${claims.season}&week=${claims.week}`,
    302,
  );
});

authRoutes.get("/auth/discord", async (c) => {
  const origin = appOrigin(c.env);
  if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_CLIENT_SECRET) {
    throw new HTTPException(503, {
      message: "Discord sign-in is not configured",
    });
  }
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = await signToken(
    {
      purpose: "oauth",
      nonce,
      verifier,
      returnTo: safeReturnTo(c.req.query("return_to"), origin),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    c.env.SESSION_SECRET,
  );
  setCookie(c, stateCookie, state, cookieOptions(c.env, 600));
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: `${origin}/auth/discord/callback`,
    response_type: "code",
    scope: "identify",
    state: nonce,
    code_challenge: base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.href, 302);
});

function isOAuthState(
  state: Record<string, unknown> | null,
  nonce: string | undefined,
): state is Record<string, unknown> & { verifier: string; returnTo: string } {
  return (
    state !== null &&
    state.purpose === "oauth" &&
    typeof state.nonce === "string" &&
    state.nonce === nonce &&
    typeof state.verifier === "string" &&
    typeof state.returnTo === "string"
  );
}

async function discordAccessToken(credentials: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  origin: string;
}): Promise<string> {
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: credentials.code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: `${credentials.origin}/auth/discord/callback`,
      code_verifier: credentials.verifier,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error();
  }
  const access = await response.json<{
    access_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
  } | null>();
  if (
    !access ||
    typeof access.access_token !== "string" ||
    !access.access_token ||
    access.token_type !== "Bearer" ||
    typeof access.scope !== "string" ||
    !access.scope.split(" ").includes("identify")
  ) {
    throw new Error();
  }
  return access.access_token;
}

async function discordIdentity(accessToken: string): Promise<string> {
  const identityResponse = await fetch(
    "https://discord.com/api/v10/users/@me",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!identityResponse.ok) {
    throw new Error();
  }
  const identity = await identityResponse.json<{ id?: unknown } | null>();
  if (
    !identity ||
    typeof identity.id !== "string" ||
    !/^\d{1,32}$/.test(identity.id)
  ) {
    throw new Error();
  }
  return identity.id;
}

authRoutes.get("/auth/discord/callback", async (c) => {
  const origin = appOrigin(c.env);
  const cookie = getCookie(c, stateCookie);
  deleteCookie(c, stateCookie, cookieOptions(c.env, 0));
  const state = cookie ? await verifyToken(cookie, c.env.SESSION_SECRET) : null;
  const code = c.req.query("code");
  if (
    !isOAuthState(state, c.req.query("state")) ||
    !code ||
    code.length > 2048 ||
    c.req.query("error")
  ) {
    return c.json({ error: "Invalid or expired OAuth state" }, 400);
  }
  if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_CLIENT_SECRET) {
    throw new HTTPException(503, {
      message: "Discord sign-in is not configured",
    });
  }
  let discordId: string;
  try {
    const accessToken = await discordAccessToken({
      clientId: c.env.DISCORD_CLIENT_ID,
      clientSecret: c.env.DISCORD_CLIENT_SECRET,
      code,
      verifier: state.verifier,
      origin,
    });
    discordId = await discordIdentity(accessToken);
  } catch {
    return c.json({ error: "Discord sign-in is temporarily unavailable" }, 502);
  }
  const user = await getUserByDiscordId(c.env.DB, discordId);
  if (!user) {
    return c.json(
      { error: "Discord account is not registered in this pool" },
      403,
    );
  }
  await establishSession(c, user);
  return c.redirect(safeReturnTo(state.returnTo, origin), 302);
});

authRoutes.get("/auth/failure", (c) => {
  deleteCookie(c, stateCookie, cookieOptions(c.env, 0));
  return c.redirect("/sign_in?error=authentication_failed", 302);
});

authRoutes.delete("/logout", requireUser, requireCsrf, (c) => {
  deleteCookie(c, sessionCookie, cookieOptions(c.env, 0));
  return c.json({ user: null, csrfToken: null });
});
