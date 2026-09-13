import type {
  Scoreboard,
  SeasonWeek,
  Standing,
  SubmissionWithUser,
  User,
} from "../../shared/contracts";
import type { Env } from "../env";
import { generateSubmissionToken } from "../tokens";
import { submissionSummary, summaryHash } from "./summary";
import { isTrustedWebOrigin } from "./origin";

const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_LIMIT = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

function authorize(
  env: Partial<Env>,
  destination: string,
  kind: "user" | "channel",
): void {
  if (env.DISCORD_SEND_ENABLED !== "true") {
    throw new DiscordError("Discord delivery is disabled", false);
  }
  if (!env.DISCORD_BOT_TOKEN?.trim()) {
    throw new DiscordError("Discord bot token is not configured", false);
  }
  if (!validId(destination)) {
    throw new DiscordError(`Invalid Discord ${kind} ID`, false);
  }
  const configured =
    kind === "user"
      ? env.DISCORD_ALLOWED_USER_IDS
      : env.DISCORD_ALLOWED_CHANNEL_IDS;
  if (
    env.APP_ENV !== "production" &&
    !configured?.split(",").some((id) => id.trim() === destination)
  ) {
    throw new DiscordError(
      `Discord ${kind} destination is not approved`,
      false,
    );
  }
}

/** Each rendered entry occupies one line. Never truncate an entry or its hash. */
export function splitDiscordMessage(message: string): string[] {
  if (!message.trim()) {
    throw new DiscordError("Discord message is empty", false);
  }
  const parts: string[] = [];
  let part = "";
  for (const line of message.split("\n")) {
    if (line.length > MESSAGE_LIMIT) {
      throw new DiscordError(
        "A Discord message entry exceeds 2000 characters",
        false,
      );
    }
    if (part.length + 1 + line.length > MESSAGE_LIMIT) {
      if (part.trim()) {
        parts.push(part);
      }
      part = line;
    } else {
      part = part ? `${part}\n${line}` : line;
    }
  }
  if (part.trim()) {
    parts.push(part);
  }
  return parts;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryHeaderDelay(header: string | null): number | null {
  if (!header?.trim()) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp)
    ? Math.max(0, (timestamp - Date.now()) / 1_000)
    : null;
}

function retryDelay(response: Response, body: unknown): number | null {
  const delays: number[] = [];
  if (
    record(body) &&
    typeof body.retry_after === "number" &&
    Number.isFinite(body.retry_after) &&
    body.retry_after >= 0
  ) {
    delays.push(body.retry_after);
  }
  const headerDelay = retryHeaderDelay(response.headers.get("Retry-After"));
  if (headerDelay !== null) {
    delays.push(headerDelay);
  }
  return delays.length ? Math.max(...delays) : null;
}

function isDiscordResponse(
  value: unknown,
): value is Record<string, unknown> & { id: string } {
  return record(value) && validId(value.id);
}

async function discordRequest(
  env: Env,
  path: string,
  payload?: object,
): Promise<Record<string, unknown> & { id: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DISCORD_API}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "manual",
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new DiscordError("Discord request timed out", true);
      }
      body = null;
    }
    if (!response.ok) {
      throw new DiscordError(
        `Discord request failed (HTTP ${response.status})`,
        response.status === 429 || response.status >= 500,
        retryDelay(response, body),
      );
    }
    if (!isDiscordResponse(body)) {
      throw new DiscordError(
        "Discord returned an invalid success response",
        false,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof DiscordError) {
      throw error;
    }
    // Do not expose response content, authorization headers, or token-bearing links.
    throw new DiscordError(
      controller.signal.aborted
        ? "Discord request timed out"
        : "Discord network request failed",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface DiscordMessage {
  channelId: string;
  messageId: string;
}

export interface DiscordDestination {
  channelId: string;
  guildId: string;
}

export async function getChannelDestination(
  env: Env,
  channelId: string,
): Promise<DiscordDestination> {
  authorize(env, channelId, "channel");
  const channel = await discordRequest(env, `/channels/${channelId}`);
  if (channel.id !== channelId || !validId(channel.guild_id)) {
    throw new DiscordError("Discord returned an invalid server channel", false);
  }
  return { channelId: channel.id, guildId: channel.guild_id };
}

async function sendParts(
  env: Env,
  channelId: string,
  parts: string[],
): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  for (const content of parts) {
    const response = await discordRequest(
      env,
      `/channels/${channelId}/messages`,
      {
        content,
        allowed_mentions: { parse: [] },
      },
    );
    if (response.channel_id !== channelId) {
      throw new DiscordError(
        "Discord returned an unexpected message channel",
        false,
      );
    }
    messages.push({ channelId: response.channel_id, messageId: response.id });
  }
  return messages;
}

export async function sendChannelMessage(
  env: Env,
  channelId: string,
  message: string,
): Promise<DiscordMessage[]> {
  authorize(env, channelId, "channel");
  return sendParts(env, channelId, splitDiscordMessage(message));
}

export async function sendDirectMessage(
  env: Env,
  userId: string,
  message: string,
): Promise<void> {
  authorize(env, userId, "user");
  const parts = splitDiscordMessage(message);
  const channel = await discordRequest(env, "/users/@me/channels", {
    recipient_id: userId,
  });
  // A new DM channel inherits only the approved recipient's authorization, never
  // general channel-send permission. Reject unexpected/group channels fail-closed.
  if (
    channel.type !== 1 ||
    !Array.isArray(channel.recipients) ||
    channel.recipients.length !== 1 ||
    !record(channel.recipients[0]) ||
    channel.recipients[0].id !== userId
  ) {
    throw new DiscordError(
      "Discord returned a DM channel for an unexpected recipient",
      false,
    );
  }
  await sendParts(env, channel.id, parts);
}

function displayName(user: User): string {
  // Keep every entry on one line; names cannot inject headings, links, or mentions.
  return (user.username ?? user.discordId ?? `User ${user.id}`)
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()<>#+.!|~])/g, "\\$1");
}

export function applicationOrigin(
  env: Pick<Env, "APP_ORIGIN" | "APP_ENV">,
): URL {
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    throw new DiscordError("Application origin is invalid", false);
  }
  if (!isTrustedWebOrigin(origin, env.APP_ENV)) {
    throw new DiscordError(
      "Application origin is not a trusted web origin",
      false,
    );
  }
  return origin;
}

