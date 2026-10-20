import { describe, expect, it } from "vitest";
import type { Picks } from "../../src/shared/contracts";
import { aggregateSeason, seasonPhase } from "../../src/server/services/season";
import {
  scoreboardFixture,
  submissionFixture,
  type EspnGameOptions,
} from "../fixtures/espn";

const now = Date.parse("2026-10-04T12:00:00Z");
const future = "2099-09-13T17:00:00Z";
const final = "STATUS_FINAL";

function entry(id: number, userId: number, week: number, picks: Picks) {
  return submissionFixture({
    id,
    userId,
    week,
    picks,
    user: {
      id: userId,
      discordId: null,
      username: `Player ${userId}`,
      admin: false,
    },
  });
}

function week(
  number: number,
  games: EspnGameOptions[],
  submissions: ReturnType<typeof entry>[],
) {
  return { scoreboard: scoreboardFixture(games, number), submissions };
}

const twoFinals: EspnGameOptions[] = [
  { id: "1", status: final },
  { id: "2", status: final },
];

describe("season aggregation", () => {
  it("totals final weeks and shares a rank when correct picks and wins are equal", () => {
    const { weeks, players } = aggregateSeason(
      [
        week(1, twoFinals, [
          entry(1, 1, 1, { "1": "home-1", "2": "home-2" }),
          entry(2, 2, 1, { "1": "home-1", "2": "away-2" }),
          entry(3, 3, 1, { "1": "away-1", "2": "away-2" }),
        ]),
        week(2, twoFinals, [
          entry(4, 1, 2, { "1": "away-1", "2": "away-2" }),
          entry(5, 2, 2, { "1": "home-1", "2": "home-2" }),
          entry(6, 3, 2, { "1": "home-1", "2": "home-2" }),
        ]),
      ],
      null,
      now,
    );
    expect(weeks).toEqual([
      {
        week: 1,
        status: "final",
        playerCount: 3,
        winners: [{ id: 1, username: "Player 1" }],
        entryFeeCents: 500,
        potCents: 1500,
      },
      {
        week: 2,
        status: "final",
        playerCount: 3,
        winners: expect.arrayContaining([
          { id: 2, username: "Player 2" },
          { id: 3, username: "Player 3" },
        ]) as unknown,
        entryFeeCents: 500,
        potCents: 1500,
      },
    ]);
    expect(weeks[1]?.winners).toHaveLength(2);
    expect(players).toEqual([
      {
        user: { id: 2, username: "Player 2" },
        rank: 1,
        correctPicks: 3,
        decidedPicks: 4,
        accuracy: 0.75,
        weeklyWins: 1,
        weeksPlayed: 2,
        bestWeek: { week: 2, correctPicks: 2 },
        worstWeek: { week: 1, correctPicks: 1 },
        averageCorrect: 1.5,
        feesPaidCents: 1000,
        winningsCents: 750,
        netCents: -250,
      },
      {
        user: { id: 1, username: "Player 1" },
        rank: 2,
        correctPicks: 2,
        decidedPicks: 4,
        accuracy: 0.5,
        weeklyWins: 1,
        weeksPlayed: 2,
        bestWeek: { week: 1, correctPicks: 2 },
        worstWeek: { week: 2, correctPicks: 0 },
        averageCorrect: 1,
        feesPaidCents: 1000,
        winningsCents: 1500,
        netCents: 500,
      },
      {
        user: { id: 3, username: "Player 3" },
        rank: 2,
        correctPicks: 2,
        decidedPicks: 4,
        accuracy: 0.5,
        weeklyWins: 1,
        weeksPlayed: 2,
        bestWeek: { week: 2, correctPicks: 2 },
        worstWeek: { week: 1, correctPicks: 0 },
        averageCorrect: 1,
        feesPaidCents: 1000,
        winningsCents: 750,
        netCents: -250,
      },
    ]);
  });

  it("breaks equal correct picks by weekly wins", () => {
    const { players } = aggregateSeason(
      [
        week(1, twoFinals, [
          entry(1, 1, 1, { "1": "home-1", "2": "home-2" }),
          entry(2, 2, 1, { "1": "home-1", "2": "away-2" }),
        ]),
        week(2, twoFinals, [
          entry(3, 1, 2, { "1": "away-1", "2": "away-2" }),
          entry(4, 2, 2, { "1": "away-1", "2": "home-2" }),
          entry(5, 3, 2, { "1": "home-1", "2": "home-2" }),
        ]),
      ],
      null,
      now,
    );
    expect(
      players.map((player) => [
        player.user.id,
        player.rank,
        player.correctPicks,
        player.weeklyWins,
      ]),
    ).toEqual([
      [1, 1, 2, 1],
      [3, 1, 2, 1],
      [2, 3, 2, 0],
    ]);
  });

  it("counts a missed week as zero and never awards a lone submitter", () => {
    const { weeks, players } = aggregateSeason(
      [
        week(1, twoFinals, [
          entry(1, 1, 1, { "1": "home-1", "2": "home-2" }),
          entry(2, 2, 1, { "1": "away-1", "2": "away-2" }),
        ]),
        week(2, twoFinals, [entry(3, 1, 2, { "1": "home-1", "2": "home-2" })]),
      ],
      null,
      now,
    );
    // The lone submitter still pays, but nobody collects that pot.
    expect(weeks[1]).toEqual({
      week: 2,
      status: "final",
      playerCount: 1,
      winners: [],
      entryFeeCents: 500,
      potCents: 500,
    });
    expect(players).toMatchObject([
      {
        user: { id: 1 },
        correctPicks: 4,
        weeklyWins: 1,
        weeksPlayed: 2,
        feesPaidCents: 1000,
        winningsCents: 1000,
        netCents: 0,
      },
      {
        user: { id: 2 },
        correctPicks: 0,
        decidedPicks: 2,
        accuracy: 0,
        weeklyWins: 0,
        weeksPlayed: 1,
        averageCorrect: 0,
      },
    ]);
  });

  it("lists upcoming-week players without contributing any numbers", () => {
    const { weeks, players } = aggregateSeason(
      [
        week(1, twoFinals, [entry(1, 1, 1, { "1": "home-1", "2": "home-2" })]),
        week(
          2,
          [{ id: "1", date: future }],
          [
            entry(2, 1, 2, { "1": "home-1" }),
            entry(3, 2, 2, { "1": "away-1" }),
          ],
        ),
      ],
      2,
      now,
    );
    expect(weeks[1]).toEqual({
      week: 2,
      status: "upcoming",
      playerCount: 2,
      winners: [],
      entryFeeCents: 500,
      potCents: 0,
    });
    expect(players[0]).toMatchObject({
      user: { id: 1 },
      correctPicks: 2,
      decidedPicks: 2,
      weeksPlayed: 1,
    });
    expect(players[1]).toEqual({
      user: { id: 2, username: "Player 2" },
      rank: 2,
      correctPicks: 0,
      decidedPicks: 0,
      accuracy: null,
      weeklyWins: 0,
      weeksPlayed: 0,
      bestWeek: null,
      worstWeek: null,
      averageCorrect: null,
      feesPaidCents: 0,
      winningsCents: 0,
      netCents: 0,
    });
  });

  it("treats a passed kickoff as started even while ESPN still says scheduled", () => {
    const { weeks } = aggregateSeason(
      [
        week(
          3,
          [{ id: "1", date: "2026-10-04T11:00:00Z" }],
          [entry(1, 1, 3, { "1": "home-1" })],
        ),
      ],
      3,
      now,
    );
    expect(weeks[0]?.status).toBe("in_progress");
  });

  it("adds correct picks so far for the current week but decides only final games", () => {
    const games: EspnGameOptions[] = [
      { id: "1", status: final },
      { id: "2", status: "STATUS_IN_PROGRESS" },
      { id: "3", date: future },
    ];
    const submissions = [
      entry(1, 1, 3, { "1": "home-1", "2": "home-2", "3": "home-3" }),
      entry(2, 2, 3, { "1": "away-1", "2": "home-2" }),
    ];
    const live = aggregateSeason([week(3, games, submissions)], 3, now);
    expect(live.weeks).toEqual([
      {
        week: 3,
        status: "in_progress",
        playerCount: 2,
        winners: [],
        entryFeeCents: 500,
        potCents: 1000,
      },
    ]);
    expect(live.players[0]).toMatchObject({
      user: { id: 1 },
      correctPicks: 1,
      decidedPicks: 1,
      accuracy: 1,
      weeksPlayed: 1,
      bestWeek: null,
      worstWeek: null,
      averageCorrect: null,
    });

    const stale = aggregateSeason([week(3, games, submissions)], 5, now);
    expect(stale.weeks[0]?.status).toBe("incomplete");
    expect(stale.players[0]).toMatchObject({
      correctPicks: 1,
      decidedPicks: 1,
      weeksPlayed: 1,
      bestWeek: null,
      worstWeek: null,
      averageCorrect: null,
    });
    expect(
      aggregateSeason([week(3, games, submissions)], null, now).weeks[0],
    ).toMatchObject({ status: "incomplete" });
  });

  it("counts an early clinched winner before the week is final", () => {
    const { weeks, players } = aggregateSeason(
      [
        week(
          4,
          [...twoFinals, { id: "3", status: "STATUS_IN_PROGRESS" }],
          [
            entry(1, 1, 4, { "1": "home-1", "2": "home-2", "3": "home-3" }),
            entry(2, 2, 4, { "1": "away-1", "2": "away-2", "3": "away-3" }),
          ],
        ),
      ],
      4,
      now,
    );
    expect(weeks[0]).toEqual({
      week: 4,
      status: "in_progress",
      playerCount: 2,
      winners: [{ id: 1, username: "Player 1" }],
      entryFeeCents: 500,
      potCents: 1000,
    });
    expect(players[0]).toMatchObject({
      user: { id: 1 },
      weeklyWins: 1,
      winningsCents: 1000,
      netCents: 500,
    });
  });

  it("decides a tied game without crediting it and ignores orphan picks", () => {
    const { players } = aggregateSeason(
      [
        week(
          1,
          [
            { id: "1", status: final, homeScore: 10, awayScore: 10 },
            { id: "2", status: final },
          ],
          [entry(1, 1, 1, { "1": "home-1", "2": "home-2", "999": "home-9" })],
        ),
      ],
      null,
      now,
    );
    expect(players[0]).toMatchObject({
      correctPicks: 1,
      decidedPicks: 2,
      accuracy: 0.5,
    });
  });

  it("reports null accuracy while no pick has been decided", () => {
    const { players } = aggregateSeason(
      [
        week(
          2,
          [{ id: "1", status: "STATUS_IN_PROGRESS" }],
          [entry(1, 1, 2, { "1": "home-1" })],
        ),
      ],
      2,
      now,
    );
    expect(players[0]).toMatchObject({
      correctPicks: 0,
      decidedPicks: 0,
      accuracy: null,
      weeksPlayed: 1,
    });
  });
});

