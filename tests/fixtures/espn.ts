import type {
  Scoreboard,
  SubmissionWithUser,
} from "../../src/shared/contracts";
import { normalizeScoreboard } from "../../src/server/services/espn";

export interface EspnGameOptions {
  id?: string;
  name?: string;
  date?: string;
  neutralSite?: boolean;
  status?: string;
  homeId?: string;
  awayId?: string;
  homeName?: string;
  awayName?: string;
  homeScore?: number | null;
  awayScore?: number | null;
}

interface FixtureScores {
  home: number | null;
  away: number | null;
  winner: "home" | "away" | null;
}

function fixtureScores(
  options: EspnGameOptions,
  final: boolean,
): FixtureScores {
  const defaultHome = final ? 24 : 0;
  const defaultAway = final ? 17 : 0;
  const home =
    options.homeScore === undefined ? defaultHome : options.homeScore;
  const away =
    options.awayScore === undefined ? defaultAway : options.awayScore;
  let winner: "home" | "away" | null = null;
  if (final && home !== null && away !== null) {
    if (home > away) {
      winner = "home";
    } else if (away > home) {
      winner = "away";
    }
  }
  return { home, away, winner };
}

function fixtureCompetitor(
  options: EspnGameOptions,
  scores: FixtureScores,
  side: "home" | "away",
  id: string,
) {
  const score = scores[side];
  const name = side === "home" ? "Home" : "Away";
  return {
    id: options[`${side}Id`] ?? `${side}-${id}`,
    homeAway: side,
    score: score === null ? null : String(score),
    winner: scores.winner === side,
    team: {
      displayName: options[`${side}Name`] ?? `${name} ${id}`,
      abbreviation: side === "home" ? "HOM" : "AWY",
      logo: `https://example.invalid/${side}.png`,
    },
  };
}

export function espnEvent(options: EspnGameOptions = {}) {
  const id = options.id ?? "401";
  const status = options.status ?? "STATUS_SCHEDULED";
  const scores = fixtureScores(options, status === "STATUS_FINAL");
  const type = {
    name: status,
    detail: status === "STATUS_FINAL" ? "Final" : "Scheduled",
    completed: status === "STATUS_FINAL",
  };
  return {
    id: `event-${id}`,
    name: options.name ?? `Away ${id} at Home ${id}`,
    date: options.date ?? "2026-09-13T17:00:00Z",
    status: { type: { ...type } },
    competitions: [
      {
        id,
        neutralSite: options.neutralSite ?? false,
        status: { type: { ...type } },
        competitors: [
          fixtureCompetitor(options, scores, "home", id),
          fixtureCompetitor(options, scores, "away", id),
        ],
      },
    ],
  };
}

export function espnScoreboard(
  events = [espnEvent()],
  week = 1,
  season = 2026,
) {
  return { season: { year: season, type: 2 }, week: { number: week }, events };
}

export function scoreboardFixture(
  games: EspnGameOptions[] = [{}],
  week = 1,
  season = 2026,
): Scoreboard {
  return normalizeScoreboard(
    espnScoreboard(games.map(espnEvent), week, season),
  );
}

export function submissionFixture(
  overrides: Partial<SubmissionWithUser> = {},
): SubmissionWithUser {
  return {
    id: 1,
    userId: 1,
    season: 2026,
    week: 1,
    picks: { "401": "home-401" },
    tiebreaker: 41,
    createdAt: "2026-09-08T12:00:00Z",
    updatedAt: "2026-09-08T12:00:00Z",
    user: {
      id: 1,
      discordId: "123456789012345678",
      username: "Player One",
      admin: false,
    },
    ...overrides,
  };
}

