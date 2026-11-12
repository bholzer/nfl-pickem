import type { D1Database } from "@cloudflare/workers-types";
import type { VenmoAccount, VenmoAccountInput } from "../shared/contracts";
import { normalizeVenmoName } from "./services/venmo";

/** Players with a username or at least one display name, by user ID. */
export async function listVenmoAccounts(
  db: D1Database,
): Promise<VenmoAccount[]> {
  const [usernames, names] = await db.batch([
    db.prepare("SELECT user_id, username FROM venmo_usernames"),
    db.prepare(
      "SELECT user_id, name FROM venmo_display_names ORDER BY user_id, id",
    ),
  ]);
  const accounts = new Map<number, VenmoAccount>();
  const account = (userId: number) => {
    const existing = accounts.get(userId);
    if (existing) {
      return existing;
    }
    const created: VenmoAccount = { userId, username: null, displayNames: [] };
    accounts.set(userId, created);
    return created;
  };
  for (const row of (usernames?.results ?? []) as {
    user_id: number;
    username: string;
  }[]) {
    account(row.user_id).username = row.username;
  }
  for (const row of (names?.results ?? []) as {
    user_id: number;
    name: string;
  }[]) {
    account(row.user_id).displayNames.push(row.name);
  }
  return [...accounts.values()].sort((a, b) => a.userId - b.userId);
}

/** Normalized display name -> owning player, for classifying payments. */
export async function venmoNameOwners(
  db: D1Database,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT normalized_name, user_id FROM venmo_display_names")
    .all<{ normalized_name: string; user_id: number }>();
  return new Map(results.map((row) => [row.normalized_name, row.user_id]));
}

/** The requested names, as entered, that already belong to another player. */
async function namesOwnedByOthers(
  db: D1Database,
  userId: number,
  displayNames: readonly string[],
): Promise<string[]> {
  const owners = await venmoNameOwners(db);
  return displayNames.filter((name) => {
    const owner = owners.get(normalizeVenmoName(name));
    return owner !== undefined && owner !== userId;
  });
}

/**
 * Fills in the player on unassigned pending entries whose Venmo name now
 * matches. Never approves: the keyword rule applies only at import time, and
 * the banker reviews anything already waiting.
 */
async function prefillPendingEntries(
  db: D1Database,
  userId: number,
  displayNames: readonly string[],
): Promise<void> {
  const wanted = new Set(displayNames.map(normalizeVenmoName));
  if (wanted.size === 0) {
    return;
  }
  const { results } = await db
    .prepare(
      `SELECT id, venmo_name FROM payment_entries
       WHERE status = 'pending' AND user_id IS NULL AND venmo_name IS NOT NULL`,
    )
    .all<{ id: number; venmo_name: string }>();
  const update = db.prepare(
    `UPDATE payment_entries SET user_id = ?
     WHERE id = ? AND status = 'pending' AND user_id IS NULL`,
  );
  const statements = results
    .filter((row) => wanted.has(normalizeVenmoName(row.venmo_name)))
    .map((row) => update.bind(userId, row.id));
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export type VenmoAccountResult =
  { status: "saved" } | { status: "conflict"; names: string[] };

function uniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}

/**
 * Replaces a player's username and display names in one transaction, then
 * prefills pending entries. `displayNames` must already be trimmed and
 * de-duplicated; `username` must already be validated and `@`-free.
 */
export async function replaceVenmoAccount(
  db: D1Database,
  userId: number,
  input: VenmoAccountInput,
): Promise<VenmoAccountResult> {
  const taken = await namesOwnedByOthers(db, userId, input.displayNames);
  if (taken.length > 0) {
    return { status: "conflict", names: taken };
  }
  const insertName = db.prepare(
    "INSERT INTO venmo_display_names (user_id, name, normalized_name) VALUES (?, ?, ?)",
  );
  const username =
    input.username === null
      ? db.prepare("DELETE FROM venmo_usernames WHERE user_id = ?").bind(userId)
      : db
          .prepare(
            `INSERT INTO venmo_usernames (user_id, username) VALUES (?, ?)
             ON CONFLICT (user_id) DO UPDATE SET username = excluded.username`,
          )
          .bind(userId, input.username);
  try {
    await db.batch([
      db
        .prepare("DELETE FROM venmo_display_names WHERE user_id = ?")
        .bind(userId),
      ...input.displayNames.map((name) =>
        insertName.bind(userId, name, normalizeVenmoName(name)),
      ),
      username,
    ]);
  } catch (error) {
    // Another save claimed a name between the check and the batch.
    if (uniqueViolation(error)) {
      return {
        status: "conflict",
        names: await namesOwnedByOthers(db, userId, input.displayNames),
      };
    }
    throw error;
  }
  await prefillPendingEntries(db, userId, input.displayNames);
  return { status: "saved" };
}

export async function listPaymentKeywords(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT keyword FROM payment_keywords ORDER BY keyword")
    .all<{ keyword: string }>();
  return results.map((row) => row.keyword);
}

/** `keywords` must already be lowercase, trimmed, and de-duplicated. */
export async function replacePaymentKeywords(
  db: D1Database,
  keywords: readonly string[],
): Promise<void> {
  const insert = db.prepare(
    "INSERT INTO payment_keywords (keyword) VALUES (?)",
  );
  await db.batch([
    db.prepare("DELETE FROM payment_keywords"),
    ...keywords.map((keyword) => insert.bind(keyword)),
  ]);
}