describe("pool winnings", () => {
  it("charges configured fees only for started weeks and splits a tied pot in whole cents", () => {
    const { weeks, players } = aggregateSeason(
      [
        // Players 2 and 3 tie with equal tiebreakers: 1515 cents splits 757 each.
        week(1, twoFinals, [
          entry(1, 1, 1, { "1": "away-1", "2": "away-2" }),
          entry(2, 2, 1, { "1": "home-1", "2": "home-2" }),
          entry(3, 3, 1, { "1": "home-1", "2": "home-2" }),
        ]),
        week(
          2,
          [{ id: "1", status: "STATUS_IN_PROGRESS" }],
          [
            entry(4, 1, 2, { "1": "home-1" }),
            entry(5, 2, 2, { "1": "away-1" }),
          ],
        ),
        week(
          3,
          [{ id: "1", date: future }],
          [
            entry(6, 1, 3, { "1": "home-1" }),
            entry(7, 3, 3, { "1": "away-1" }),
          ],
        ),
      ],
      2,
      now,
      new Map([
        [1, 505],
        [3, 900],
      ]),
    );
    expect(
      weeks.map(({ week, entryFeeCents, potCents }) => [
        week,
        entryFeeCents,
        potCents,
      ]),
    ).toEqual([
      [1, 505, 1515],
      [2, 500, 1000],
      [3, 900, 0],
    ]);
    expect(
      players.map((player) => [
        player.user.id,
        player.feesPaidCents,
        player.winningsCents,
        player.netCents,
      ]),
    ).toEqual([
      [2, 1005, 757, -248],
      [3, 505, 757, 252],
      [1, 1005, 0, -1005],
    ]);
  });

  it("collects the fee without awarding a pot for an incomplete week", () => {
    const { weeks, players } = aggregateSeason(
      [
        week(
          3,
          [
            { id: "1", status: final },
            { id: "2", status: "STATUS_IN_PROGRESS" },
          ],
          [
            entry(1, 1, 3, { "1": "home-1", "2": "home-2" }),
            entry(2, 2, 3, { "1": "away-1", "2": "away-2" }),
          ],
        ),
      ],
      null,
      now,
    );
    expect(weeks[0]).toMatchObject({
      status: "incomplete",
      winners: [],
      entryFeeCents: 500,
      potCents: 1000,
    });
    expect(players.map((player) => player.netCents)).toEqual([-500, -500]);
  });
});

describe("season phase", () => {
  it("compares the requested season with ESPN's current season and phase", () => {
    const context = { season: 2026, seasonType: 2, week: 5 };
    expect(seasonPhase(2025, context)).toBe("complete");
    expect(seasonPhase(2027, context)).toBe("upcoming");
    expect(seasonPhase(2026, context)).toBe("in_progress");
    expect(seasonPhase(2026, { ...context, seasonType: 1, week: null })).toBe(
      "upcoming",
    );
    for (const seasonType of [3, 4]) {
      expect(seasonPhase(2026, { ...context, seasonType, week: null })).toBe(
        "complete",
      );
    }
  });
});
