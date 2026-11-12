export interface User {
  id: number;
  discordId: string | null;
  username: string | null;
  admin: boolean;
}

/** NFL season starting year: January 2027 belongs to season 2026. */
export interface SeasonWeek {
  season: number;
  week: number;
}

export interface SeasonsData {
  currentSeason: number;
  seasons: number[];
}

export type Picks = Record<string, string>;

export interface Submission extends SeasonWeek {
  id: number;
  userId: number;
  picks: Picks;
  tiebreaker: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionWithUser extends Submission {
  user: User;
}

export interface Team {
  id: string;
  name: string;
  abbreviation: string;
  logo: string;
  score: number | null;
}

export interface Game {
  id: string;
  name: string;
  date: string;
  neutralSite: boolean;
  status: string;
  statusDetail: string;
  homeTeam: Team;
  awayTeam: Team;
  winnerId: string | null;
  moneyline: {
    home: number | null;
    away: number | null;
    provider: string | null;
  } | null;
}

export interface Scoreboard extends SeasonWeek {
  games: Game[];
}

export interface Standing {
  user: User;
  submissionId: number;
  correctPicks: number;
  remainingPicks: Picks;
  tiebreaker: number;
  tiebreakerDiff: number | null;
  contender: boolean;
  winner: boolean;
  rank: number;
}

export interface PublicStanding {
  user: Pick<User, "id" | "username">;
  correctPicks: number;
  remainingCount: number;
  tiebreaker: number | null;
  tiebreakerDiff: number | null;
  contender: boolean;
  winner: boolean;
  rank: number;
}

export interface PickDetail {
  competitionId: string;
  selectedTeamId: string;
  winningTeamId: string | null;
  correct: boolean;
  game: Game | null;
}

export interface SubmissionDetail {
  submission: SubmissionWithUser;
  scoreboard: Scoreboard;
  correctPicks: number;
  picks: PickDetail[];
  summary: string;
  verificationHash: string;
}

export interface PublicReceipt extends SeasonWeek {
  id: string;
  username: string | null;
  verificationHash: string;
  snapshotAt: string;
  originalMessageUrl: string;
  summary: string;
}

export interface WeekData {
  scoreboard: Scoreboard;
  submission: Submission | null;
  locked: boolean;
  earliestGameTime: string | null;
}

export interface DashboardWeek extends WeekData {
  picks: PickDetail[];
  standing: PublicStanding | null;
  playerCount: number;
  action: {
    kind: "make" | "review" | "locked" | "closed";
    eligibleGames: number;
    deadline: string | null;
  };
}

export interface DashboardRecap extends SeasonWeek {
  submissionId: number;
  standing: PublicStanding;
  playerCount: number;
  complete: boolean;
  hasResults: boolean;
}

export interface DashboardData {
  season: number;
  phase: "preseason" | "regular" | "postseason" | "offseason";
  current: DashboardWeek | null;
  previous: DashboardRecap | null;
  checkedAt: string;
}

export interface StandingsData {
  scoreboard: Scoreboard;
  standings: PublicStanding[];
  showTiebreaker: boolean;
}

export type SeasonWeekStatus =
  "final" | "in_progress" | "incomplete" | "upcoming";

export interface SeasonWeekSummary {
  week: number;
  status: SeasonWeekStatus;
  playerCount: number;
  winners: Pick<User, "id" | "username">[];
  /** Whole cents each player paid to enter this week. */
  entryFeeCents: number;
  /** Fee times players for started weeks; 0 while the week is upcoming. */
  potCents: number;
}

export interface SeasonWeekScore {
  week: number;
  correctPicks: number;
}

export interface SeasonPlayerTotals {
  user: Pick<User, "id" | "username">;
  rank: number;
  /** Correct picks across final, in-progress, and incomplete weeks. */
  correctPicks: number;
  /** Picks whose game is on the board and final; the accuracy denominator. */
  decidedPicks: number;
  accuracy: number | null;
  weeklyWins: number;
  weeksPlayed: number;
  /** Final weeks only. */
  bestWeek: SeasonWeekScore | null;
  worstWeek: SeasonWeekScore | null;
  averageCorrect: number | null;
  /** Whole cents: fees for every started week, pot shares won, and their difference. */
  feesPaidCents: number;
  winningsCents: number;
  netCents: number;
}

/** Weekly entry fee charged when an administrator has not configured a week. */
export const DEFAULT_ENTRY_FEE_CENTS = 500;

export interface SeasonEntryFees {
  season: number;
  defaultFeeCents: number;
  /** Weeks 1–18; `configured` is false when the default applies. */
  weeks: { week: number; feeCents: number; configured: boolean }[];
}

export type PaymentDirection = "in" | "out";
export type PaymentSource =
  "manual" | "venmo_email" | "venmo_csv" | "carryover";
/** Only approved entries count toward a balance. */
export type PaymentStatus = "pending" | "approved" | "ignored" | "voided";

/**
 * One movement of money between the banker and a player. Amounts are never
 * edited: imported entries move through review, and a mistake is voided.
 */
export interface PaymentEntry {
  id: number;
  season: number;
  /** Null until a pending entry is matched to a player. */
  userId: number | null;
  /** `in` is paid to the banker, `out` is paid by the banker. */
  direction: PaymentDirection;
  /** Whole cents, always positive. */
  amountCents: number;
  source: PaymentSource;
  status: PaymentStatus;
  note: string | null;
  /** Counterparty display name and transaction ID as Venmo reported them. */
  venmoName: string | null;
  venmoTransactionId: string | null;
  paidAt: string;
  createdAt: string;
  voidedAt: string | null;
}

/** How Venmo identifies one player. */
export interface VenmoAccount {
  userId: number;
  /** Without the leading `@`; only used to build request/pay links. */
  username: string | null;
  /** Names matched case-insensitively against imported payments; unique across players. */
  displayNames: string[];
}

export type VenmoAccountInput = Omit<VenmoAccount, "userId">;

/** Outcome of one Venmo statement import. */
export interface VenmoImportResult {
  /** New entries, split by how the classifier filed them. */
  approved: number;
  pending: number;
  /** Rows whose transaction ID is already in the ledger. */
  duplicates: number;
  /** Rows that are not completed person-to-person payments. */
  skipped: number;
}

export interface VenmoImportResponse {
  data: PaymentsData;
  result: VenmoImportResult;
}

export interface PaymentApprovalInput {
  userId: number;
  season: number;
}

export interface PaymentPlayerBalance {
  user: Pick<User, "id" | "username">;
  /** The banker's own row: counted in the pot but never owing or owed. */
  banker: boolean;
  /** Whole cents. Fees and winnings match the season table. */
  feesCents: number;
  winningsCents: number;
  paidInCents: number;
  paidOutCents: number;
  /**
   * paidIn - fees + winnings - paidOut. Negative means the player owes the
   * banker; positive means the banker owes the player. Always 0 for the banker.
   */
  balanceCents: number;
}

export interface PaymentPoolSummary {
  /** Approved entries in each direction. */
  collectedCents: number;
  paidOutCents: number;
  /** Sums of negative and positive player balances, both reported positive. */
  owedToBankerCents: number;
  owedByBankerCents: number;
  /** Pots with no winner plus split remainders; the banker holds these. */
  unawardedCents: number;
}

export interface PaymentsData {
  season: number;
  bankerUserId: number | null;
  /** Every user with a submission or a ledger entry this season, by username. */
  players: PaymentPlayerBalance[];
  /** Newest first; includes voided entries. */
  entries: PaymentEntry[];
  /** Every user, for assigning entries and choosing the banker. */
  users: Pick<User, "id" | "username">[];
  summary: PaymentPoolSummary;
  /** Only players with a username or at least one display name. */
  venmoAccounts: VenmoAccount[];
  /**
   * Lowercase note fragments. An imported payment is approved automatically
   * when its note contains one and its Venmo name belongs to a player.
   */
  keywords: string[];
}

export interface ManualPaymentInput {
  season: number;
  userId: number;
  direction: PaymentDirection;
  amountCents: number;
  /** ISO 8601 timestamp. */
  paidAt: string;
  note: string | null;
}

export interface SeasonData {
  season: number;
  phase: "upcoming" | "in_progress" | "complete";
  inProgressWeek: number | null;
  /** Ascending; only weeks with submissions. */
  weeks: SeasonWeekSummary[];
  /** Ranked; every user with a submission this season. */
  players: SeasonPlayerTotals[];
  checkedAt: string;
}

export const JOB_TYPES = [
  "deliver_submission_links",
  "deliver_standings",
  "deliver_hashes",
  "schedule_hash_delivery",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface JobParams {
  type: JobType;
  season: number;
  week: number | null;
  runId: string;
  weekOffset?: 0 | 1;
  notBefore?: string;
  legacyJobId?: string;
}

export interface JobRun {
  id: string;
  type: JobType;
  season: number;
  week: number | null;
  status: string;
  plannedAt: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  source: "manual" | "scheduled";
  params: JobParams;
  startedAt: string | null;
  finishedAt: string | null;
  parentId: string | null;
}

export interface JobsData {
  runs: JobRun[];
  paused: boolean;
  schedules: Array<{ type: JobType; cron: string }>;
  hasMore: boolean;
}

export interface SessionData {
  user: User | null;
  csrfToken: string | null;
}

export interface ApiError {
  error: string;
  fields?: Record<string, string>;
  runs?: JobRun[];
  run?: JobRun;
  failedId?: string;
}
