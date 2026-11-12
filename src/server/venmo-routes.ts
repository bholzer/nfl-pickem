import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
  PaymentApprovalInput,
  VenmoAccountInput,
  VenmoImportResponse,
} from "../shared/contracts";
import { validSeason } from "../shared/season";
import type { AppBindings } from "./env";
import { requireCsrf } from "./auth";
import { getUser } from "./db";
import {
  approvePaymentEntry,
  ignorePaymentEntry,
  reopenPaymentEntry,
  type TransitionResult,
} from "./ledger";
import {
  failedFields,
  objectBody,
  parseId,
  validUserId,
  type Validated,
} from "./payment-input";
import { parseSeason } from "./params";
import { getSeasonContext } from "./services/espn";
import { paymentsData } from "./services/payments";
import { normalizeVenmoName } from "./services/venmo";
import { recordVenmoPayments } from "./services/venmo-import";
import { parseVenmoStatement } from "./services/venmo-statement";
import { replacePaymentKeywords, replaceVenmoAccount } from "./venmo-accounts";
import { dismissVenmoEmailFailure } from "./venmo-email-failures";

const MAX_DISPLAY_NAMES = 5;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_KEYWORDS = 20;
const KEYWORD_LENGTH = { min: 2, max: 40 };
/** The JSON request carrying a statement; Venmo statements are far smaller. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const usernamePattern = /^[A-Za-z0-9_-]{5,30}$/;

type AppContext = Context<AppBindings>;

/** Code points, matching SQLite's `length()` in the schema checks. */
function characters(value: string): number {
  return Array.from(value).length;
}

/** Null (or blank) clears it; undefined marks an invalid username. */
function normalizeUsername(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (trimmed === "") {
    return null;
  }
  return usernamePattern.test(bare) ? bare : undefined;
}

/**
 * Trims each string and drops case-insensitive repeats, keeping the first
 * spelling. Undefined when the value is not a list of valid strings.
 */
function uniqueStrings(
  value: unknown,
  valid: (item: string) => boolean,
  key: (item: string) => string,
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = new Map<string, string>();
  for (const raw of value as unknown[]) {
    const item = typeof raw === "string" ? raw.trim() : null;
    if (item === null || !valid(item)) {
      return undefined;
    }
    if (!items.has(key(item))) {
      items.set(key(item), item);
    }
  }
  return [...items.values()];
}

