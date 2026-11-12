import type { D1Database } from "@cloudflare/workers-types";
import type {
  PaymentDirection,
  PaymentEntry,
  PaymentSource,
  PaymentStatus,
} from "../shared/contracts";

interface PaymentEntryRow {
  id: number;
  season: number;
  user_id: number | null;
  direction: PaymentDirection;
  amount_cents: number;
  source: PaymentSource;
  status: PaymentStatus;
  note: string | null;
  paid_at: string;
  created_at: string;
  voided_at: string | null;
}

const entryColumns =
  "id, season, user_id, direction, amount_cents, source, status, note, paid_at, created_at, voided_at";

function mapEntry(row: PaymentEntryRow): PaymentEntry {
  return {
    id: row.id,
    season: row.season,
    userId: row.user_id,
    direction: row.direction,
    amountCents: row.amount_cents,
    source: row.source,
    status: row.status,
    note: row.note,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
  };
}

/** Newest first by payment time, then by insertion; includes voided entries. */
export async function listPaymentEntries(
  db: D1Database,
  season: number,
): Promise<PaymentEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT ${entryColumns} FROM payment_entries WHERE season = ? ORDER BY paid_at DESC, id DESC`,
    )
    .bind(season)
    .all<PaymentEntryRow>();
  return results.map(mapEntry);
}

/** `paidAt` must already be a normalized `toISOString()` value so it sorts lexically. */
export async function insertManualPayment(
  db: D1Database,
  entry: {
    season: number;
    userId: number;
    direction: PaymentDirection;
    amountCents: number;
    paidAt: string;
    note: string | null;
  },
  now = new Date().toISOString(),
): Promise<PaymentEntry> {
  const row = await db
    .prepare(
      `
    INSERT INTO payment_entries
      (season, user_id, direction, amount_cents, source, status, note, paid_at, created_at, reviewed_at)
    VALUES (?, ?, ?, ?, 'manual', 'approved', ?, ?, ?, ?)
    RETURNING ${entryColumns}`,
    )
    .bind(
      entry.season,
      entry.userId,
      entry.direction,
      entry.amountCents,
      entry.note,
      entry.paidAt,
      now,
      now,
    )
    .first<PaymentEntryRow>();
  if (!row) {
    throw new Error("Unable to persist payment entry");
  }
  return mapEntry(row);
}

export type VoidResult =
  | { status: "voided"; season: number }
  | { status: "not_found" }
  | { status: "not_approved" };

/** Only an approved entry can be voided; the conditional update makes a race lose cleanly. */
export async function voidPaymentEntry(
  db: D1Database,
  id: number,
  now = new Date().toISOString(),
): Promise<VoidResult> {
  const voided = await db
    .prepare(
      `UPDATE payment_entries SET status = 'voided', voided_at = ?
       WHERE id = ? AND status = 'approved' RETURNING season`,
    )
    .bind(now, id)
    .first<{ season: number }>();
  if (voided) {
    return { status: "voided", season: voided.season };
  }
  const existing = await db
    .prepare("SELECT id FROM payment_entries WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  return { status: existing ? "not_approved" : "not_found" };
}

export async function getBankerUserId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT banker_user_id FROM pool_settings WHERE id = 1")
    .first<{ banker_user_id: number | null }>();
  return row?.banker_user_id ?? null;
}

export async function setBankerUserId(
  db: D1Database,
  userId: number | null,
  now = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO pool_settings (id, banker_user_id, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      banker_user_id = excluded.banker_user_id,
      updated_at = excluded.updated_at`,
    )
    .bind(userId, now)
    .run();
}
