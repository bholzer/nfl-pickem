import type {
  Game,
  Scoreboard,
  SeasonWeek,
  Team,
} from "../../shared/contracts";
import { validSeason, validWeek } from "../../shared/season";

const SCOREBOARD_URL =
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const REQUEST_TIMEOUT_MS = 10_000;

export class EspnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EspnError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EspnError("ESPN returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EspnError("ESPN returned a missing text field");
  }
  return value;
}

function weekNumber(value: unknown): number {
  if (!validWeek(value)) {
    throw new EspnError("ESPN returned an invalid regular-season week");
  }
  return value;
}

function seasonNumber(value: unknown): number {
  if (!validSeason(value)) {
    throw new EspnError("ESPN returned an invalid season year");
  }
  return value;
}

function team(competitor: Record<string, unknown>): Team {
  const details = object(competitor.team);
  let score: number | null = null;
  if (competitor.score !== null && competitor.score !== undefined) {
    if (
      typeof competitor.score !== "number" &&
      (typeof competitor.score !== "string" || !/^\d+$/.test(competitor.score))
    ) {
      throw new EspnError("ESPN returned an invalid score");
    }
    score = Number(competitor.score);
    if (!Number.isSafeInteger(score) || score < 0) {
      throw new EspnError("ESPN returned an invalid score");
    }
  }
  return {
    id: text(competitor.id),
    name: text(details.displayName),
    abbreviation: text(details.abbreviation),
    logo:
      details.logo === undefined || details.logo === null
        ? ""
        : text(details.logo),
    score,
  };
}

function gameDate(value: unknown): string {
  const date = text(value);
  const calendar =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(
      date,
    );
  if (
    !calendar ||
    !Number.isFinite(Date.parse(date)) ||
    Number(calendar[3]) >
      new Date(
        Date.UTC(Number(calendar[1]), Number(calendar[2]), 0),
      ).getUTCDate()
  ) {
    throw new EspnError("ESPN returned an invalid game date");
  }
  return date;
}

function finalWinner(home: Team, away: Team): string | null {
  if (home.score === null || away.score === null) {
    throw new EspnError("ESPN returned missing final scores");
  }
  if (home.score === away.score) {
    return null;
  }
  return home.score > away.score ? home.id : away.id;
}

function declaredWinner(competitors: Record<string, unknown>[]): unknown {
  for (const competitor of competitors) {
    if (
      competitor.winner !== undefined &&
      typeof competitor.winner !== "boolean"
    ) {
      throw new EspnError("ESPN returned an invalid winner");
    }
  }
  const winners = competitors.filter((entry) => entry.winner === true);
  if (winners.length > 1) {
    throw new EspnError("ESPN returned multiple winners");
  }
  return winners[0]?.id ?? null;
}

function matchup(
  competition: Record<string, unknown>,
  final: boolean,
): Pick<Game, "homeTeam" | "awayTeam" | "winnerId"> {
  if (
    !Array.isArray(competition.competitors) ||
    competition.competitors.length !== 2
  ) {
    throw new EspnError("ESPN returned an incomplete matchup");
  }
  const competitors = competition.competitors.map(object);
  const home = competitors.find((entry) => entry.homeAway === "home");
  const away = competitors.find((entry) => entry.homeAway === "away");
  if (!home || !away) {
    throw new EspnError("ESPN returned an incomplete matchup");
  }
  const homeTeam = team(home);
  const awayTeam = team(away);
  if (homeTeam.id === awayTeam.id) {
    throw new EspnError("ESPN returned duplicate teams");
  }
  const declared = declaredWinner(competitors);
  if (!final) {
    return { homeTeam, awayTeam, winnerId: null };
  }
  const winnerId = finalWinner(homeTeam, awayTeam);
  if (declared !== winnerId) {
    throw new EspnError("ESPN returned inconsistent final results");
  }
  return { homeTeam, awayTeam, winnerId };
}

function validateGamePeriod(
  event: Record<string, unknown>,
  period: SeasonWeek,
) {
  if (event.season !== undefined) {
    const season = object(event.season);
    if (season.year !== period.season || season.type !== 2) {
      throw new EspnError("ESPN returned a game from a different season");
    }
  }
  if (event.week !== undefined && object(event.week).number !== period.week) {
    throw new EspnError("ESPN returned a game from a different week");
  }
}

