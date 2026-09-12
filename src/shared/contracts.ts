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
