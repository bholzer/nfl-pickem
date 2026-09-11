import { expect, it } from "vitest";
import {
  centralCalendar,
  completedGroups,
} from "../../src/server/services/groups";
import { scoreboardFixture } from "../fixtures/espn";

it("uses Central day rather than UTC day on Thursday evening and Monday midnight boundaries", () => {
  const board = scoreboardFixture([
    { id: "1", date: "2026-09-11T01:00:00Z", status: "STATUS_FINAL" },
    { id: "2", date: "2026-09-14T04:59:00Z", status: "STATUS_FINAL" },
    { id: "3", date: "2026-09-14T05:00:00Z", status: "STATUS_IN_PROGRESS" },
  ]);
  expect(completedGroups(board)).toEqual(["sunday_night", "thursday"]);
  expect(centralCalendar("2026-09-14T04:59:00Z")).toEqual({
    day: "Sun",
    hour: 23,
  });
  expect(centralCalendar("2026-09-14T05:00:00Z")).toEqual({
    day: "Mon",
    hour: 0,
  });
});

it("uses daylight-saving offsets on both sides of the fall transition", () => {
  expect(centralCalendar("2026-11-01T06:30:00Z")).toEqual({
    day: "Sun",
    hour: 1,
  });
  expect(centralCalendar("2026-11-01T07:30:00Z")).toEqual({
    day: "Sun",
    hour: 1,
  });
  expect(centralCalendar("2026-11-02T05:59:00Z")).toEqual({
    day: "Sun",
    hour: 23,
  });
  expect(centralCalendar("2026-11-02T06:00:00Z")).toEqual({
    day: "Mon",
    hour: 0,
  });
});

it("preserves the entire Sunday 17 hour overlap and excludes empty groups", () => {
  expect(
    completedGroups(
      scoreboardFixture([
        { date: "2026-09-13T22:59:00Z", status: "STATUS_FINAL" },
      ]),
    ),
  ).toEqual(["sunday_late", "sunday_night"]);
  const board = scoreboardFixture([
    { id: "1", date: "2026-09-13T18:59:00Z", status: "STATUS_FINAL" },
    { id: "2", date: "2026-09-13T19:00:00Z", status: "STATUS_FINAL" },
    { id: "3", date: "2026-09-13T22:00:00Z", status: "STATUS_IN_PROGRESS" },
  ]);
  expect(completedGroups(board)).toEqual(["sunday_early"]);
  expect(completedGroups({ season: 2026, week: 1, games: [] })).toEqual([]);
});

it("does not mark a broadcast group complete while any game remains live", () => {
  const board = scoreboardFixture([
    { id: "1", date: "2026-09-14T23:00:00Z", status: "STATUS_FINAL" },
    { id: "2", date: "2026-09-15T02:00:00Z", status: "STATUS_IN_PROGRESS" },
  ]);
  expect(completedGroups(board)).toEqual([]);
});
