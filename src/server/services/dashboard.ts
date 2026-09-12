import type { D1Database } from "@cloudflare/workers-types";
import type {
  DashboardData,
  DashboardRecap,
  DashboardWeek,
  Scoreboard,
  SeasonWeek,
  Submission,
  SubmissionWithUser,
} from "../../shared/contracts";
import { listWeekSubmissions } from "../db";
import { fetchScoreboard, getSeasonContext } from "./espn";
import {
  calculateStandings,
  earliestGameTime,
  gamesStarted,
  publicStanding,
  showTiebreaker,
  submissionPickDetails,
} from "./scoring";

function personalStanding(
  submissions: SubmissionWithUser[],
  scoreboard: Scoreboard,
  userId: number,
) {
  const standings = calculateStandings(submissions, scoreboard);
  const own = standings.find((standing) => standing.user.id === userId);
  return own
    ? publicStanding(own, showTiebreaker(standings, scoreboard))
    : null;
}

function weeklyAction(
  scoreboard: Scoreboard,
  submitted: boolean,
  locked: boolean,
  now: number,
): DashboardWeek["action"] {
  let eligibleGames = 0;
  let deadline = Infinity;
  for (const game of scoreboard.games) {
    const kickoff = Date.parse(game.date);
    if (game.status !== "STATUS_SCHEDULED" || kickoff <= now) {
      continue;
    }
    eligibleGames += 1;
    deadline = Math.min(deadline, kickoff);
  }
  if (eligibleGames === 0) {
    return { kind: "closed", eligibleGames: 0, deadline: null };
  }
  if (submitted && locked) {
    return { kind: "locked", eligibleGames: 0, deadline: null };
  }
  return {
    kind: submitted ? "review" : "make",
    eligibleGames,
    deadline: new Date(deadline).toISOString(),
  };
}

async function currentWeek(
  db: D1Database,
  userId: number,
  period: SeasonWeek,
): Promise<DashboardWeek> {
  const [scoreboard, submissions] = await Promise.all([
    fetchScoreboard(period),
    listWeekSubmissions(db, period),
  ]);
  const own = submissions.find((submission) => submission.userId === userId);
  const submission: Submission | null = own
    ? {
        id: own.id,
        userId: own.userId,
        season: own.season,
        week: own.week,
        picks: own.picks,
        tiebreaker: own.tiebreaker,
        createdAt: own.createdAt,
        updatedAt: own.updatedAt,
      }
    : null;
  const now = Date.now();
  const kickoff = earliestGameTime(scoreboard);
  const locked =
    gamesStarted(scoreboard) ||
    (kickoff !== null && Date.parse(kickoff) <= now);
  return {
    scoreboard,
    submission,
    locked,
    earliestGameTime: kickoff,
    picks: own ? submissionPickDetails(own.picks, scoreboard) : [],
    standing: own ? personalStanding(submissions, scoreboard, userId) : null,
    playerCount: submissions.length,
    action: weeklyAction(scoreboard, own !== undefined, locked, now),
  };
}

async function previousWeek(
  db: D1Database,
  userId: number,
  period: SeasonWeek,
): Promise<DashboardRecap | null> {
  const submissions = await listWeekSubmissions(db, period);
  const own = submissions.find((submission) => submission.userId === userId);
  if (!own) {
    return null;
  }
  const scoreboard = await fetchScoreboard(period);
  const standing = personalStanding(submissions, scoreboard, userId);
  if (!standing) {
    return null;
  }
  return {
    season: period.season,
    week: period.week,
    submissionId: own.id,
    standing,
    playerCount: submissions.length,
    complete: scoreboard.games.every((game) => game.status === "STATUS_FINAL"),
    hasResults: scoreboard.games.some((game) => game.status === "STATUS_FINAL"),
  };
}

function recapWeek(seasonType: number, week: number | null) {
  if (seasonType === 1) {
    return null;
  }
  if (week === null) {
    return 18;
  }
  return week > 1 ? week - 1 : null;
}

export async function dashboard(
  db: D1Database,
  userId: number,
): Promise<DashboardData> {
  const context = await getSeasonContext();
  const phases: Record<number, DashboardData["phase"]> = {
    1: "preseason",
    2: "regular",
    3: "postseason",
    4: "offseason",
  };
  const previous = recapWeek(context.seasonType, context.week);
  const [current, recap] = await Promise.all([
    context.week === null
      ? null
      : currentWeek(db, userId, { season: context.season, week: context.week }),
    previous === null
      ? null
      : previousWeek(db, userId, { season: context.season, week: previous }),
  ]);
  return {
    season: context.season,
    phase: phases[context.seasonType] ?? "offseason",
    current,
    previous: recap,
    checkedAt: new Date().toISOString(),
  };
}