export const parityCases = [
  {
    name: "different remaining picks reach exact catch-up boundary",
    raw: espnScoreboard([
      espnEvent({ id: "1", status: "STATUS_FINAL" }),
      espnEvent({ id: "2" }),
    ]),
    submissions: [
      submissionFixture({ picks: { "1": "home-1", "2": "home-2" } }),
      submissionFixture({ id: 2, picks: { "1": "away-1", "2": "away-2" } }),
    ],
  },
  {
    name: "identical remaining picks cannot close a deficit",
    raw: espnScoreboard([
      espnEvent({ id: "1", status: "STATUS_FINAL" }),
      espnEvent({ id: "2" }),
    ]),
    submissions: [
      submissionFixture({ picks: { "1": "home-1", "2": "home-2" } }),
      submissionFixture({ id: 2, picks: { "1": "away-1", "2": "home-2" } }),
    ],
  },
  {
    name: "two points behind with only one different pick is eliminated",
    raw: espnScoreboard([
      espnEvent({ id: "1", status: "STATUS_FINAL" }),
      espnEvent({ id: "2", status: "STATUS_FINAL" }),
      espnEvent({ id: "3" }),
    ]),
    submissions: [
      submissionFixture({
        picks: { "1": "home-1", "2": "home-2", "3": "home-3" },
      }),
      submissionFixture({
        id: 2,
        picks: { "1": "away-1", "2": "away-2", "3": "away-3" },
      }),
    ],
  },
  {
    name: "multiple Monday totals and equidistant winners skip ranks",
    raw: espnScoreboard([
      espnEvent({
        id: "1",
        date: "2026-09-14T23:00:00Z",
        status: "STATUS_FINAL",
        homeScore: 10,
        awayScore: 0,
      }),
      espnEvent({
        id: "2",
        date: "2026-09-15T02:00:00Z",
        status: "STATUS_FINAL",
        homeScore: 17,
        awayScore: 13,
      }),
    ]),
    submissions: [
      submissionFixture({
        picks: { "1": "home-1", "2": "home-2" },
        tiebreaker: 38,
      }),
      submissionFixture({
        id: 2,
        picks: { "1": "home-1", "2": "home-2" },
        tiebreaker: 42,
      }),
      submissionFixture({
        id: 3,
        picks: { "1": "home-1", "2": "home-2" },
        tiebreaker: 49,
      }),
    ],
  },
  {
    name: "no Monday leaves nullable diffs but all top players win",
    raw: espnScoreboard([espnEvent({ status: "STATUS_FINAL" })]),
    submissions: [
      submissionFixture({ tiebreaker: 10 }),
      submissionFixture({ id: 2, tiebreaker: 20 }),
    ],
  },
  {
    name: "partial Monday finals do not activate tiebreaker",
    raw: espnScoreboard([
      espnEvent({
        id: "1",
        date: "2026-09-14T23:00:00Z",
        status: "STATUS_FINAL",
      }),
      espnEvent({
        id: "2",
        date: "2026-09-15T02:00:00Z",
        status: "STATUS_IN_PROGRESS",
        homeScore: 7,
        awayScore: 0,
      }),
    ]),
    submissions: [
      submissionFixture({
        picks: { "1": "home-1", "2": "home-2" },
        tiebreaker: 48,
      }),
      submissionFixture({
        id: 2,
        picks: { "1": "home-1", "2": "away-2" },
        tiebreaker: 30,
      }),
    ],
  },
  {
    name: "zero Monday total is not absent and a tied game credits neither team",
    raw: espnScoreboard([
      espnEvent({
        date: "2026-09-15T00:00:00Z",
        status: "STATUS_FINAL",
        homeScore: 0,
        awayScore: 0,
      }),
    ]),
    submissions: [
      submissionFixture({ tiebreaker: 0 }),
      submissionFixture({ id: 2, picks: { "401": "away-401" }, tiebreaker: 1 }),
    ],
  },
  {
    name: "UTF8 summary uses chronological then string ID order",
    raw: espnScoreboard([
      espnEvent({ id: "2", name: "Deux à Montréal", homeName: "Équipe Deux" }),
      espnEvent({ id: "10", name: "Dix à Québec", awayName: "Équipe Dix" }),
      espnEvent({ id: "3", name: "Earlier", date: "2026-09-11T00:00:00Z" }),
    ]),
    submissions: [
      submissionFixture({
        picks: {
          "2": "home-2",
          "10": "away-10",
          "3": "home-3",
          unknown: "other",
        },
        tiebreaker: 37,
        user: { id: 1, username: "  Zoë 雪", discordId: null, admin: false },
      }),
    ],
  },
  {
    name: "null username and no known picks preserve Ruby stripping",
    raw: espnScoreboard(),
    submissions: [
      submissionFixture({
        picks: { unknown: "other" },
        user: { id: 1, username: null, discordId: null, admin: false },
      }),
    ],
  },
  {
    name: "Ruby strip keeps leading Unicode NBSP in UTF8 hash input",
    raw: espnScoreboard(),
    submissions: [
      submissionFixture({
        user: {
          id: 1,
          username: "\u0000 \u00a0Zoë",
          discordId: null,
          admin: false,
        },
      }),
    ],
  },
];
