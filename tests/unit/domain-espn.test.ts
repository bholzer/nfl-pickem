import assert from "node:assert/strict";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EspnError,
  fetchScoreboard,
  getCurrentPeriod,
  normalizeScoreboard,
} from "../../src/server/services/espn";
import { espnEvent, espnScoreboard } from "../fixtures/espn";
import { network } from "../setup-network";

const endpoint =
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const fallbackEndpoint =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses ESPN's season year for January games rather than the calendar year", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-10T12:00:00Z"));
  network.use(
    http.get(endpoint, ({ request }) => {
      const url = new URL(request.url);
      if (!url.search) {
        return HttpResponse.json({
          season: { year: 2026, type: 2 },
          week: { number: 18 },
        });
      }
      if (
        url.searchParams.get("dates") === "2026" &&
        url.searchParams.get("week") === "18" &&
        url.searchParams.get("seasontype") === "2"
      ) {
        return HttpResponse.json(
          espnScoreboard(
            [espnEvent({ date: "2027-01-10T18:00:00Z" })],
            18,
            2026,
          ),
        );
      }
      return new HttpResponse(null, { status: 400 });
    }),
  );
  expect(await fetchScoreboard()).toMatchObject({
    season: 2026,
    week: 18,
    games: [{ date: "2027-01-10T18:00:00.000Z" }],
  });
});

it("loads an explicit historical period without depending on current-season discovery", async () => {
  network.use(
    http.get(endpoint, ({ request }) => {
      const url = new URL(request.url);
      if (
        url.searchParams.get("dates") === "2025" &&
        url.searchParams.get("week") === "3"
      ) {
        return HttpResponse.json(
          espnScoreboard([espnEvent({ id: "historical-game" })], 3, 2025),
        );
      }
      return new HttpResponse(null, { status: 503 });
    }),
  );
  expect(await fetchScoreboard({ season: 2025, week: 3 })).toMatchObject({
    season: 2025,
    week: 3,
    games: [{ id: "historical-game" }],
  });
});

it("falls back after a 403 for both season discovery and the selected week", async () => {
  const queries: string[] = [];
  network.use(
    http.get(endpoint, () => new HttpResponse("Forbidden", { status: 403 })),
    http.get(fallbackEndpoint, ({ request }) => {
      const url = new URL(request.url);
      queries.push(url.search);
      return HttpResponse.json(espnScoreboard([espnEvent()], 6, 2026));
    }),
  );
  expect(await fetchScoreboard()).toMatchObject({
    season: 2026,
    week: 6,
    games: [{ id: "401" }],
  });
  expect(queries).toEqual(["", "?dates=2026&seasontype=2&week=6"]);
});

it("preserves an explicit historical period on the fallback host", async () => {
  const queries: string[] = [];
  network.use(
    http.get(endpoint, () => new HttpResponse(null, { status: 403 })),
    http.get(fallbackEndpoint, ({ request }) => {
      queries.push(new URL(request.url).search);
      return HttpResponse.json(espnScoreboard([espnEvent()], 3, 2025));
    }),
  );
  expect(await fetchScoreboard({ season: 2025, week: 3 })).toMatchObject({
    season: 2025,
    week: 3,
  });
  expect(queries).toEqual(["?dates=2025&seasontype=2&week=3"]);
});

it("does not use the fallback when the primary host succeeds", async () => {
  const fallback = vi.fn(() => HttpResponse.json(espnScoreboard()));
  network.use(
    http.get(endpoint, () => HttpResponse.json(espnScoreboard())),
    http.get(fallbackEndpoint, fallback),
  );
  await fetchScoreboard({ season: 2026, week: 1 });
  expect(fallback).not.toHaveBeenCalled();
});

it.each([
  { label: "season", season: 2025, week: 6 },
  { label: "week", season: 2026, week: 5 },
])("rejects fallback data for the wrong $label", async ({ season, week }) => {
  network.use(
    http.get(endpoint, () => new HttpResponse(null, { status: 403 })),
    http.get(fallbackEndpoint, () =>
      HttpResponse.json(espnScoreboard([espnEvent()], week, season)),
    ),
  );
  await expect(fetchScoreboard({ season: 2026, week: 6 })).rejects.toThrow(
    "different season or week",
  );
});

it("fails closed without looping when both hosts return 403", async () => {
  const fallback = vi.fn(() => new HttpResponse(null, { status: 403 }));
  network.use(
    http.get(endpoint, () => new HttpResponse(null, { status: 403 })),
    http.get(fallbackEndpoint, fallback),
  );
  await expect(fetchScoreboard({ season: 2026, week: 6 })).rejects.toThrow(
    "403",
  );
  expect(fallback).toHaveBeenCalledOnce();
});

