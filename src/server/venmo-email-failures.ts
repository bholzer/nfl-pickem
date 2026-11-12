import type { D1Database } from "@cloudflare/workers-types";
import type { VenmoEmailFailure } from "../shared/contracts";

const MAX_SUBJECT_LENGTH = 200;

/** At most `MAX_SUBJECT_LENGTH` code points, matching SQLite's `length()`. */
function truncateSubject(subject: string): string {
  const trimmed = subject.replace(/\s+/g, " ").trim();
  return Array.from(trimmed).slice(0, MAX_SUBJECT_LENGTH).join("");
}

export async function recordVenmoEmailFailure(
  db: D1Database,
  failure: { receivedAt: string; subject: string; reason: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO venmo_email_failures (received_at, subject, reason) VALUES (?, ?, ?)",
    )
    .bind(failure.receivedAt, truncateSubject(failure.subject), failure.reason)
    .run();
}

/** Undismissed failures, newest first. */
export async function listVenmoEmailFailures(
  db: D1Database,
): Promise<VenmoEmailFailure[]> {
  const { results } = await db
    .prepare(
      `SELECT id, received_at, subject, reason FROM venmo_email_failures
       WHERE dismissed_at IS NULL ORDER BY received_at DESC, id DESC`,
    )
    .all<{
      id: number;
      received_at: string;
      subject: string;
      reason: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
    subject: row.subject,
    reason: row.reason,
  }));
}

export async function dismissVenmoEmailFailure(
  db: D1Database,
  id: number,
  now = new Date().toISOString(),
): Promise<"dismissed" | "not_found" | "conflict"> {
  const dismissed = await db
    .prepare(
      `UPDATE venmo_email_failures SET dismissed_at = ?
       WHERE id = ? AND dismissed_at IS NULL RETURNING id`,
    )
    .bind(now, id)
    .first<{ id: number }>();
  if (dismissed) {
    return "dismissed";
  }
  const existing = await db
    .prepare("SELECT id FROM venmo_email_failures WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  return existing ? "conflict" : "not_found";
}
