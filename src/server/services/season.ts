import {
  DEFAULT_ENTRY_FEE_CENTS,
  type Scoreboard,
  type SeasonData,
  type SeasonPlayerTotals,
  type SeasonWeekScore,
  type SeasonWeekStatus,
  type SeasonWeekSummary,
  type SubmissionWithUser,
  type User,
} from "../../shared/contracts";
import type { Env } from "../env";
import { listSeasonEntryFees, listSeasonSubmissions } from "../db";
import type { SeasonContext } from "./espn";
import { loadScoreboard } from "./scoreboards";
import {
  calculateStandings,
  earliestGameTime,
  gamesStarted,
  scoreboardComplete,
} from "./scoring";

type PublicUser = Pick<User, "id" | "username">;

interface SeasonWeekInput {
  scoreboard: Scoreboard;
  submissions: SubmissionWithUser[];
}

/** Week number to configured fee in whole cents; absent weeks use the default. */
type EntryFees = ReadonlyMap<number, number>;

interface WeekResult {
  user: PublicUser;
  correctPicks: number;
  decidedPicks: number;
  winner: boolean;
  winningsCents: number;
}

interface MutableTotals {
  user: PublicUser;
  correctPicks: number;
  decidedPicks: number;
  weeklyWins: number;
  weeksPlayed: number;
  feesPaidCents: number;
  winningsCents: number;
  finalWeeks: SeasonWeekScore[];
}

function classifyWeek(
  scoreboard: Scoreboard,
  current: boolean,
  now: number,
): SeasonWeekStatus {
  if (scoreboardComplete(scoreboard)) {
    return "final";
  }
  const kickoff = earliestGameTime(scoreboard);
  const started =
    gamesStarted(scoreboard) ||
    (kickoff !== null && Date.parse(kickoff) <= now);
  if (!started) {
    return "upcoming";
  }
  // A started, unfinished week that ESPN has moved past has a cancelled or postponed game.
  return current ? "in_progress" : "incomplete";
}

function weekResults(
  { scoreboard, submissions }: SeasonWeekInput,
  entryFeeCents: number,
  current: boolean,
  now: number,
): { summary: SeasonWeekSummary; results: WeekResult[] } {
  const finals = new Set(
    scoreboard.games
      .filter((game) => game.status === "STATUS_FINAL")
      .map((game) => game.id),
  );
  // Picks for games no longer on this week's board are neither correct nor decided.
  const decided = new Map(
    submissions.map((submission) => [
      submission.id,
      Object.keys(submission.picks).filter((id) => finals.has(id)).length,
    ]),
  );
  const standings = calculateStandings(submissions, scoreboard);
  // Matches Discord: a lone submitter never wins, a clinched leader does.
  const winners = standings.filter(
    (standing) => standing.winner && standings.length > 1,
  );
  const status = classifyWeek(scoreboard, current, now);
  // Every submitter pays once the week starts; a lone submitter's fee stays in
  // an unawarded pot, as does the pot of a week that never resolves a winner.
  const potCents =
    status === "upcoming" ? 0 : entryFeeCents * submissions.length;
  // Tied winners split the pot in whole cents. Any leftover cents (fewer than
  // one per winner) stay unassigned rather than inventing a tiebreak.
  const share = winners.length ? Math.floor(potCents / winners.length) : 0;
  const results = standings.map((standing) => {
    const winner = winners.includes(standing);
    return {
      user: { id: standing.user.id, username: standing.user.username },
      correctPicks: standing.correctPicks,
      decidedPicks: decided.get(standing.submissionId) ?? 0,
      winner,
      winningsCents: winner ? share : 0,
    };
  });
  return {
    summary: {
      week: scoreboard.week,
      status,
      playerCount: submissions.length,
      winners: results
        .filter((result) => result.winner)
        .map((result) => result.user),
      entryFeeCents,
      potCents,
    },
    results,
  };
}