function normalizeGame(
  raw: unknown,
  ids: Set<string>,
  period: SeasonWeek,
): Game {
  const event = object(raw);
  validateGamePeriod(event, period);
  if (!Array.isArray(event.competitions) || event.competitions.length === 0) {
    throw new EspnError("ESPN returned a game without a competition");
  }
  const competition = object(event.competitions[0]);
  const id = text(competition.id);
  if (ids.has(id)) {
    throw new EspnError("ESPN returned duplicate competitions");
  }
  ids.add(id);
  const date = gameDate(event.date);
  const status = object(object(event.status).type);
  const statusName = text(status.name);
  const competitionStatus = object(object(competition.status).type);
  if (
    typeof competitionStatus.completed !== "boolean" ||
    (statusName === "STATUS_FINAL") !== competitionStatus.completed
  ) {
    throw new EspnError("ESPN returned inconsistent completion status");
  }
  const teams = matchup(competition, statusName === "STATUS_FINAL");
  if (
    competition.neutralSite !== undefined &&
    typeof competition.neutralSite !== "boolean"
  ) {
    throw new EspnError("ESPN returned an invalid neutral-site flag");
  }
  return {
    id,
    name: text(event.name),
    date: new Date(date).toISOString(),
    neutralSite: competition.neutralSite === true,
    status: statusName,
    statusDetail: text(status.detail),
    ...teams,
  };
}

/** Pure boundary normalization, also usable by deterministic upstream fixtures. */
export function normalizeScoreboard(
  raw: unknown,
  requested?: SeasonWeek,
): Scoreboard {
  const data = object(raw);
  const metadata = object(data.season);
  const season = seasonNumber(metadata.year);
  const week = weekNumber(object(data.week).number);
  if (metadata.type !== 2) {
    throw new EspnError("ESPN returned games outside the regular season");
  }
  if (
    requested &&
    (season !== seasonNumber(requested.season) ||
      week !== weekNumber(requested.week))
  ) {
    throw new EspnError("ESPN returned a different season or week");
  }
  if (!Array.isArray(data.events) || data.events.length === 0) {
    throw new EspnError("ESPN returned no games");
  }
  const ids = new Set<string>();
  const period = { season, week };
  const games = data.events.map((event) => normalizeGame(event, ids, period));
  return { season, week, games };
}

async function request(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new EspnError(`ESPN request failed (${response.status})`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof EspnError) {
      throw error;
    }
    throw new EspnError("ESPN scoreboard is unavailable", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

interface SeasonContext {
  season: number;
  seasonType: number;
  week: number | null;
}

export async function getSeasonContext(): Promise<SeasonContext> {
  const data = object(await request(new URL(SCOREBOARD_URL)));
  const metadata = object(data.season);
  const season = seasonNumber(metadata.year);
  const seasonType = metadata.type;
  if (typeof seasonType !== "number" || ![1, 2, 3, 4].includes(seasonType)) {
    throw new EspnError("ESPN returned an invalid season phase");
  }
  return {
    season,
    seasonType,
    week: seasonType === 2 ? weekNumber(object(data.week).number) : null,
  };
}

/** Automatic delivery is meaningful only during the regular season. */
export async function getCurrentPeriod(): Promise<SeasonWeek | null> {
  const current = await getSeasonContext();
  return current.week === null
    ? null
    : { season: current.season, week: current.week };
}

function defaultWeek(season: number, current: SeasonContext): number {
  if (season < current.season) {
    return 18;
  }
  if (season > current.season || current.seasonType === 1) {
    return 1;
  }
  return current.week ?? 18;
}

async function resolvePeriod(
  selection: Partial<SeasonWeek>,
): Promise<SeasonWeek> {
  if (selection.season !== undefined && selection.week !== undefined) {
    return {
      season: seasonNumber(selection.season),
      week: weekNumber(selection.week),
    };
  }
  const current = await getSeasonContext();
  const season =
    selection.season === undefined
      ? current.season
      : seasonNumber(selection.season);
  return {
    season,
    week:
      selection.week === undefined
        ? defaultWeek(season, current)
        : weekNumber(selection.week),
  };
}

export async function fetchScoreboard(
  selection: Partial<SeasonWeek> = {},
): Promise<Scoreboard> {
  const period = await resolvePeriod(selection);
  const url = new URL(SCOREBOARD_URL);
  url.searchParams.set("dates", String(period.season));
  url.searchParams.set("seasontype", "2");
  url.searchParams.set("week", String(period.week));
  return normalizeScoreboard(await request(url), period);
}
