import type {
  PickDetail,
  Picks,
  PublicStanding,
  Scoreboard,
  Standing,
  SubmissionDetail,
  SubmissionWithUser,
} from "../../shared/contracts";
import { EspnError } from "./espn";
import { centralCalendar } from "./groups";
import { submissionSummary, verificationHash } from "./summary";

export function gamesStarted(scoreboard: Scoreboard): boolean {
  // An empty board must never turn an existing submission into an editable one.
  return (
    scoreboard.games.length === 0 ||
    scoreboard.games.some((game) => game.status !== "STATUS_SCHEDULED")
  );
}

export function earliestGameTime(scoreboard: Scoreboard): string | null {
  let earliest: string | null = null;
  for (const game of scoreboard.games) {
    if (earliest === null || Date.parse(game.date) < Date.parse(earliest)) {
      earliest = game.date;
    }
  }
  return earliest;
}

export function filterValidPicks(picks: Picks, scoreboard: Scoreboard): Picks {
  const valid: [string, string][] = [];
  for (const game of scoreboard.games) {
    const choice = Object.hasOwn(picks, game.id) ? picks[game.id] : undefined;
    if (
      game.status === "STATUS_SCHEDULED" &&
      (choice === game.homeTeam.id || choice === game.awayTeam.id)
    ) {
      valid.push([game.id, choice]);
    }
  }
  return Object.fromEntries(valid);
}

function markWinners(standings: Standing[], complete: boolean): void {
  const contenders = standings.filter((standing) => standing.contender);
  const [onlyContender] = contenders;
  if (contenders.length === 1 && onlyContender) {
    onlyContender.winner = true;
    return;
  }
  if (!complete) {
    return;
  }
  // With no Monday game all diffs are null, so every tied leader wins.
  let minDiff: number | null = null;
  for (const standing of contenders) {
    const diff = standing.tiebreakerDiff;
    if (diff !== null && (minDiff === null || diff < minDiff)) {
      minDiff = diff;
    }
  }
  for (const standing of contenders) {
    standing.winner = standing.tiebreakerDiff === minDiff;
  }
}

function rankStandings(standings: Standing[]): void {
  // No Monday total means descending guesses still break display-rank ties.
  const secondKey = (standing: Standing) =>
    standing.tiebreakerDiff ?? -standing.tiebreaker;
  standings.sort(
    (a, b) => b.correctPicks - a.correctPicks || secondKey(a) - secondKey(b),
  );
  let previous: Standing | undefined;
  for (const [index, standing] of standings.entries()) {
    standing.rank =
      previous &&
      standing.correctPicks === previous.correctPicks &&
      secondKey(standing) === secondKey(previous)
        ? previous.rank
        : index + 1;
    previous = standing;
  }
}

export function calculateStandings(
  submissions: SubmissionWithUser[],
  scoreboard: Scoreboard,
): Standing[] {
  if (submissions.length === 0 || scoreboard.games.length === 0) {
    return [];
  }
  const results = new Map(
    scoreboard.games
      .filter((game) => game.status === "STATUS_FINAL")
      .map((game) => [game.id, game.winnerId]),
  );
  const remaining = new Set(
    scoreboard.games
      .filter((game) => game.status !== "STATUS_FINAL")
      .map((game) => game.id),
  );
  const complete = remaining.size === 0;
  const mondayGames = scoreboard.games.filter(
    (game) => centralCalendar(game.date).day === "Mon",
  );
  // Rails applies the total only once the entire week is final; zero is a real total.
  const mondayTotal =
    complete && mondayGames.length > 0
      ? mondayGames.reduce((sum, game) => {
          if (game.homeTeam.score === null || game.awayTeam.score === null) {
            throw new EspnError("ESPN returned missing final scores");
          }
          return sum + game.homeTeam.score + game.awayTeam.score;
        }, 0)
      : null;
  const standings: Standing[] = submissions.map((submission) => ({
    user: submission.user,
    submissionId: submission.id,
    correctPicks: Object.entries(submission.picks).filter(
      ([id, choice]) => results.get(id) === choice,
    ).length,
    remainingPicks: Object.fromEntries(
      Object.entries(submission.picks).filter(([id]) => remaining.has(id)),
    ),
    tiebreaker: submission.tiebreaker,
    tiebreakerDiff:
      mondayTotal === null
        ? null
        : Math.abs(submission.tiebreaker - mondayTotal),
    contender: false,
    winner: false,
    rank: 0,
  }));
  const maxCorrect = Math.max(
    ...standings.map((standing) => standing.correctPicks),
  );
  const leaders = standings.filter(
    (standing) => standing.correctPicks === maxCorrect,
  );
  for (const standing of standings) {
    // Preserve Rails' directional difference and ANY-leader rule, not a new outcome simulator.
    standing.contender = leaders.some((leader) => {
      const different = Object.entries(leader.remainingPicks).filter(
        ([id, choice]) => standing.remainingPicks[id] !== choice,
      ).length;
      return standing.correctPicks + different >= leader.correctPicks;
    });
  }
  markWinners(standings, complete);
  rankStandings(standings);
  return standings;
}

export function showTiebreaker(
  standings: Standing[],
  scoreboard: Scoreboard,
): boolean {
  if (
    scoreboard.games.length === 0 ||
    !scoreboard.games.every((game) => game.status === "STATUS_FINAL")
  ) {
    return false;
  }
  const winner = standings.find((standing) => standing.winner);
  return (
    winner !== undefined &&
    standings.filter(
      (standing) => standing.correctPicks === winner.correctPicks,
    ).length > 1
  );
}

export function publicStanding(
  standing: Standing,
  displayTiebreaker: boolean,
): PublicStanding {
  return {
    user: { id: standing.user.id, username: standing.user.username },
    correctPicks: standing.correctPicks,
    remainingCount: Object.keys(standing.remainingPicks).length,
    tiebreaker: displayTiebreaker ? standing.tiebreaker : null,
    tiebreakerDiff: displayTiebreaker ? standing.tiebreakerDiff : null,
    contender: standing.contender,
    winner: standing.winner,
    rank: standing.rank,
  };
}

export function submissionPickDetails(
  picks: Picks,
  scoreboard: Scoreboard,
): PickDetail[] {
  const games = new Map(scoreboard.games.map((game) => [game.id, game]));
  return Object.entries(picks).map(([competitionId, selectedTeamId]) => {
    const game = games.get(competitionId) ?? null;
    const winningTeamId =
      game?.status === "STATUS_FINAL" ? game.winnerId : null;
    return {
      competitionId,
      selectedTeamId,
      winningTeamId,
      correct: selectedTeamId === winningTeamId,
      game,
    };
  });
}

export async function submissionDetail(
  submission: SubmissionWithUser,
  scoreboard: Scoreboard,
): Promise<SubmissionDetail> {
  const picks = submissionPickDetails(submission.picks, scoreboard);
  return {
    submission,
    scoreboard,
    correctPicks: picks.filter((pick) => pick.correct).length,
    picks,
    summary: submissionSummary(submission, scoreboard),
    verificationHash: await verificationHash(submission, scoreboard),
  };
}