export async function sendSubmissionLink(
  env: Env,
  user: User,
  period: SeasonWeek,
): Promise<void> {
  if (!user.discordId) {
    throw new DiscordError("User has no Discord recipient ID", false);
  }
  authorize(env, user.discordId, "user");
  const origin = applicationOrigin(env);
  let token: string;
  try {
    token = await generateSubmissionToken(
      user,
      period,
      env.SUBMISSION_TOKEN_SECRET,
    );
  } catch {
    throw new DiscordError(
      "Submission token could not be generated; check identity, season, week, and signing configuration",
      false,
    );
  }
  const url = new URL("/submissions/new", origin);
  url.searchParams.set("token", token);
  await sendDirectMessage(
    env,
    user.discordId,
    `Hi, ${displayName(user)}\n\nPick-em ${period.season} week ${period.week} is here!\n\n[Submit your picks here](${url.href})`,
  );
}

export function renderStandings(
  standings: Standing[],
  period: SeasonWeek,
  receiptLinks?: ReadonlyMap<
    number,
    { url: string; originalMessageUrl: string }
  >,
): string {
  if (!standings.length) {
    throw new DiscordError("No standings to deliver", false);
  }
  const sorted = [...standings].sort((a, b) => a.rank - b.rank);
  const winners = sorted.filter((standing) => standing.winner);
  const contenders = sorted.filter(
    (standing) => standing.contender && !standing.winner,
  );
  const eliminated = sorted.filter(
    (standing) => !standing.contender && !standing.winner,
  );
  const sections = [`# ${period.season} Week ${period.week} Pick-em Standings`];
  const entry = (standing: Standing): string => {
    const points = `${standing.correctPicks} ${standing.correctPicks === 1 ? "point" : "points"}`;
    const tiebreaker =
      standing.tiebreakerDiff === null
        ? ""
        : ` (Tiebreaker: ${standing.tiebreaker}, off by ${standing.tiebreakerDiff})`;
    const line = `${standing.rank}. ${displayName(standing.user)}: ${points}${tiebreaker}`;
    const receipt = standing.winner
      ? receiptLinks?.get(standing.submissionId)
      : undefined;
    if (!receipt) {
      return line;
    }
    const linked = `${line} · [View receipt](${receipt.url})`;
    const original = ` · [Original hash message](${receipt.originalMessageUrl})`;
    return linked.length + original.length <= MESSAGE_LIMIT
      ? linked + original
      : linked;
  };
  if (winners.length) {
    sections.push(
      `### :tada: ${winners.length === 1 ? "Winner" : "Winners"}! :tada:`,
      ...winners.map(entry),
    );
  } else if (contenders.length) {
    sections.push(
      `### ${contenders.length === 1 ? "Contender" : "Contenders"} :bar_chart:`,
      ...contenders.map(entry),
    );
  }
  if (eliminated.length) {
    sections.push(
      "### Eliminated :skull:",
      ...eliminated.map((standing) => `~~${entry(standing)}~~`),
    );
  }
  return sections.join("\n\n");
}

export interface RenderedHashReceipt {
  submissionId: number;
  username: string | null;
  summary: string;
  verificationHash: string;
}

export async function renderHashes(
  submissions: SubmissionWithUser[],
  scoreboard: Scoreboard,
): Promise<{ message: string; receipts: RenderedHashReceipt[] }> {
  if (!submissions.length) {
    throw new DiscordError("No submission hashes to deliver", false);
  }
  if (!scoreboard.games.length) {
    throw new DiscordError(
      "No scoreboard games available to verify submissions",
      false,
    );
  }
  const entries: string[] = [];
  const receipts: RenderedHashReceipt[] = [];
  for (const submission of submissions) {
    if (
      submission.season !== scoreboard.season ||
      submission.week !== scoreboard.week
    ) {
      throw new DiscordError("Submission and scoreboard periods differ", false);
    }
    const summary = submissionSummary(submission, scoreboard);
    const hash = await summaryHash(summary);
    entries.push(`**${displayName(submission.user)}**: \`${hash}\``);
    receipts.push({
      submissionId: submission.id,
      username: submission.user.username,
      summary,
      verificationHash: hash,
    });
  }
  return {
    message: `# ${scoreboard.season} Week ${scoreboard.week} Pick Hashes (SHA-256 Hex)\nUse this hash to verify the winner's picks\n\n${entries.join("\n\n")}`,
    receipts,
  };
}