function accumulate(
  totals: Map<number, MutableTotals>,
  summary: SeasonWeekSummary,
  results: WeekResult[],
): void {
  for (const result of results) {
    let entry = totals.get(result.user.id);
    if (!entry) {
      entry = {
        user: result.user,
        correctPicks: 0,
        decidedPicks: 0,
        weeklyWins: 0,
        weeksPlayed: 0,
        feesPaidCents: 0,
        winningsCents: 0,
        finalWeeks: [],
      };
      totals.set(result.user.id, entry);
    }
    // Upcoming weeks list the player without contributing any numbers.
    if (summary.status === "upcoming") {
      continue;
    }
    entry.correctPicks += result.correctPicks;
    entry.decidedPicks += result.decidedPicks;
    entry.weeksPlayed += 1;
    entry.weeklyWins += result.winner ? 1 : 0;
    entry.feesPaidCents += summary.entryFeeCents;
    entry.winningsCents += result.winningsCents;
    if (summary.status === "final") {
      entry.finalWeeks.push({
        week: summary.week,
        correctPicks: result.correctPicks,
      });
    }
  }
}

function finishTotals({
  finalWeeks,
  ...totals
}: MutableTotals): SeasonPlayerTotals {
  let bestWeek: SeasonWeekScore | null = null;
  let worstWeek: SeasonWeekScore | null = null;
  let finalCorrect = 0;
  for (const score of finalWeeks) {
    finalCorrect += score.correctPicks;
    if (!bestWeek || score.correctPicks > bestWeek.correctPicks) {
      bestWeek = score;
    }
    if (!worstWeek || score.correctPicks < worstWeek.correctPicks) {
      worstWeek = score;
    }
  }
  return {
    ...totals,
    rank: 0,
    accuracy:
      totals.decidedPicks > 0
        ? totals.correctPicks / totals.decidedPicks
        : null,
    bestWeek,
    worstWeek,
    averageCorrect: finalWeeks.length ? finalCorrect / finalWeeks.length : null,
    netCents: totals.winningsCents - totals.feesPaidCents,
  };
}

function rankPlayers(players: SeasonPlayerTotals[]): SeasonPlayerTotals[] {
  players.sort(
    (a, b) =>
      b.correctPicks - a.correctPicks ||
      b.weeklyWins - a.weeklyWins ||
      a.user.id - b.user.id,
  );
  let previous: SeasonPlayerTotals | undefined;
  for (const [index, player] of players.entries()) {
    player.rank =
      previous &&
      player.correctPicks === previous.correctPicks &&
      player.weeklyWins === previous.weeklyWins
        ? previous.rank
        : index + 1;
    previous = player;
  }
  return players;
}

export function aggregateSeason(
  weeks: SeasonWeekInput[],
  currentWeek: number | null,
  now: number,
  entryFees: EntryFees = new Map(),
): Pick<SeasonData, "weeks" | "players"> {
  const totals = new Map<number, MutableTotals>();
  const summaries = weeks.map((week) => {
    const { summary, results } = weekResults(
      week,
      entryFees.get(week.scoreboard.week) ?? DEFAULT_ENTRY_FEE_CENTS,
      week.scoreboard.week === currentWeek,
      now,
    );
    accumulate(totals, summary, results);
    return summary;
  });
  return {
    weeks: summaries,
    players: rankPlayers([...totals.values()].map(finishTotals)),
  };
}

export function seasonPhase(
  season: number,
  context: SeasonContext,
): SeasonData["phase"] {
  if (season !== context.season) {
    return season < context.season ? "complete" : "upcoming";
  }
  if (context.seasonType === 1) {
    return "upcoming";
  }
  return context.seasonType === 2 ? "in_progress" : "complete";
}

export async function seasonSummary(
  env: Pick<Env, "DB" | "MAINTENANCE_MODE">,
  season: number,
  context: SeasonContext,
): Promise<SeasonData> {
  const [submissions, entryFees] = await Promise.all([
    listSeasonSubmissions(env.DB, season),
    listSeasonEntryFees(env.DB, season),
  ]);
  const byWeek = Map.groupBy(submissions, (submission) => submission.week);
  const weeks = await Promise.all(
    [...byWeek].map(async ([week, submissions]) => ({
      scoreboard: await loadScoreboard(env, { season, week }),
      submissions,
    })),
  );
  const currentWeek =
    context.season === season && context.seasonType === 2 ? context.week : null;
  const now = Date.now();
  const totals = aggregateSeason(weeks, currentWeek, now, entryFees);
  return {
    season,
    phase: seasonPhase(season, context),
    inProgressWeek:
      totals.weeks.find((week) => week.status === "in_progress")?.week ?? null,
    ...totals,
    checkedAt: new Date(now).toISOString(),
  };
}