it("normalizes event competition IDs, final ties and zero scores without inventing winners", () => {
  const board = normalizeScoreboard(
    espnScoreboard([
      espnEvent({
        id: "10",
        status: "STATUS_FINAL",
        homeScore: 0,
        awayScore: 0,
      }),
    ]),
  );
  expect(board.games[0]).toMatchObject({
    id: "10",
    date: "2026-09-13T17:00:00.000Z",
    winnerId: null,
    homeTeam: { score: 0 },
    awayTeam: { score: 0 },
  });
});

it("reads the latest moneylines rather than opening quotes or spread odds", () => {
  const event = espnEvent({ neutralSite: true });
  const board = normalizeScoreboard(
    espnScoreboard([
      {
        ...event,
        competitions: event.competitions.map((competition) => ({
          ...competition,
          odds: [
            null,
            {
              provider: { name: "DraftKings" },
              moneyline: {
                home: { close: { odds: "-135" }, open: { odds: "-155" } },
                away: { close: { odds: "+114" }, open: { odds: "+130" } },
              },
              pointSpread: { home: { close: { odds: "-110" } } },
            },
          ],
        })),
      },
    ]),
  );
  expect(board.games[0]?.moneyline).toEqual({
    home: -135,
    away: 114,
    provider: "DraftKings",
  });
});

it("keeps partial moneylines with their provider without filling from another market", () => {
  const event = espnEvent();
  const board = normalizeScoreboard(
    espnScoreboard([
      {
        ...event,
        competitions: event.competitions.map((competition) => ({
          ...competition,
          odds: [
            {
              provider: { name: "First book" },
              moneyline: {
                home: { close: { odds: "OFF" }, open: { odds: "-120" } },
                away: { close: { odds: "+100" } },
              },
            },
            {
              provider: { name: "Second book" },
              moneyline: {
                home: { close: { odds: "-200" } },
                away: { close: { odds: "+160" } },
              },
            },
          ],
        })),
      },
    ]),
  );
  expect(board.games[0]?.moneyline).toEqual({
    home: null,
    away: 100,
    provider: "First book",
  });
});

it.each([
  { name: "absent", odds: undefined },
  { name: "malformed", odds: { moneyline: [] } },
  {
    name: "opening-only",
    odds: [{ moneyline: { home: { open: { odds: "-150" } } } }],
  },
  {
    name: "invalid American odds",
    odds: [
      {
        moneyline: {
          home: { close: { odds: "0" } },
          away: { close: { odds: "-110.5" } },
        },
      },
      {
        moneyline: {
          home: { close: { odds: "9007199254740992" } },
          away: { close: { odds: "+99" } },
        },
      },
    ],
  },
])("keeps games usable when optional moneylines are $name", ({ odds }) => {
  const event = espnEvent();
  const board = normalizeScoreboard(
    espnScoreboard([
      {
        ...event,
        competitions: event.competitions.map((competition) => ({
          ...competition,
          odds,
        })),
      },
    ]),
  );
  expect(board.games[0]).toMatchObject({
    id: "401",
    status: "STATUS_SCHEDULED",
    homeTeam: { id: "home-401" },
    awayTeam: { id: "away-401" },
    moneyline: null,
  });
});

const invalidBoards: Array<[string, () => unknown]> = [
  ["missing season", () => ({ week: { number: 1 }, events: [espnEvent()] })],
  [
    "missing events",
    () => ({ season: { year: 2026, type: 2 }, week: { number: 1 } }),
  ],
  ["empty week", () => espnScoreboard([])],
  [
    "event from a different season",
    () => {
      const event = { ...espnEvent(), season: { year: 2025, type: 2 } };
      return espnScoreboard([event]);
    },
  ],
  [
    "event from a different week",
    () => {
      const event = { ...espnEvent(), week: { number: 2 } };
      return espnScoreboard([event]);
    },
  ],
  [
    "non-regular-season games",
    () => ({ ...espnScoreboard(), season: { year: 2026, type: 3 } }),
  ],
  [
    "missing competition",
    () => ({
      season: { year: 2026, type: 2 },
      week: { number: 1 },
      events: [{ ...espnEvent(), competitions: [] }],
    }),
  ],
  [
    "duplicate competition IDs",
    () => espnScoreboard([espnEvent(), espnEvent()]),
  ],
  [
    "ambiguous timezone",
    () => espnScoreboard([espnEvent({ date: "2026-09-13T12:00:00" })]),
  ],
  [
    "invalid timestamp",
    () => espnScoreboard([espnEvent({ date: "not-a-dateZ" })]),
  ],
  [
    "impossible calendar date",
    () => espnScoreboard([espnEvent({ date: "2026-02-30T12:00:00Z" })]),
  ],
  [
    "missing final score",
    () =>
      espnScoreboard([espnEvent({ status: "STATUS_FINAL", homeScore: null })]),
  ],
  [
    "incomplete matchup",
    () => {
      const event = espnEvent();
      const competition = event.competitions[0];
      assert(competition);
      competition.competitors.pop();
      return espnScoreboard([event]);
    },
  ],
  [
    "malformed score",
    () => {
      const event = espnEvent();
      const home = event.competitions[0]?.competitors[0];
      assert(home);
      home.score = "7pts";
      return espnScoreboard([event]);
    },
  ],
  [
    "inconsistent completed status",
    () => {
      const event = espnEvent();
      const competition = event.competitions[0];
      assert(competition);
      competition.status.type.completed = true;
      return espnScoreboard([event]);
    },
  ],
  [
    "inconsistent winner",
    () => {
      const event = espnEvent({ status: "STATUS_FINAL" });
      const home = event.competitions[0]?.competitors[0];
      assert(home);
      home.winner = false;
      return espnScoreboard([event]);
    },
  ],
  [
    "non-boolean neutral-site flag",
    () => {
      const event = espnEvent();
      return {
        ...espnScoreboard(),
        events: [
          {
            ...event,
            competitions: event.competitions.map((competition) => ({
              ...competition,
              neutralSite: "true",
            })),
          },
        ],
      };
    },
  ],
];

