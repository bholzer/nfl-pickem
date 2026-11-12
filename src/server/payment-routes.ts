import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ManualPaymentInput, PaymentDirection } from "../shared/contracts";
import { validSeason } from "../shared/season";
import type { AppBindings, Env } from "./env";
import { requireAdmin, requireCsrf } from "./auth";
import { getUser } from "./db";
import {
  insertManualPayment,
  setBankerUserId,
  voidPaymentEntry,
} from "./ledger";
import { parseSeason } from "./params";
import { getSeasonContext } from "./services/espn";
import { paymentsData } from "./services/payments";

/** Whole cents; the cap keeps a mistyped amount from becoming a $10,000 payment. */
const MAX_PAYMENT_CENTS = 1_000_000;
const MAX_NOTE_LENGTH = 280;
// A timestamp with an explicit zone; a bare date would shift a local day to UTC midnight.
const isoTimestamp =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

type Fields = Record<string, string>;
type Validated<T> =
  { valid: true; value: T } | { valid: false; fields: Fields };

function validUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validDirection(value: unknown): value is PaymentDirection {
  return value === "in" || value === "out";
}

function validAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_PAYMENT_CENTS
  );
}

/** Normalizes to `toISOString()` so stored payment times sort lexically. */
function normalizePaidAt(value: unknown): string | null {
  const match = typeof value === "string" ? isoTimestamp.exec(value) : null;
  if (!match) {
    return null;
  }
  // Date parsing rolls an impossible day such as February 30 into March.
  const [year, month, day] = match.slice(1, 4).map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return new Date(Date.parse(match[0])).toISOString();
}

/** Undefined marks an invalid note; an empty note becomes null. */
function normalizeNote(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    return undefined;
  }
  return note || null;
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function validateManualPayment(body: unknown): Validated<ManualPaymentInput> {
  const raw = objectBody(body);
  const { season, userId, direction, amountCents } = raw;
  const paidAt = normalizePaidAt(raw.paidAt);
  const note = normalizeNote(raw.note);
  const checks: [string, boolean, string][] = [
    [
      "season",
      validSeason(season),
      "Season must be an integer from 1920 to 9999",
    ],
    ["userId", validUserId(userId), "Choose a player"],
    ["direction", validDirection(direction), "Direction must be in or out"],
    [
      "amountCents",
      validAmount(amountCents),
      `Amount must be whole cents from 1 to ${MAX_PAYMENT_CENTS}`,
    ],
    ["paidAt", paidAt !== null, "Enter an ISO 8601 timestamp with a time zone"],
    [
      "note",
      note !== undefined,
      `Note must be at most ${MAX_NOTE_LENGTH} characters`,
    ],
  ];
  const fields: Fields = Object.fromEntries(
    checks
      .filter(([, ok]) => !ok)
      .map(([field, , message]) => [field, message]),
  );
  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return {
    valid: true,
    value: {
      season: season as number,
      userId: userId as number,
      direction: direction as PaymentDirection,
      amountCents: amountCents as number,
      paidAt: paidAt as string,
      note: note as string | null,
    },
  };
}

function parseEntryId(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HTTPException(400, { message: "Invalid payment ID" });
  }
  return Number(raw);
}

/** Null clears the banker; undefined marks an unknown or malformed user. */
async function bankerInput(
  db: Env["DB"],
  userId: unknown,
): Promise<number | null | undefined> {
  if (userId === null) {
    return null;
  }
  if (!validUserId(userId) || !(await getUser(db, userId))) {
    return undefined;
  }
  return userId;
}

export const paymentRoutes = new Hono<AppBindings>();
paymentRoutes.use("*", requireAdmin);

paymentRoutes.get("/", async (c) => {
  // Reject an invalid season before any upstream request.
  const requested = parseSeason(c.req.query("season"));
  const context = await getSeasonContext();
  return c.json(
    await paymentsData(c.env, requested ?? context.season, context),
  );
});

paymentRoutes.post("/", requireCsrf, async (c) => {
  const input = validateManualPayment(
    await c.req.json<unknown>().catch(() => null),
  );
  if (!input.valid) {
    return c.json({ error: "Invalid payment", fields: input.fields }, 422);
  }
  if (!(await getUser(c.env.DB, input.value.userId))) {
    return c.json(
      { error: "Invalid payment", fields: { userId: "Unknown player" } },
      422,
    );
  }
  await insertManualPayment(c.env.DB, input.value);
  return c.json(
    await paymentsData(c.env, input.value.season, await getSeasonContext()),
  );
});

paymentRoutes.post("/:id/void", requireCsrf, async (c) => {
  const result = await voidPaymentEntry(
    c.env.DB,
    parseEntryId(c.req.param("id")),
  );
  if (result.status === "not_found") {
    return c.json({ error: "Payment not found" }, 404);
  }
  if (result.status === "not_approved") {
    return c.json({ error: "Only an approved payment can be voided" }, 409);
  }
  return c.json(
    await paymentsData(c.env, result.season, await getSeasonContext()),
  );
});

paymentRoutes.put("/banker", requireCsrf, async (c) => {
  const requested = parseSeason(c.req.query("season"));
  const { userId } = objectBody(await c.req.json<unknown>().catch(() => null));
  const banker = await bankerInput(c.env.DB, userId);
  if (banker === undefined) {
    return c.json(
      { error: "Invalid banker", fields: { userId: "Choose a known player" } },
      422,
    );
  }
  await setBankerUserId(c.env.DB, banker);
  const context = await getSeasonContext();
  return c.json(
    await paymentsData(c.env, requested ?? context.season, context),
  );
});
