import type { Picks, WeekData } from "../shared/contracts";

const prefix = "corn-town:draft:v1:";

export interface DraftEdits {
  picks: Picks;
  tiebreaker: string;
}

interface StoredDraft extends DraftEdits {
  version: 1;
  baseline: string;
  expiresAt: number;
}

export type DraftSave =
  | { status: "saved"; expiresAt: number }
  | { status: "empty" | "unavailable"; expiresAt: null };

function draftKey(userId: number, data: WeekData) {
  return `${prefix}${userId}:${data.scoreboard.season}:${data.scoreboard.week}`;
}

export function submissionRevision(data: WeekData) {
  const submission = data.submission;
  if (!submission) {
    return "none";
  }
  return JSON.stringify([
    submission.id,
    submission.updatedAt,
    submission.tiebreaker,
    Object.entries(submission.picks).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function eligibleGames(data: WeekData, now: number) {
  return data.scoreboard.games.filter(
    (game) => game.status === "STATUS_SCHEDULED" && Date.parse(game.date) > now,
  );
}

function nextBoundary(data: WeekData, now: number) {
  const eligible = eligibleGames(data, now);
  const locked =
    data.locked || eligible.length !== data.scoreboard.games.length;
  if (eligible.length === 0 || (data.submission && locked)) {
    return now;
  }
  return Math.min(...eligible.map((game) => Date.parse(game.date)));
}

function filterChoices(
  picks: Record<string, unknown>,
  data: WeekData,
  now: number,
) {
  const filtered: Picks = {};
  for (const game of eligibleGames(data, now)) {
    const team = picks[game.id];
    if (team === game.homeTeam.id || team === game.awayTeam.id) {
      filtered[game.id] = team;
    }
  }
  return filtered;
}

function hasDraftEdits(draft: Record<string, unknown>) {
  return (
    typeof draft.tiebreaker === "string" &&
    typeof draft.picks === "object" &&
    draft.picks !== null &&
    !Array.isArray(draft.picks)
  );
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return (
    draft.version === 1 &&
    typeof draft.baseline === "string" &&
    typeof draft.expiresAt === "number" &&
    Number.isFinite(draft.expiresAt) &&
    hasDraftEdits(draft)
  );
}

export function clearDraft(userId: number, data: WeekData): void {
  try {
    localStorage.removeItem(draftKey(userId, data));
  } catch {
    // Picking remains available when this device blocks storage.
  }
}

export function loadDraft(
  userId: number,
  data: WeekData,
  now: number,
): StoredDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(userId, data));
    if (!raw) {
      return null;
    }
    const draft: unknown = JSON.parse(raw);
    if (!isStoredDraft(draft)) {
      clearDraft(userId, data);
      return null;
    }
    if (
      draft.baseline !== submissionRevision(data) ||
      draft.expiresAt <= now ||
      draft.expiresAt > nextBoundary(data, now)
    ) {
      clearDraft(userId, data);
      return null;
    }
    const filtered = { ...draft, picks: filterChoices(draft.picks, data, now) };
    if (matchesSubmission(filtered, data, now)) {
      clearDraft(userId, data);
      return null;
    }
    return filtered;
  } catch {
    clearDraft(userId, data);
    return null;
  }
}

function matchesSubmission(edits: DraftEdits, data: WeekData, now: number) {
  const baseline = filterChoices(data.submission?.picks ?? {}, data, now);
  if (
    edits.tiebreaker !==
    (data.submission ? String(data.submission.tiebreaker) : "")
  ) {
    return false;
  }
  return (
    Object.keys(edits.picks).length === Object.keys(baseline).length &&
    Object.entries(edits.picks).every(([game, team]) => baseline[game] === team)
  );
}

export function saveDraft(
  userId: number,
  data: WeekData,
  edits: DraftEdits,
  now: number,
): DraftSave {
  const expiresAt = nextBoundary(data, now);
  const filtered = { ...edits, picks: filterChoices(edits.picks, data, now) };
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    matchesSubmission(filtered, data, now)
  ) {
    clearDraft(userId, data);
    return { status: "empty", expiresAt: null };
  }
  try {
    const draft: StoredDraft = {
      ...filtered,
      version: 1,
      baseline: submissionRevision(data),
      expiresAt,
    };
    localStorage.setItem(draftKey(userId, data), JSON.stringify(draft));
    return { status: "saved", expiresAt };
  } catch {
    clearDraft(userId, data);
    return { status: "unavailable", expiresAt: null };
  }
}

export function clearDraftsForUser(userId: number): void {
  try {
    const userPrefix = `${prefix}${userId}:`;
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(userPrefix)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Sign-out must succeed even when storage is inaccessible.
  }
}

function storedExpiry(key: string): number {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return isStoredDraft(value) ? value.expiresAt : 0;
  } catch {
    return 0;
  }
}

export function clearExpiredDrafts(): void {
  try {
    const now = Date.now();
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix) && storedExpiry(key) <= now) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Expired drafts are also rejected on read if storage is blocked here.
  }
}
