import type { D1Database } from "@cloudflare/workers-types";
import type {
  Picks,
  SeasonWeek,
  Submission,
  SubmissionWithUser,
  User,
} from "../shared/contracts";

interface UserRow {
  id: number;
  discord_user_id: string | null;
  discord_username: string | null;
  admin: number;
}

interface SubmissionRow {
  id: number;
  user_id: number;
  season: number;
  week: number;
  picks: string;
  tiebreaker: number;
  created_at: string;
  updated_at: string;
}

interface SubmissionWithUserRow extends SubmissionRow {
  discord_user_id: string | null;
  discord_username: string | null;
  admin: number;
}

const userColumns = "id, discord_user_id, discord_username, admin";
const submissionColumns =
  "id, user_id, season, week, picks, tiebreaker, created_at, updated_at";
const submissionWithUserQuery = `
  SELECT s.id, s.user_id, s.season, s.week, s.picks, s.tiebreaker, s.created_at, s.updated_at,
         u.discord_user_id, u.discord_username, u.admin
  FROM submissions s JOIN users u ON u.id = s.user_id`;

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    discordId: row.discord_user_id,
    username: row.discord_username,
    admin: row.admin === 1,
  };
}

function mapTimestamp(value: string): string {
  // Rails SQLite datetimes are UTC, but have no timezone suffix.
  return new Date(
    value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
  ).toISOString();
}

function mapSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    userId: row.user_id,
    season: row.season,
    week: row.week,
    picks: JSON.parse(row.picks) as Picks,
    tiebreaker: row.tiebreaker,
    createdAt: mapTimestamp(row.created_at),
    updatedAt: mapTimestamp(row.updated_at),
  };
}

function mapSubmissionWithUser(row: SubmissionWithUserRow): SubmissionWithUser {
  return {
    ...mapSubmission(row),
    user: mapUser({
      id: row.user_id,
      discord_user_id: row.discord_user_id,
      discord_username: row.discord_username,
      admin: row.admin,
    }),
  };
}

export async function getUser(
  db: D1Database,
  id: number,
): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${userColumns} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  return row ? mapUser(row) : null;
}

export async function getUserByDiscordId(
  db: D1Database,
  discordId: string,
): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${userColumns} FROM users WHERE discord_user_id = ?`)
    .bind(discordId)
    .first<UserRow>();
  return row ? mapUser(row) : null;
}

export async function ensureTokenUser(
  db: D1Database,
  { discordId, username }: { discordId: string; username: string },
): Promise<User> {
  const now = new Date().toISOString();
  // A stale signed token must not overwrite current Discord metadata.
  const row = await db
    .prepare(
      `
    INSERT INTO users (discord_user_id, discord_username, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (discord_user_id) DO UPDATE SET discord_user_id = excluded.discord_user_id
    RETURNING ${userColumns}`,
    )
    .bind(discordId, username, now, now)
    .first<UserRow>();
  if (!row) {
    throw new Error("Unable to persist token user");
  }
  return mapUser(row);
}

export async function listUsers(
  db: D1Database,
  discordOnly = false,
): Promise<User[]> {
  const { results } = await db
    .prepare(
      `SELECT ${userColumns} FROM users${discordOnly ? " WHERE discord_user_id IS NOT NULL" : ""} ORDER BY id`,
    )
    .all<UserRow>();
  return results.map(mapUser);
}

export async function getSubmission(
  db: D1Database,
  userId: number,
  { season, week }: SeasonWeek,
): Promise<Submission | null> {
  const row = await db
    .prepare(
      `SELECT ${submissionColumns} FROM submissions WHERE user_id = ? AND season = ? AND week = ?`,
    )
    .bind(userId, season, week)
    .first<SubmissionRow>();
  return row ? mapSubmission(row) : null;
}

export async function getSubmissionById(
  db: D1Database,
  id: number,
): Promise<SubmissionWithUser | null> {
  const row = await db
    .prepare(`${submissionWithUserQuery} WHERE s.id = ?`)
    .bind(id)
    .first<SubmissionWithUserRow>();
  return row ? mapSubmissionWithUser(row) : null;
}

export async function listUserSubmissions(
  db: D1Database,
  userId: number,
): Promise<Submission[]> {
  const { results } = await db
    .prepare(
      `SELECT ${submissionColumns} FROM submissions WHERE user_id = ? ORDER BY season DESC, week DESC, id`,
    )
    .bind(userId)
    .all<SubmissionRow>();
  return results.map(mapSubmission);
}

export async function listWeekSubmissions(
  db: D1Database,
  { season, week }: SeasonWeek,
): Promise<SubmissionWithUser[]> {
  const { results } = await db
    .prepare(
      `${submissionWithUserQuery} WHERE s.season = ? AND s.week = ? ORDER BY s.id`,
    )
    .bind(season, week)
    .all<SubmissionWithUserRow>();
  return results.map(mapSubmissionWithUser);
}

export async function listSeasons(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare(
      "SELECT DISTINCT season FROM submissions UNION SELECT DISTINCT season FROM job_runs ORDER BY season DESC",
    )
    .all<{ season: number }>();
  return results.map((row) => row.season);
}

export async function saveSubmission(
  db: D1Database,
  {
    userId,
    season,
    week,
    picks,
    tiebreaker,
    locked,
    now = new Date().toISOString(),
  }: {
    userId: number;
    season: number;
    week: number;
    picks: Picks;
    tiebreaker: number;
    locked: boolean;
    now?: string;
  },
): Promise<Submission | null> {
  const row = await db
    .prepare(
      `
    INSERT INTO submissions (user_id, season, week, picks, tiebreaker, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, season, week) DO UPDATE SET
      picks = excluded.picks,
      tiebreaker = excluded.tiebreaker,
      updated_at = excluded.updated_at
    WHERE ? = 0
    RETURNING ${submissionColumns}`,
    )
    .bind(
      userId,
      season,
      week,
      JSON.stringify(picks),
      tiebreaker,
      now,
      now,
      locked ? 1 : 0,
    )
    .first<SubmissionRow>();
  return row ? mapSubmission(row) : null;
}
