import type {
  PaymentEntry,
  PaymentPlayerBalance,
  PaymentsData,
  SeasonData,
  User,
} from "../../shared/contracts";
import type { Env } from "../env";
import { listUsers } from "../db";
import { getBankerUserId, listPaymentEntries } from "../ledger";
import { listPaymentKeywords, listVenmoAccounts } from "../venmo-accounts";
import type { SeasonContext } from "./espn";
import { seasonSummary } from "./season";

type PublicUser = Pick<User, "id" | "username">;

interface LedgerInput {
  season: Pick<SeasonData, "players" | "weeks">;
  /** Every entry for the season, in any status. */
  entries: readonly PaymentEntry[];
  users: readonly PublicUser[];
  bankerUserId: number | null;
}

interface Movement {
  paidInCents: number;
  paidOutCents: number;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function approvedMovements(
  entries: readonly PaymentEntry[],
): Map<number, Movement> {
  const movements = new Map<number, Movement>();
  for (const entry of entries) {
    if (entry.status !== "approved" || entry.userId === null) {
      continue;
    }
    const movement = movements.get(entry.userId) ?? {
      paidInCents: 0,
      paidOutCents: 0,
    };
    if (entry.direction === "in") {
      movement.paidInCents += entry.amountCents;
    } else {
      movement.paidOutCents += entry.amountCents;
    }
    movements.set(entry.userId, movement);
  }
  return movements;
}

/** Players with a submission, then anyone with a ledger entry of any status. */
function ledgerPlayers({
  season,
  entries,
  users,
}: LedgerInput): Map<number, PublicUser> {
  const known = new Map(users.map((user) => [user.id, user]));
  const players = new Map(
    season.players.map((player) => [player.user.id, player.user]),
  );
  for (const { userId } of entries) {
    if (userId !== null && !players.has(userId)) {
      players.set(userId, known.get(userId) ?? { id: userId, username: null });
    }
  }
  return players;
}

function byUsername(a: PaymentPlayerBalance, b: PaymentPlayerBalance): number {
  const left = a.user.username;
  const right = b.user.username;
  if (left !== right) {
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    return left.localeCompare(right, "en") || (left < right ? -1 : 1);
  }
  return a.user.id - b.user.id;
}

/**
 * Balances every season player against approved ledger entries. Positive
 * balances are owed by the banker; the banker's own row always nets to zero.
 */
export function paymentBalances(
  input: LedgerInput,
): Pick<PaymentsData, "players" | "summary"> {
  const totals = new Map(
    input.season.players.map((player) => [player.user.id, player]),
  );
  const movements = approvedMovements(input.entries);
  const players = [...ledgerPlayers(input).values()].map((user) => {
    const { paidInCents, paidOutCents } = movements.get(user.id) ?? {
      paidInCents: 0,
      paidOutCents: 0,
    };
    const feesCents = totals.get(user.id)?.feesPaidCents ?? 0;
    const winningsCents = totals.get(user.id)?.winningsCents ?? 0;
    const banker = user.id === input.bankerUserId;
    return {
      user: { id: user.id, username: user.username },
      banker,
      feesCents,
      winningsCents,
      paidInCents,
      paidOutCents,
      balanceCents: banker
        ? 0
        : paidInCents - feesCents + winningsCents - paidOutCents,
    };
  });
  players.sort(byUsername);
  const approved = input.entries.filter((entry) => entry.status === "approved");
  const balances = players.map((player) => player.balanceCents);
  return {
    players,
    summary: {
      collectedCents: sum(
        approved.filter((entry) => entry.direction === "in"),
        (entry) => entry.amountCents,
      ),
      paidOutCents: sum(
        approved.filter((entry) => entry.direction === "out"),
        (entry) => entry.amountCents,
      ),
      owedToBankerCents: sum(
        balances.filter((cents) => cents < 0),
        (cents) => -cents,
      ),
      owedByBankerCents: sum(
        balances.filter((cents) => cents > 0),
        (cents) => cents,
      ),
      unawardedCents:
        sum(input.season.weeks, (week) => week.potCents) -
        sum(input.season.players, (player) => player.winningsCents),
    },
  };
}

export async function paymentsData(
  env: Pick<Env, "DB" | "MAINTENANCE_MODE">,
  season: number,
  context: SeasonContext,
): Promise<PaymentsData> {
  const [summary, entries, users, bankerUserId, venmoAccounts, keywords] =
    await Promise.all([
      seasonSummary(env, season, context),
      listPaymentEntries(env.DB, season),
      listUsers(env.DB),
      getBankerUserId(env.DB),
      listVenmoAccounts(env.DB),
      listPaymentKeywords(env.DB),
    ]);
  const publicUsers = users.map(({ id, username }) => ({ id, username }));
  return {
    season,
    bankerUserId,
    ...paymentBalances({
      season: summary,
      entries,
      users: publicUsers,
      bankerUserId,
    }),
    entries,
    users: publicUsers,
    venmoAccounts,
    keywords,
  };
}