describe("invalid upstream boards never become editable empty weeks", () => {
  it.each(invalidBoards)("rejects %s", async (_name, build) => {
    network.use(
      http.get(endpoint, () =>
        HttpResponse.json(build() as Record<string, unknown>),
      ),
    );
    await expect(
      fetchScoreboard({ season: 2026, week: 1 }),
    ).rejects.toBeInstanceOf(EspnError);
  });
});

it("rejects a mismatched week rather than saving picks to the wrong week", async () => {
  network.use(
    http.get(endpoint, () =>
      HttpResponse.json(espnScoreboard([espnEvent()], 2)),
    ),
  );
  await expect(
    fetchScoreboard({ season: 2026, week: 1 }),
  ).rejects.toBeInstanceOf(EspnError);
});

it("rejects a different season even when the requested week matches", async () => {
  network.use(
    http.get(endpoint, () =>
      HttpResponse.json(espnScoreboard([espnEvent()], 1, 2025)),
    ),
  );
  await expect(
    fetchScoreboard({ season: 2026, week: 1 }),
  ).rejects.toBeInstanceOf(EspnError);
});

it.each([
  { phase: 1, upstreamWeek: 4, regularWeek: 1 },
  { phase: 3, upstreamWeek: 1, regularWeek: 18 },
  { phase: 4, upstreamWeek: undefined, regularWeek: 18 },
])(
  "does not confuse phase $phase with a regular-season week",
  async ({ phase, upstreamWeek, regularWeek }) => {
    network.use(
      http.get(endpoint, ({ request }) => {
        const url = new URL(request.url);
        if (!url.search) {
          return HttpResponse.json({
            season: { year: 2026, type: phase },
            week:
              upstreamWeek === undefined ? undefined : { number: upstreamWeek },
          });
        }
        return HttpResponse.json(
          espnScoreboard(
            [espnEvent()],
            Number(url.searchParams.get("week")),
            2026,
          ),
        );
      }),
    );
    expect(await getCurrentPeriod()).toBeNull();
    expect(await fetchScoreboard()).toMatchObject({
      season: 2026,
      week: regularWeek,
    });
  },
);

it("reports upstream HTTP and JSON failures rather than substituting games", async () => {
  network.use(
    http.get(endpoint, () => new HttpResponse(null, { status: 503 })),
  );
  await expect(fetchScoreboard({ season: 2026, week: 1 })).rejects.toThrow(
    "503",
  );
  network.use(
    http.get(
      endpoint,
      () =>
        new HttpResponse("not json", {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  await expect(
    fetchScoreboard({ season: 2026, week: 1 }),
  ).rejects.toBeInstanceOf(EspnError);
});

it("rejects invalid current-week metadata", async () => {
  network.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        season: { year: 2026, type: 2 },
        week: { number: 0 },
      }),
    ),
  );
  await expect(getCurrentPeriod()).rejects.toBeInstanceOf(EspnError);
});

it("aborts a stalled request at its deadline instead of leaving callers waiting", async () => {
  vi.useFakeTimers();
  let aborted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: URL, options: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      assert(options.signal);
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
      return promise;
    }),
  );
  const pending = expect(
    fetchScoreboard({ season: 2026, week: 1 }),
  ).rejects.toBeInstanceOf(EspnError);
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  expect(aborted).toBe(true);
});

it("keeps the fallback within the original ten-second request deadline", async () => {
  vi.useFakeTimers();
  let fallbackAborted = false;
  const fetchMock = vi.fn((url: URL, options: RequestInit) => {
    if (url.hostname === "site.web.api.espn.com") {
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(new Response(null, { status: 403 }));
        }, 9_000);
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      assert(options.signal);
      options.signal.addEventListener("abort", () => {
        fallbackAborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const pending = expect(
    fetchScoreboard({ season: 2026, week: 6 }),
  ).rejects.toBeInstanceOf(EspnError);
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fallbackAborted).toBe(true);
});
