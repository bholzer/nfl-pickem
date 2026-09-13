import type {
  Game,
  Scoreboard,
  SubmissionWithUser,
} from "../../shared/contracts";

function compareGames(a: Game, b: Game): number {
  const dateOrder = Date.parse(a.date) - Date.parse(b.date);
  if (dateOrder !== 0 || a.id === b.id) {
    return dateOrder;
  }
  return a.id < b.id ? -1 : 1;
}

function rubyStrip(value: string): string {
  // Ruby String#strip removes NUL and ASCII whitespace, not Unicode whitespace.
  const whitespace = "\0\t\n\v\f\r ";
  let start = 0;
  let end = value.length;
  while (start < end && whitespace.includes(value.charAt(start))) {
    start++;
  }
  while (end > start && whitespace.includes(value.charAt(end - 1))) {
    end--;
  }
  return value.slice(start, end);
}

export function submissionSummary(
  submission: SubmissionWithUser,
  scoreboard: Scoreboard,
): string {
  const games = [...scoreboard.games].sort(compareGames);
  const lines: string[] = [];
  for (const game of games) {
    const choice = submission.picks[game.id];
    if (game.homeTeam.id === choice) {
      lines.push(`${game.name}: ${game.homeTeam.name}`);
    } else if (game.awayTeam.id === choice) {
      lines.push(`${game.name}: ${game.awayTeam.name}`);
    }
  }
  return rubyStrip(
    `${submission.user.username ?? ""}\n${lines.join("\n")}\nTiebreaker: ${submission.tiebreaker}\n`,
  );
}

export async function verificationHash(
  submission: SubmissionWithUser,
  scoreboard: Scoreboard,
): Promise<string> {
  return summaryHash(submissionSummary(submission, scoreboard));
}

export async function summaryHash(summary: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(summary),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
