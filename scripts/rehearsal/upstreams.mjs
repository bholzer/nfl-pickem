import { Response } from "miniflare";
import { seasonForDate } from "../../src/shared/season.ts";

export const members = {
  player: {
    id: 101,
    discordId: "900000000000000101",
    username: "Rehearsal Player",
    admin: false,
  },
  rival: {
    id: 102,
    discordId: "900000000000000102",
    username: "Rehearsal Rival",
    admin: false,
  },
  admin: {
    id: 103,
    discordId: "900000000000000103",
    username: "Rehearsal Admin",
    admin: true,
  },
};

const logo =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#2563eb"/></svg>',
  );

/**
 * @param {number} season
 * @param {number} week
 * @param {number} slot
 * @param {string} date
 * @param {boolean} completed
 */
function game(season, week, slot, date, completed) {
  const home = {
    id: `home-${slot}`,
    homeAway: "home",
    score: completed ? "24" : "0",
    winner: completed,
    team: {
      displayName: `Synthetic Bears ${slot}`,
      abbreviation: `B${slot}`,
      logo,
    },
  };
  const away = {
    id: `away-${slot}`,
    homeAway: "away",
    score: completed ? "17" : "0",
    winner: false,
    team: {
      displayName: `Synthetic Hawks ${slot}`,
      abbreviation: `H${slot}`,
      logo,
    },
  };
  const type = {
    name: completed ? "STATUS_FINAL" : "STATUS_SCHEDULED",
    completed,
    detail: completed ? "Final" : "Upcoming fixture",
  };
  return {
    id: `event-${season}-${week}-${slot}`,
    name: `Synthetic Hawks ${slot} at Synthetic Bears ${slot}`,
    date,
    status: { type },
    competitions: [
      {
        id: `rehearsal-${season}-${week}-${slot}`,
        status: { type },
        competitors: [away, home],
      },
    ],
  };
}

/** @param {import("miniflare").Request} request @param {URL} url */
async function oauthResponse(request, url) {
  if (url.origin !== "https://discord.com") {
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v10/oauth2/token") {
    const params = new URLSearchParams(await request.text());
    if (params.get("code") === "rehearsal-oauth-code") {
      return Response.json({
        access_token: "rehearsal-access-token",
        token_type: "Bearer",
        scope: "identify",
      });
    }
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/v10/users/@me" &&
    request.headers.get("Authorization") === "Bearer rehearsal-access-token"
  ) {
    return Response.json({ id: members.player.discordId });
  }
}

/** @param {number} season @param {number} week */
function historicalDates(season, week) {
  const thursday = new Date(Date.UTC(season, 8, 1, 23));
  thursday.setUTCDate(
    1 + ((4 - thursday.getUTCDay() + 7) % 7) + (week - 1) * 7,
  );
  return [
    thursday.toISOString(),
    new Date(thursday.getTime() + 4 * 86400_000).toISOString(),
  ];
}

/** @param {Date} now */
function rehearsalBoards(now) {
  const season = seasonForDate(now);
  const historicalSeason = season - 1;
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() + 14 + ((8 - monday.getUTCDay()) % 7));
  monday.setUTCHours(23, 0, 0, 0);
  const boards = new Map(
    [season, historicalSeason].flatMap((year) =>
      Array.from({ length: 18 }, (_, index) => {
        const week = index + 1;
        const completed = year === historicalSeason || week === 1;
        const currentMonday = new Date(
          monday.getTime() + (week === 1 ? -28 : (week - 2) * 7) * 86400_000,
        );
        const dates =
          year === historicalSeason
            ? historicalDates(year, week)
            : [
                new Date(currentMonday.getTime() - 4 * 86400_000).toISOString(),
                currentMonday.toISOString(),
              ];
        return [
          `${year}-${week}`,
          {
            season: { year, type: 2 },
            week: { number: week },
            events: dates.map((date, i) =>
              game(year, week, i + 1, date, completed),
            ),
          },
        ];
      }),
    ),
  );
  return { season, historicalSeason, boards };
}

/** @param {URLSearchParams} query @param {string} name @param {number} fallback */
function queryNumber(query, name, fallback) {
  const raw = query.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return String(value) === raw ? value : Number.NaN;
}

/** Only upstream transport is substituted. No application /api response is mocked. */
export function createUpstreams(now = new Date()) {
  const { season, historicalSeason, boards } = rehearsalBoards(now);
  /** @type {string[]} */
  const requests = [];
  /** @type {string[]} */
  const forbidden = [];
  /** @param {import("miniflare").Request} request */
  async function outbound(request) {
    const url = new URL(request.url);
    const description = `${request.method} ${url.origin}${url.pathname}`;
    requests.push(description);
    if (
      request.method === "GET" &&
      url.origin === "https://site.web.api.espn.com" &&
      url.pathname === "/apis/site/v2/sports/football/nfl/scoreboard"
    ) {
      const year = queryNumber(url.searchParams, "dates", season);
      const week = queryNumber(
        url.searchParams,
        "week",
        year === season ? 2 : 18,
      );
      const seasonType = queryNumber(url.searchParams, "seasontype", 2);
      const board = boards.get(`${year}-${week}`);
      if (board && seasonType === 2) {
        return Response.json(board);
      }
    }
    // Synthetic OAuth transport is available for local callback experiments; the
    // harness deliberately leaves the sign-in client ID empty to prevent a browser
    // redirect to Discord. No bot/message operation is ever allowed through.
    const oauth = await oauthResponse(request, url);
    if (oauth) {
      return oauth;
    }
    forbidden.push(description);
    return Response.json(
      { error: "External transport blocked by local rehearsal" },
      { status: 502 },
    );
  }
  return { season, historicalSeason, outbound, requests, forbidden };
}
