import { describe, expect, it } from "vitest";
import type {
  PaymentEntry,
  SeasonPlayerTotals,
  SeasonWeekSummary,
} from "../../src/shared/contracts";
import { paymentBalances } from "../../src/server/services/payments";

function totals(
  id: number,
  username: string | null,
  feesPaidCents: number,
  winningsCents: number,
): SeasonPlayerTotals {
  return {
    user: { id, username },
    rank: 1,
    correctPicks: 0,
    decidedPicks: 0,
    accuracy: null,
    weeklyWins: 0,
    weeksPlayed: 0,
    bestWeek: null,
    worstWeek: null,
    averageCorrect: null,
    feesPaidCents,
    winningsCents,
    netCents: winningsCents - feesPaidCents,
  };
}

function week(number: number, potCents: number): SeasonWeekSummary {
  return {
    week: number,
    status: "final",
    playerCount: 0,
    winners: [],
    entryFeeCents: 500,
    potCents,
  };
}

let nextId = 1;
function payment(
  userId: number | null,
  direction: PaymentEntry["direction"],
  amountCents: number,
  status: PaymentEntry["status"] = "approved",
): PaymentEntry {
  const id = nextId++;
  return {
    id,
    season: 2026,
    userId,
    direction,
    amountCents,
    source: "manual",
    status,
    note: null,
    venmoName: null,
    venmoTransactionId: null,
    paidAt: "2026-09-10T12:00:00.000Z",
    createdAt: "2026-09-10T12:00:00.000Z",
    voidedAt: status === "voided" ? "2026-09-11T12:00:00.000Z" : null,
  };
}

const users = [
  { id: 1, username: "Banker" },
  { id: 2, username: "carol" },
  { id: 3, username: "alice" },
  { id: 4, username: "Dave" },
  { id: 5, username: null },
  { id: 6, username: "Erin" },
];

// Two weeks of $5 entries from four players: $20 + $20 in pots.
const season = {
  weeks: [week(1, 2000), week(2, 2000)],
  players: [
    totals(1, "Banker", 1000, 0),
    // Week 1 winner, who also prepaid the whole season.
    totals(2, "carol", 1000, 2000),
    // Week 2 tie: two winners split $20, so nothing is left over.
    totals(3, "alice", 1000, 1000),
    totals(4, "Dave", 1000, 1000),
  ],
};

describe("payment balances", () => {
  it("balances prepaid credit, debtors, owed winners, and the banker", () => {
    const { players, summary } = paymentBalances({
      season,
      entries: [
        payment(2, "in", 9000),
        payment(3, "in", 500),
        payment(4, "in", 1000),
        payment(4, "out", 1000),
        payment(1, "in", 1000),
      ],
      users,
      bankerUserId: 1,
    });
    expect(players).toEqual([
      {
        user: { id: 3, username: "alice" },
        banker: false,
        feesCents: 1000,
        winningsCents: 1000,
        paidInCents: 500,
        paidOutCents: 0,
        balanceCents: 500,
      },
      {
        user: { id: 1, username: "Banker" },
        banker: true,
        feesCents: 1000,
        winningsCents: 0,
        paidInCents: 1000,
        paidOutCents: 0,
        balanceCents: 0,
      },
      {
        user: { id: 2, username: "carol" },
        banker: false,
        feesCents: 1000,
        winningsCents: 2000,
        paidInCents: 9000,
        paidOutCents: 0,
        balanceCents: 10000,
      },
      {
        user: { id: 4, username: "Dave" },
        banker: false,
        feesCents: 1000,
        winningsCents: 1000,
        paidInCents: 1000,
        paidOutCents: 1000,
        balanceCents: 0,
      },
    ]);
    expect(summary).toEqual({
      collectedCents: 11500,
      paidOutCents: 1000,
      owedToBankerCents: 0,
      owedByBankerCents: 10500,
      unawardedCents: 0,
    });
  });

  it("reports a debtor as owed to the banker", () => {
    const { players, summary } = paymentBalances({
      season: { weeks: [week(1, 1000)], players: [totals(2, "carol", 500, 0)] },
      entries: [],
      users,
      bankerUserId: null,
    });
    expect(players.map((player) => player.balanceCents)).toEqual([-500]);
    expect(summary.owedToBankerCents).toBe(500);
    expect(summary.owedByBankerCents).toBe(0);
    // Nobody won the $10 pot, so the banker holds it.
    expect(summary.unawardedCents).toBe(1000);
  });

  it("ignores unapproved entries but keeps their players listed", () => {
    const { players, summary } = paymentBalances({
      season: { weeks: [], players: [] },
      entries: [
        payment(6, "in", 2500, "voided"),
        payment(6, "in", 700),
        payment(5, "out", 300),
        payment(4, "in", 900, "pending"),
        payment(2, "in", 900, "ignored"),
        payment(null, "in", 400, "pending"),
      ],
      users,
      bankerUserId: 1,
    });
    // A user with ledger entries but no submissions has no fees or winnings;
    // usernames sort case-insensitively with the nameless player last.
    expect(
      players.map((player) => [
        player.user.id,
        player.paidInCents,
        player.paidOutCents,
        player.balanceCents,
      ]),
    ).toEqual([
      [2, 0, 0, 0],
      [4, 0, 0, 0],
      [6, 700, 0, 700],
      [5, 0, 300, -300],
    ]);
    expect(summary).toEqual({
      collectedCents: 700,
      paidOutCents: 300,
      owedToBankerCents: 300,
      owedByBankerCents: 700,
      unawardedCents: 0,
    });
  });

  it("keeps split remainders and winnerless pots unawarded", () => {
    const { summary } = paymentBalances({
      season: {
        // Week 1: $10.01 split three ways leaves 2 cents; week 2 had no winner.
        weeks: [week(1, 1001), week(2, 1500)],
        players: [
          totals(2, "carol", 0, 333),
          totals(3, "alice", 0, 333),
          totals(4, "Dave", 0, 333),
        ],
      },
      entries: [],
      users,
      bankerUserId: null,
    });
    expect(summary.unawardedCents).toBe(1502);
  });
});
