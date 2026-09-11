import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Standing } from "../../src/shared/contracts";
import { normalizeScoreboard } from "../../src/server/services/espn";
import { completedGroups } from "../../src/server/services/groups";
import {
  calculateStandings,
  earliestGameTime,
  filterValidPicks,
  gamesStarted,
  showTiebreaker,
  submissionDetail,
} from "../../src/server/services/scoring";
import {
  submissionSummary,
  verificationHash,
} from "../../src/server/services/summary";
import {
  parityCases,
  scoreboardFixture,
  submissionFixture,
} from "../fixtures/espn";

interface ReferenceResult {
  standings: Omit<Standing, "user">[];
  showTiebreaker: boolean;
  summaries: string[];
  hashes: string[];
  groups: string[];
}

// Generated once from the actual Ruby classes; normal tests need only Node.
const reference = JSON.parse(
  readFileSync(
    new URL("../fixtures/espn-reference.json", import.meta.url),
    "utf8",
  ),
) as ReferenceResult[];

describe("Rails domain parity", () => {
  for (const [index, scenario] of parityCases.entries()) {
    it(scenario.name, async () => {
      const board = normalizeScoreboard(scenario.raw);
      const standings = calculateStandings(scenario.submissions, board);
      const expected = reference[index];
      assert(expected);
      expect(
        standings.map((standing) => {
          const copy: Partial<Standing> = { ...standing };
          delete copy.user;
          return copy;
        }),
      ).toEqual(expected.standings);
      expect(showTiebreaker(standings, board)).toBe(expected.showTiebreaker);
      expect(completedGroups(board)).toEqual(expected.groups);
      expect(
        scenario.submissions.map((submission) =>
          submissionSummary(submission, board),
        ),
      ).toEqual(expected.summaries);
      expect(
        await Promise.all(
          scenario.submissions.map((submission) =>
            verificationHash(submission, board),
          ),
        ),
      ).toEqual(expected.hashes);
    });
  }
});

it("keeps exact summary newlines, accents, and lexicographic competition ordering", () => {
  const scenario = parityCases[7];
  assert(scenario);
  const submission = scenario.submissions[0];
  assert(submission);
  expect(submissionSummary(submission, normalizeScoreboard(scenario.raw))).toBe(
    "Zoë 雪\nEarlier: Home 3\nDix à Québec: Équipe Dix\nDeux à Montréal: Équipe Deux\nTiebreaker: 37",
  );
});

it("excludes invented IDs, opposing-game teams and already started picks", () => {
  const board = scoreboardFixture([
    { id: "1" },
    { id: "2" },
    { id: "3", status: "STATUS_IN_PROGRESS" },
    { id: "4", status: "STATUS_FINAL" },
  ]);
  const picks = {
    "1": "home-1",
    "2": "away-1",
    "3": "home-3",
    "4": "home-4",
    invented: "home-1",
  };
  expect(filterValidPicks(picks, board)).toEqual({ "1": "home-1" });
  expect(gamesStarted(board)).toBe(true);
  expect(picks["3"]).toBe("home-3");
});

it("fails closed on an empty board and finds kickoff independently of input order", () => {
  expect(gamesStarted({ season: 2026, week: 1, games: [] })).toBe(true);
  expect(
    filterValidPicks({ unknown: "team" }, { season: 2026, week: 1, games: [] }),
  ).toEqual({});
  expect(earliestGameTime({ season: 2026, week: 1, games: [] })).toBeNull();
  expect(
    calculateStandings([submissionFixture()], {
      season: 2026,
      week: 1,
      games: [],
    }),
  ).toEqual([]);
  const board = scoreboardFixture([
    { date: "2026-09-14T23:00:00Z" },
    { id: "2", date: "2026-09-11T00:00:00Z" },
  ]);
  expect(gamesStarted(board)).toBe(false);
  expect(earliestGameTime(board)).toBe("2026-09-11T00:00:00.000Z");
});

it("shows unknown historical picks without crediting them or guessing a game", async () => {
  const submission = submissionFixture({
    picks: { "401": "home-401", unknown: "other" },
  });
  const detail = await submissionDetail(
    submission,
    scoreboardFixture([{ status: "STATUS_FINAL" }]),
  );
  expect(detail.correctPicks).toBe(1);
  expect(detail.picks).toEqual([
    expect.objectContaining({
      competitionId: "401",
      correct: true,
      winningTeamId: "home-401",
    }),
    {
      competitionId: "unknown",
      selectedTeamId: "other",
      winningTeamId: null,
      correct: false,
      game: null,
    },
  ]);
  expect(detail.summary).not.toContain("unknown");
});

it("preserves shared no-Monday winners despite differing display ranks and shows the tiebreaker section", () => {
  const board = scoreboardFixture([{ status: "STATUS_FINAL" }]);
  const standings = calculateStandings(
    [
      submissionFixture({ tiebreaker: 10 }),
      submissionFixture({ id: 2, tiebreaker: 20 }),
    ],
    board,
  );
  expect(
    standings.map((standing) => [
      standing.submissionId,
      standing.rank,
      standing.winner,
      standing.tiebreakerDiff,
    ]),
  ).toEqual([
    [2, 1, true, null],
    [1, 2, true, null],
  ]);
  expect(showTiebreaker(standings, board)).toBe(true);
});
