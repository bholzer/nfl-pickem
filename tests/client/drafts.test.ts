import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDraftsForUser,
  clearExpiredDrafts,
  loadDraft,
  saveDraft,
} from "../../src/client/drafts";
import type { WeekData } from "../../src/shared/contracts";
import { scoreboardFixture, submissionFixture } from "../fixtures/espn";

const kickoff = Date.parse("2026-09-10T23:00:00Z");
const later = kickoff + 3 * 86400_000;
const week: WeekData = {
  scoreboard: scoreboardFixture([
    { id: "401", date: new Date(kickoff).toISOString() },
    { id: "402", date: new Date(later).toISOString() },
  ]),
  submission: null,
  locked: false,
  earliestGameTime: new Date(kickoff).toISOString(),
};
const edits = {
  picks: { "401": "home-401", "402": "away-402" },
  tiebreaker: "42",
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

it("keeps drafts isolated by person and period and clears only the signed-out person's drafts", () => {
  const nextWeek = { ...week, scoreboard: { ...week.scoreboard, week: 2 } };
  const nextSeason = {
    ...week,
    scoreboard: { ...week.scoreboard, season: 2027 },
  };
  saveDraft(1, week, edits, kickoff - 1);
  expect(loadDraft(2, week, kickoff - 1)).toBeNull();
  expect(loadDraft(1, nextWeek, kickoff - 1)).toBeNull();
  expect(loadDraft(1, nextSeason, kickoff - 1)).toBeNull();
  saveDraft(1, nextWeek, edits, kickoff - 1);
  saveDraft(2, week, { ...edits, tiebreaker: "37" }, kickoff - 1);
  localStorage.setItem("theme", "dark");
  clearDraftsForUser(1);
  expect(loadDraft(1, week, kickoff - 1)).toBeNull();
  expect(loadDraft(1, nextWeek, kickoff - 1)).toBeNull();
  expect(loadDraft(2, week, kickoff - 1)?.tiebreaker).toBe("37");
  expect(localStorage.getItem("theme")).toBe("dark");
});

it("does not restore edits over a newer server submission even when timestamps match", () => {
  const saved = { ...week, submission: submissionFixture() };
  saveDraft(1, saved, edits, kickoff - 1);
  expect(loadDraft(1, saved, kickoff - 1)?.picks).toEqual(edits.picks);
  const newer = {
    ...saved,
    submission: { ...saved.submission, tiebreaker: 38 },
  };
  expect(loadDraft(1, newer, kickoff - 1)).toBeNull();
  expect(loadDraft(1, saved, kickoff - 1)).toBeNull();
});

it("expires at kickoff but lets a late first submission recover only valid remaining choices", () => {
  saveDraft(1, week, edits, kickoff - 1);
  expect(loadDraft(1, week, kickoff)).toBeNull();
  saveDraft(
    1,
    week,
    { ...edits, picks: { ...edits.picks, unknown: "home-unknown" } },
    kickoff,
  );
  expect(loadDraft(1, week, later - 1)?.picks).toEqual({ "402": "away-402" });
  expect(loadDraft(1, week, later)).toBeNull();
  const saved = { ...week, submission: submissionFixture() };
  saveDraft(1, saved, edits, kickoff - 1);
  expect(loadDraft(1, { ...saved, locked: true }, kickoff - 1)).toBeNull();
});

it("removes expired private data during maintenance without touching preferences or live drafts", () => {
  vi.spyOn(Date, "now").mockReturnValue(kickoff);
  saveDraft(1, week, edits, kickoff - 1);
  const expiredKey = localStorage.key(0);
  expect(expiredKey).not.toBeNull();
  saveDraft(2, week, edits, kickoff);
  localStorage.setItem("theme", "light");
  clearExpiredDrafts();
  expect(localStorage.getItem(expiredKey ?? "")).toBeNull();
  expect(loadDraft(2, week, kickoff)?.picks).toEqual({ "402": "away-402" });
  expect(localStorage.getItem("theme")).toBe("light");
});

it("reports a failed write and never resurrects the older saved choices", () => {
  saveDraft(1, week, edits, kickoff - 1);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage quota exceeded", "QuotaExceededError");
  });
  expect(
    saveDraft(1, week, { ...edits, tiebreaker: "38" }, kickoff - 1).status,
  ).toBe("unavailable");
  expect(loadDraft(1, week, kickoff - 1)).toBeNull();
});

it("discards a draft when no games accept picks even before its recorded expiry", () => {
  saveDraft(1, week, edits, kickoff - 1);
  const closed = {
    ...week,
    scoreboard: {
      ...week.scoreboard,
      games: week.scoreboard.games.map((game) => ({
        ...game,
        status: "STATUS_POSTPONED",
      })),
    },
  };
  expect(loadDraft(1, closed, kickoff - 1)).toBeNull();
});
