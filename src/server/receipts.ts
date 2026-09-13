import type { SeasonWeek, Standing } from "../shared/contracts";
import type { Env } from "./env";
import { listWeekSubmissions } from "./db";
import { fetchScoreboard } from "./services/espn";
import {
  applicationOrigin,
  getChannelDestination,
  renderHashes,
  sendChannelMessage,
  splitDiscordMessage,
} from "./services/discord";

export interface FrozenReceipt extends SeasonWeek {
  id: string;
  submissionId: number;
  username: string | null;
  summary: string;
  verificationHash: string;
  gameIds: string[];
  snapshotAt: string;
  originalMessageUrl: string | null;
}

type ReceiptRow = Omit<FrozenReceipt, "gameIds"> & { gameIds: string };

const receiptQuery = `SELECT r.id,r.submission_id AS submissionId,r.username,r.summary,
  r.verification_hash AS verificationHash,r.game_ids AS gameIds,
  p.season,p.week,p.snapshot_at AS snapshotAt,
  CASE WHEN part.message_id IS NOT NULL THEN
    'https://discord.com/channels/' || p.guild_id || '/' || part.channel_id || '/' || part.message_id
  ELSE NULL END AS originalMessageUrl
  FROM hash_receipts r JOIN hash_publications p ON p.id=r.publication_id
  LEFT JOIN hash_publication_parts part ON part.publication_id=r.publication_id AND part.part_index=r.part_index`;

export async function getFrozenReceipt(
  db: D1Database,
  id: string,
): Promise<FrozenReceipt | null> {
  const row = await db
    .prepare(`${receiptQuery} WHERE r.id=?`)
    .bind(id)
    .first<ReceiptRow>();
  return row ? { ...row, gameIds: JSON.parse(row.gameIds) as string[] } : null;
}

interface HashPublication {
  id: string | null;
  message: string;
  channelId: string | null;
}

async function cachedPublication(db: D1Database, key: string) {
  return db
    .prepare(
      `SELECT p.id,m.message,p.channel_id AS channelId
    FROM job_messages m LEFT JOIN hash_publications p ON p.snapshot_key=m.key
    WHERE m.key=?`,
    )
    .bind(key)
    .first<HashPublication>();
}

export async function freezeHashPublication(
  env: Env,
  key: string,
  period: SeasonWeek,
): Promise<HashPublication> {
  const cached = await cachedPublication(env.DB, key);
  if (cached) {
    // A legacy raw snapshot is authoritative even though it has no receipt rows.
    return cached;
  }
  const submissions = await listWeekSubmissions(env.DB, period);
  const scoreboard = await fetchScoreboard(period);
  const snapshotAt = new Date().toISOString();
  const rendered = await renderHashes(submissions, scoreboard);
  const parts = splitDiscordMessage(rendered.message);
  const destination = await getChannelDestination(env, env.DISCORD_CHANNEL_ID);
  const id = crypto.randomUUID();
  const gameIds = JSON.stringify(scoreboard.games.map((game) => game.id));
  // D1 batches are transactions. Only the builder owning this UUID may insert
  // either the raw message or its receipts; concurrent losers reread the winner.
  const statements = [
    env.DB.prepare(
      `INSERT INTO hash_publications(snapshot_key,id,season,week,channel_id,guild_id,snapshot_at)
      SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM job_messages WHERE key=?)
      ON CONFLICT(snapshot_key) DO NOTHING`,
    ).bind(
      key,
      id,
      period.season,
      period.week,
      destination.channelId,
      destination.guildId,
      snapshotAt,
      key,
    ),
    env.DB.prepare(
      `INSERT INTO job_messages(key,message,expires_at)
      SELECT snapshot_key,?,? FROM hash_publications WHERE id=? ON CONFLICT(key) DO NOTHING`,
    ).bind(rendered.message, Number.MAX_SAFE_INTEGER, id),
  ];
  let partIndex = 0;
  let entryIndex = 0;
  const receiptParts: number[] = [];
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (line.startsWith("**")) {
        receiptParts[entryIndex++] = partIndex;
      }
    }
    partIndex++;
  }
  for (const [index, receipt] of rendered.receipts.entries()) {
    const receiptPart = receiptParts[index];
    if (receiptPart === undefined) {
      throw new Error("Rendered receipt has no Discord message part");
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO hash_receipts(id,publication_id,submission_id,username,summary,verification_hash,game_ids,part_index)
      SELECT ?,id,?,?,?,?,?,? FROM hash_publications WHERE id=?`,
      ).bind(
        crypto.randomUUID(),
        receipt.submissionId,
        receipt.username,
        receipt.summary,
        receipt.verificationHash,
        gameIds,
        receiptPart,
        id,
      ),
    );
  }
  await env.DB.batch(statements);
  const persisted = await cachedPublication(env.DB, key);
  if (!persisted) {
    throw new Error("Hash publication is missing from durable history");
  }
  return persisted;
}

export async function sendHashPublicationPart(
  env: Env,
  publication: HashPublication,
  index: number,
  message: string,
): Promise<void> {
  if (!publication.id) {
    await sendChannelMessage(env, env.DISCORD_CHANNEL_ID, message);
    return;
  }
  const recorded = await env.DB.prepare(
    `SELECT message_id FROM hash_publication_parts
    WHERE publication_id=? AND part_index=?`,
  )
    .bind(publication.id, index)
    .first();
  if (recorded) {
    // A prior successful response survived even if the effect/checkpoint did not.
    return;
  }
  if (!publication.channelId) {
    throw new Error("Hash publication destination is missing");
  }
  const [sent] = await sendChannelMessage(env, publication.channelId, message);
  if (!sent) {
    throw new Error("Hash publication returned no Discord message");
  }
  // The remote POST and this commit cannot be atomic. A missing record never
  // becomes an invented message ID; ambiguous sends still require review.
  await env.DB.prepare(
    `INSERT INTO hash_publication_parts(publication_id,part_index,channel_id,message_id,published_at)
    VALUES(?,?,?,?,?) ON CONFLICT(publication_id,part_index) DO NOTHING`,
  )
    .bind(
      publication.id,
      index,
      sent.channelId,
      sent.messageId,
      new Date().toISOString(),
    )
    .run();
}

export async function winnerReceiptLinks(
  env: Env,
  period: SeasonWeek,
  standings: Standing[],
) {
  const links = new Map<number, { url: string; originalMessageUrl: string }>();
  for (const standing of standings) {
    if (!standing.winner) {
      continue;
    }
    const receipt = await env.DB.prepare(
      `${receiptQuery}
      WHERE r.submission_id=? AND p.season=? AND p.week=? AND part.message_id IS NOT NULL
      ORDER BY part.published_at,part.rowid LIMIT 1`,
    )
      .bind(standing.submissionId, period.season, period.week)
      .first<ReceiptRow>();
    if (receipt?.originalMessageUrl) {
      links.set(standing.submissionId, {
        url: new URL(`/receipts/${receipt.id}`, applicationOrigin(env)).href,
        originalMessageUrl: receipt.originalMessageUrl,
      });
    }
  }
  return links;
}
