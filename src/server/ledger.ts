import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
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
  venmo_name: string | null;
  venmo_transaction_id: string | null;
  paid_at: string;
  created_at: string;
  voided_at: string | null;
}

const entryColumns =
  "id, season, user_id, direction, amount_cents, source, status, note, venmo_name, venmo_transaction_id, paid_at, created_at, voided_at";

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
    venmoName: row.venmo_name,
    venmoTransactionId: row.venmo_transaction_id,
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

/** `conflict` means the entry exists but its current state does not allow the change. */
export type TransitionResult =
  | { status: "updated"; season: number }
  | { status: "not_found" }
  | { status: "conflict" };

/**
 * Runs one guarded `UPDATE ... WHERE id = ? AND <allowed state> RETURNING
 * season`, so a concurrent change makes the loser fail cleanly.
 */
async function transition(
  db: D1Database,
  id: number,
  update: D1PreparedStatement,
): Promise<TransitionResult> {
  const updated = await update.first<{ season: number }>();
  if (updated) {
    return { status: "updated", season: updated.season };
  }
  const existing = await db
    .prepare("SELECT id FROM payment_entries WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  return { status: existing ? "conflict" : "not_found" };
}

/** Only an approved entry can be voided. */
export function voidPaymentEntry(
  db: D1Database,
  id: number,
  now = new Date().toISOString(),
): Promise<TransitionResult> {
  return transition(
    db,
    id,
    db
      .prepare(
        `UPDATE payment_entries SET status = 'voided', voided_at = ?
         WHERE id = ? AND status = 'approved' RETURNING season`,
      )
      .bind(now, id),
  );
}

/** Pending -> approved for a chosen player; the season may move. */
export function approvePaymentEntry(
  db: D1Database,
  id: number,
  input: { userId: number; season: number },
  now = new Date().toISOString(),
): Promise<TransitionResult> {
  return transition(
    db,
    id,
    db
      .prepare(
        `UPDATE payment_entries SET status = 'approved', user_id = ?, season = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending' RETURNING season`,
      )
      .bind(input.userId, input.season, now, id),
  );
}

/** Pending -> ignored; the entry stays listed but never counts. */
export function ignorePaymentEntry(
  db: D1Database,
  id: number,
  now = new Date().toISOString(),
): Promise<TransitionResult> {
  return transition(
    db,
    id,
    db
      .prepare(
        `UPDATE payment_entries SET status = 'ignored', reviewed_at = ?
         WHERE id = ? AND status = 'pending' RETURNING season`,
      )
      .bind(now, id),
  );
}

/**
 * Approved or ignored -> pending, for Venmo entries only: their transaction ID
 * blocks re-importing, so voiding would lose them for good. Manual entries are
 * corrected by voiding.
 */
export function reopenPaymentEntry(
  db: D1Database,
  id: number,
): Promise<TransitionResult> {
  return transition(
    db,
    id,
    db
      .prepare(
        `UPDATE payment_entries SET status = 'pending', reviewed_at = NULL
         WHERE id = ? AND status IN ('approved', 'ignored')
           AND source IN ('venmo_csv', 'venmo_email')
         RETURNING season`,
      )
      .bind(id),
  );
}

export interface ImportedPaymentEntry {
  season: number;
  userId: number | null;
  status: "approved" | "pending";
  source: "venmo_csv" | "venmo_email";
  direction: PaymentDirection;
  amountCents: number;
  venmoTransactionId: string;
  venmoName: string;
  note: string | null;
  paidAt: string;
}

/** D1 caps statements per batch; imports insert in chunks of this size. */
const IMPORT_BATCH_SIZE = 50;

/**
 * Inserts imported entries, skipping any whose Venmo transaction ID is already
 * in the ledger (in any status). Returns, per entry, whether it was inserted.
 */
export async function insertImportedPayments(
  db: D1Database,
  entries: readonly ImportedPaymentEntry[],
  now = new Date().toISOString(),
): Promise<boolean[]> {
  const statement = db.prepare(`
    INSERT INTO payment_entries
      (season, user_id, direction, amount_cents, source, status,
       venmo_transaction_id, venmo_name, note, paid_at, created_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (venmo_transaction_id) WHERE venmo_transaction_id IS NOT NULL
    DO NOTHING
    RETURNING id`);
  const inserted: boolean[] = [];
  for (let start = 0; start < entries.length; start += IMPORT_BATCH_SIZE) {
    const chunk = entries.slice(start, start + IMPORT_BATCH_SIZE);
    const results = await db.batch<{ id: number }>(
      chunk.map((entry) =>
        statement.bind(
          entry.season,
          entry.userId,
          entry.direction,
          entry.amountCents,
          entry.source,
          entry.status,
          entry.venmoTransactionId,
          entry.venmoName,
          entry.note,
          entry.paidAt,
          now,
          entry.status === "approved" ? now : null,
        ),
      ),
    );
    inserted.push(...results.map((result) => result.results.length > 0));
  }
  return inserted;
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