function validateVenmoAccount(body: unknown): Validated<VenmoAccountInput> {
  const raw = objectBody(body);
  const username = normalizeUsername(raw.username);
  const displayNames = uniqueStrings(
    raw.displayNames,
    (name) => name !== "" && characters(name) <= MAX_DISPLAY_NAME_LENGTH,
    normalizeVenmoName,
  );
  const namesValid =
    displayNames !== undefined && displayNames.length <= MAX_DISPLAY_NAMES;
  if (username !== undefined && namesValid) {
    return { valid: true, value: { username, displayNames } };
  }
  return {
    valid: false,
    fields: failedFields([
      [
        "username",
        username !== undefined,
        "Venmo usernames are 5 to 30 letters, digits, hyphens, or underscores",
      ],
      [
        "displayNames",
        namesValid,
        `Enter up to ${MAX_DISPLAY_NAMES} names of at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
      ],
    ]),
  };
}

function validateKeywords(body: unknown): string[] | undefined {
  const keywords = uniqueStrings(
    objectBody(body).keywords,
    (keyword) =>
      characters(keyword) >= KEYWORD_LENGTH.min &&
      characters(keyword) <= KEYWORD_LENGTH.max,
    (keyword) => keyword.toLowerCase(),
  );
  const lowercase = keywords?.map((keyword) => keyword.toLowerCase());
  return lowercase && lowercase.length <= MAX_KEYWORDS ? lowercase : undefined;
}

function validateApproval(body: unknown): Validated<PaymentApprovalInput> {
  const { userId, season } = objectBody(body);
  if (validUserId(userId) && validSeason(season)) {
    return { valid: true, value: { userId, season } };
  }
  return {
    valid: false,
    fields: failedFields([
      ["userId", validUserId(userId), "Choose a player"],
      [
        "season",
        validSeason(season),
        "Season must be an integer from 1920 to 9999",
      ],
    ]),
  };
}

/** The requested season, or the current one. */
async function seasonData(c: AppContext, requested: number | undefined) {
  const context = await getSeasonContext();
  return paymentsData(c.env, requested ?? context.season, context);
}

async function transitionResponse(
  c: AppContext,
  result: TransitionResult,
  conflict: string,
) {
  if (result.status === "not_found") {
    return c.json({ error: "Payment not found" }, 404);
  }
  if (result.status === "conflict") {
    return c.json({ error: conflict }, 409);
  }
  return c.json(await seasonData(c, result.season));
}

function readJson(c: AppContext): Promise<unknown> {
  return c.req.json<unknown>().catch(() => null);
}

/** Mounted under `/api/admin/payments`, behind its administrator check. */
export const venmoRoutes = new Hono<AppBindings>();

venmoRoutes.put("/venmo/:userId", requireCsrf, async (c) => {
  const requested = parseSeason(c.req.query("season"));
  const userId = parseId(c.req.param("userId"), "Invalid player ID");
  const input = validateVenmoAccount(await readJson(c));
  if (!input.valid) {
    return c.json(
      { error: "Invalid Venmo account", fields: input.fields },
      422,
    );
  }
  if (!(await getUser(c.env.DB, userId))) {
    return c.json({ error: "Player not found" }, 404);
  }
  const saved = await replaceVenmoAccount(c.env.DB, userId, input.value);
  if (saved.status === "conflict") {
    return c.json(
      {
        error: "Invalid Venmo account",
        fields: {
          displayNames: `Already used by another player: ${saved.names.join(", ")}`,
        },
      },
      422,
    );
  }
  return c.json(await seasonData(c, requested));
});

venmoRoutes.put("/keywords", requireCsrf, async (c) => {
  const requested = parseSeason(c.req.query("season"));
  const keywords = validateKeywords(await readJson(c));
  if (!keywords) {
    return c.json(
      {
        error: "Invalid keywords",
        fields: {
          keywords: `Enter up to ${MAX_KEYWORDS} keywords of ${KEYWORD_LENGTH.min} to ${KEYWORD_LENGTH.max} characters`,
        },
      },
      422,
    );
  }
  await replacePaymentKeywords(c.env.DB, keywords);
  return c.json(await seasonData(c, requested));
});

venmoRoutes.post(
  "/import",
  requireCsrf,
  bodyLimit({
    maxSize: MAX_IMPORT_BYTES,
    onError: (c) => c.json({ error: "Statement is too large" }, 413),
  }),
  async (c) => {
    const requested = parseSeason(c.req.query("season"));
    const { csv } = objectBody(await readJson(c));
    if (typeof csv !== "string" || csv.trim() === "") {
      return c.json(
        {
          error: "Invalid statement",
          fields: { csv: "Choose a Venmo statement CSV file" },
        },
        422,
      );
    }
    const statement = parseVenmoStatement(csv);
    if (!statement.valid) {
      return c.json(
        { error: "Invalid statement", fields: { csv: statement.error } },
        422,
      );
    }
    const recorded = await recordVenmoPayments(
      c.env.DB,
      statement.payments,
      "venmo_csv",
    );
    const response: VenmoImportResponse = {
      data: await seasonData(c, requested),
      result: { ...recorded, skipped: statement.skipped },
    };
    return c.json(response);
  },
);

venmoRoutes.post("/email-failures/:id/dismiss", requireCsrf, async (c) => {
  const requested = parseSeason(c.req.query("season"));
  const id = parseId(c.req.param("id"), "Invalid email failure ID");
  const result = await dismissVenmoEmailFailure(c.env.DB, id);
  if (result === "not_found") {
    return c.json({ error: "Email failure not found" }, 404);
  }
  if (result === "conflict") {
    return c.json({ error: "The email failure was already dismissed" }, 409);
  }
  return c.json(await seasonData(c, requested));
});

venmoRoutes.post("/:id/approve", requireCsrf, async (c) => {
  const id = parseId(c.req.param("id"), "Invalid payment ID");
  const input = validateApproval(await readJson(c));
  if (!input.valid) {
    return c.json({ error: "Invalid approval", fields: input.fields }, 422);
  }
  if (!(await getUser(c.env.DB, input.value.userId))) {
    return c.json(
      { error: "Invalid approval", fields: { userId: "Unknown player" } },
      422,
    );
  }
  return transitionResponse(
    c,
    await approvePaymentEntry(c.env.DB, id, input.value),
    "Only a pending payment can be approved",
  );
});

venmoRoutes.post("/:id/ignore", requireCsrf, async (c) =>
  transitionResponse(
    c,
    await ignorePaymentEntry(
      c.env.DB,
      parseId(c.req.param("id"), "Invalid payment ID"),
    ),
    "Only a pending payment can be ignored",
  ),
);

venmoRoutes.post("/:id/reopen", requireCsrf, async (c) =>
  transitionResponse(
    c,
    await reopenPaymentEntry(
      c.env.DB,
      parseId(c.req.param("id"), "Invalid payment ID"),
    ),
    "Only an approved or ignored Venmo payment can be reopened",
  ),
);
