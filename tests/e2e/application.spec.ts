import assert from "node:assert/strict";
import type { Locator, Page } from "@playwright/test";
import type {
  JobRun,
  PaymentsData,
  SessionData,
  StandingsData,
} from "../../src/shared/contracts";
import { test, expect } from "./fixtures";

// These requests use the same real browser session and native assets router as
// navigation. There is no route.fulfill(), test API endpoint, or Hono test app.
test("signed link saves real picks, history and public standings across deep links", async ({
  page,
  rehearsal,
}, testInfo) => {
  await page.goto(rehearsal.links.player);
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/submissions/new" &&
      url.searchParams.get("season") === String(rehearsal.season) &&
      url.searchParams.get("week") === "2",
  );
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("token")).toBe(false);
  const session = await page.request.get("/api/session", { maxRedirects: 0 });
  expect(await session.json()).toMatchObject({
    user: { username: "Rehearsal Player", admin: false },
  });

  await page
    .getByRole("radio", {
      name: "Synthetic Bears 1 for Synthetic Hawks 1 at Synthetic Bears 1",
      exact: true,
    })
    .check();
  await page
    .getByRole("radio", {
      name: "Synthetic Bears 2 for Synthetic Hawks 2 at Synthetic Bears 2",
      exact: true,
    })
    .check();
  await page.getByLabel("Monday night tiebreaker", { exact: true }).fill("42");
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/submissions/2" &&
      new URL(response.url()).searchParams.get("season") ===
        String(rehearsal.season) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Submit picks", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Your picks", exact: true }),
  ).toBeVisible();
  await expect(page.locator("code")).toHaveText(/^[a-f0-9]{64}$/);
  const stored = await rehearsal.db
    .prepare(
      "SELECT picks,tiebreaker FROM submissions WHERE user_id=101 AND season=? AND week=2",
    )
    .bind(rehearsal.season)
    .first<{ picks: string; tiebreaker: number }>();
  assert(stored, "Saved picks must exist in native D1");
  expect(JSON.parse(stored.picks)).toEqual({
    [`rehearsal-${rehearsal.season}-2-1`]: "home-1",
    [`rehearsal-${rehearsal.season}-2-2`]: "home-2",
  });
  expect(stored.tiebreaker).toBe(42);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your picks", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "My submissions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "My submissions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: `View ${rehearsal.season} Week 2`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: `View ${rehearsal.season} Week 1`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your picks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("list").getByText("Correct", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("list").getByText("Incorrect", { exact: true }),
  ).toBeVisible();

  await page.goto(`/standings?season=${rehearsal.season}&week=2`);
  await expect(
    page.getByRole("table", {
      name: `${rehearsal.season} season, Week 2 standings`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: /^Rehearsal Player\b/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: /^Rehearsal Rival\b/ }),
  ).toBeVisible();
  const standingsResponse = await page.request.get(
    `/api/standings?season=${rehearsal.season}&week=2`,
    {
      maxRedirects: 0,
    },
  );
  expect(standingsResponse.status()).toBe(200);
  const standings = (await standingsResponse.json()) as StandingsData;
  expect(standings.showTiebreaker).toBe(false);
  expect(standings.standings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        user: { id: 102, username: "Rehearsal Rival" },
        remainingCount: 2,
        tiebreaker: null,
        tiebreakerDiff: null,
      }),
    ]),
  );
  for (const row of standings.standings) {
    for (const privateField of [
      "picks",
      "remainingPicks",
      "submissionId",
      "discordId",
      "admin",
    ]) {
      expect(row).not.toHaveProperty(privateField);
    }
    expect(Object.keys(row.user).sort()).toEqual(["id", "username"]);
  }
  await page.locator("summary", { hasText: "Account" }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Dark", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toBeFocused();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toBeHidden();
  await expect(page.locator("summary", { hasText: "Account" })).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole("table", {
      name: `${rehearsal.season} season, Week 2 standings`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("standings-dark.png"),
    fullPage: true,
  });
  await page.locator("summary", { hasText: "Account" }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toBeHidden();
  await expect(page.locator("summary", { hasText: "Account" })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("standings-light.png"),
    fullPage: true,
  });
  expect(
    rehearsal.upstreams.requests.some((request) =>
      request.includes("site.web.api.espn.com"),
    ),
  ).toBe(true);
});

test("historical IDs and same-week season switching keep archived picks and standings separate", async ({
  page,
  rehearsal,
}) => {
  await page.goto(rehearsal.links.player);
  await page.goto("/submissions");
  await expect(
    page.getByRole("link", {
      name: `View ${rehearsal.season} Week 1`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: `View ${rehearsal.historicalSeason} Week 1`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your picks", exact: true }),
  ).toBeVisible();
  const historicalPath = new URL(page.url()).pathname;
  await page.goto(`${historicalPath}?season=${rehearsal.season}&week=2`);
  await expect(
    page.getByRole("link", { name: "Edit picks", exact: true }),
  ).toHaveAttribute(
    "href",
    `/submissions/new?season=${rehearsal.historicalSeason}&week=1`,
  );
  await page.getByRole("link", { name: "Edit picks", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Season", exact: true }),
  ).toHaveText(`${rehearsal.historicalSeason} season`);
  await expect(page.getByRole("radio").first()).toBeDisabled();
  for (const choice of await page.getByRole("radio").all()) {
    await expect(choice).toBeDisabled();
  }
  await page.getByRole("link", { name: "Standings", exact: true }).click();
  await expect(
    page.getByRole("table", {
      name: `${rehearsal.historicalSeason} season, Week 1 standings`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: /^Rehearsal Rival\b/ }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Season", exact: true }).click();
  await page
    .getByRole("option", { name: `${rehearsal.season} season`, exact: true })
    .click();
  await expect(
    page.getByRole("table", {
      name: `${rehearsal.season} season, Week 1 standings`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: /^Rehearsal Rival\b/ }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Make picks", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Season", exact: true }),
  ).toHaveText(`${rehearsal.season} season`);
  await page.getByRole("combobox", { name: "Week", exact: true }).click();
  await page.getByRole("option", { name: "Week 2", exact: true }).click();
  await expect(
    page.getByLabel("Monday night tiebreaker", { exact: true }),
  ).toBeEnabled();
});

// Rank, Correct, then Wins, P/L, Played, Accuracy, Best, Worst, Avg. Each
// historical week is a $5 two-player pot: Rival won two, Player won one.
const seasonStatLabels = [
  "Wins",
  "P/L",
  "Played",
  "Accuracy",
  "Best",
  "Worst",
  "Avg",
];
const historicalTotals = [
  {
    name: "Rehearsal Rival",
    current: false,
    rank: "1",
    correct: "2/6",
    stats: ["2", "+$5.00", "3", "33.3%", "1 (Wk 1)", "0 (Wk 2)", "0.7"],
  },
  {
    name: "Rehearsal Player",
    current: true,
    rank: "2",
    correct: "1/6",
    stats: ["1", "-$5.00", "3", "16.7%", "1 (Wk 2)", "0 (Wk 1)", "0.3"],
  },
];

// Phones replace the season table with a roster list; the table must leave the
// accessibility tree rather than merely scroll. Desktop keeps the table.
async function expectSeasonStandings(
  page: Page,
  season: number,
  mobile: boolean,
) {
  if (!mobile) {
    const table = page.getByRole("table", {
      name: `${season} season standings`,
      exact: true,
    });
    await expect(table).toBeVisible();
    return table;
  }
  // The roster is not named by season, so wait for the heading's season first.
  await expect(page.locator(".page-eyebrow")).toHaveText(`${season} season`);
  await expect(page.getByRole("table")).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Season standings", exact: true }),
  ).toBeHidden();
  const roster = page.getByRole("list", {
    name: "Season standings",
    exact: true,
  });
  await expect(roster).toBeVisible();
  return roster;
}

async function expectHistoricalTotals(
  page: Page,
  standings: Locator,
  mobile: boolean,
) {
  for (const totals of historicalTotals) {
    if (!mobile) {
      await expect(
        standings
          .getByRole("row")
          .filter({
            has: page.getByRole("rowheader", {
              name: new RegExp(`^${totals.name}\\b`),
            }),
          })
          .getByRole("cell"),
      ).toHaveText([totals.rank, totals.correct, ...totals.stats]);
      continue;
    }
    const item = standings
      .getByRole("listitem")
      .filter({ hasText: totals.name });
    await expect(item.locator(".season-roster-rank")).toHaveText(totals.rank);
    await expect(item.locator(".season-roster-correct")).toHaveText(
      `Correct ${totals.correct}`,
    );
    await expect(item.getByRole("term")).toHaveText(seasonStatLabels);
    await expect(item.getByRole("definition")).toHaveText(totals.stats);
    expect(await item.getAttribute("data-current-user")).toBe(
      totals.current ? "true" : null,
    );
  }
}

test("season totals rank archived weeks from frozen boards and fit every navigation width", async ({
  page,
  rehearsal,
}, testInfo) => {
  await page.goto(rehearsal.links.player);
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Season", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/season" &&
      url.searchParams.get("season") === String(rehearsal.season) &&
      url.searchParams.get("week") === "2",
  );
  await page.getByRole("combobox", { name: "Season", exact: true }).click();
  await page
    .getByRole("option", {
      name: `${rehearsal.historicalSeason} season`,
      exact: true,
    })
    .click();
  const mobile = testInfo.project.name === "mobile-dark";
  const historical = await expectSeasonStandings(
    page,
    rehearsal.historicalSeason,
    mobile,
  );
  await expectHistoricalTotals(page, historical, mobile);
  await expect(
    page.getByText("Season complete", { exact: true }),
  ).toBeVisible();
  const weeks = page.getByRole("region", { name: "Weekly results" });
  await expect(weeks.getByRole("listitem")).toHaveCount(3);
  await expect(
    weeks.getByText("Winner: Rehearsal Rival", { exact: true }),
  ).toHaveCount(2);
  await expect(
    weeks.getByText("Winner: Rehearsal Player", { exact: true }),
  ).toHaveCount(1);
  const frozen = await rehearsal.db
    .prepare(
      "SELECT COUNT(*) AS count FROM scoreboard_snapshots WHERE season=?",
    )
    .bind(rehearsal.historicalSeason)
    .first<{ count: number }>();
  expect(frozen?.count).toBe(3);

  await page.getByRole("combobox", { name: "Season", exact: true }).click();
  await page
    .getByRole("option", { name: `${rehearsal.season} season`, exact: true })
    .click();
  await expectSeasonStandings(page, rehearsal.season, mobile);
  const currentWeeks = page.getByRole("region", { name: "Weekly results" });
  await expect(
    currentWeeks
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: "Week 1" }) }),
  ).toContainText("Final");
  await expect(page.getByText(/In progress/)).toHaveCount(0);

  for (const width of [320, 375, 768, 1023]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("link", { name: "Season", exact: true }),
    ).toBeVisible();
    const layout = await page.evaluate(() => ({
      page:
        (document.scrollingElement?.scrollWidth ?? Infinity) <=
        window.innerWidth,
      // The season standings must never widen the document sideways.
      document:
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
      standings: document.querySelector(".season-roster")?.checkVisibility()
        ? "roster"
        : "table",
      links: Array.from(
        document.querySelectorAll<HTMLElement>(".app-navigation .nav-link"),
        (link) => link.scrollWidth <= link.clientWidth,
      ),
    }));
    expect(layout, `Season page fits at ${width}px`).toEqual({
      page: true,
      document: true,
      standings: width < 768 ? "roster" : "table",
      links: [true, true, true, true, true],
    });
    await page.screenshot({
      path: testInfo.outputPath(`season-${width}.png`),
      fullPage: true,
    });
  }
});

test("ordinary users cannot access administrator pages or APIs and logout reaches Worker before assets", async ({
  page,
  rehearsal,
}) => {
  await page.goto(rehearsal.links.player);
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  await page.goto("/admin/jobs");
  await expect(
    page.getByRole("heading", { name: "Access denied", exact: true }),
  ).toBeVisible();
  expect(
    (await page.request.get("/api/admin/jobs", { maxRedirects: 0 })).status(),
  ).toBe(403);
  expect(
    (
      await page.request.get(
        `/api/admin/submissions?season=${rehearsal.season}&week=2`,
        {
          maxRedirects: 0,
        },
      )
    ).status(),
  ).toBe(403);
  const { csrfToken } = (await (
    await page.request.get("/api/session", { maxRedirects: 0 })
  ).json()) as SessionData;
  assert(csrfToken, "Authenticated session must provide a CSRF token");
  expect(
    (
      await page.request.post("/api/admin/jobs", {
        maxRedirects: 0,
        headers: { Origin: rehearsal.origin, "X-CSRF-Token": csrfToken },
        data: { type: "deliver_hashes", season: rehearsal.season, week: 2 },
      })
    ).status(),
  ).toBe(403);

  const logout = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/logout" &&
      response.request().method() === "DELETE",
  );
  await page.locator("summary", { hasText: "Account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const response = await logout;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({ user: null, csrfToken: null });
  await expect(page).toHaveURL(
    (url) => url.origin === rehearsal.origin && url.pathname === "/sign_in",
  );
  expect(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === "pickem_session",
    ),
  ).toBe(false);
  await page.reload();
  expect(
    await (await page.request.get("/api/session", { maxRedirects: 0 })).json(),
  ).toEqual({ user: null, csrfToken: null });
  expect(
    (await page.request.get("/api/admin/jobs", { maxRedirects: 0 })).status(),
  ).toBe(401);
  await page.goto("/submissions");
  await expect(
    page.getByRole("link", { name: "Sign in with Discord", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/sign_in");
});

test("administrator creates native Workflow work but delivery policy prevents every Discord call", async ({
  page,
  rehearsal,
}, testInfo) => {
  await page.goto(rehearsal.links.admin);
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  await page.goto(`/admin/submissions?season=${rehearsal.season}&week=2`);
  await expect(
    page.getByRole("heading", { name: "All submissions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: "Rehearsal Rival", exact: true }),
  ).toBeVisible();
  await page.goto("/admin/jobs");
  await expect(
    page.getByRole("heading", { name: "Job management", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Job type", exact: true }).click();
  await page
    .getByRole("option", { name: "Deliver hashes", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Job season", exact: true }).click();
  await page
    .getByRole("option", { name: `${rehearsal.season} season`, exact: true })
    .click();
  await page.getByLabel("Job week", { exact: true }).fill("2");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/jobs" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Enqueue job", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { run } = (await response.json()) as { run: JobRun };
  expect(run.type).toBe("deliver_hashes");
  expect(run.season).toBe(rehearsal.season);
  // Native workerd execution, not a manually inserted job row, must reach a
  // terminal error through the production sends-disabled policy.
  await expect
    .poll(
      async () => {
        const detail = (await (
          await page.request.get(
            `/api/admin/jobs/${encodeURIComponent(run.id)}`,
            { maxRedirects: 0 },
          )
        ).json()) as { run: JobRun };
        return detail.run.status;
      },
      { timeout: 30_000 },
    )
    .toBe("errored");
  await page.goto(`/admin/jobs/${encodeURIComponent(run.id)}`);
  await expect(
    page.getByRole("heading", { name: "Job details", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("errored", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Discord sends are disabled by policy/),
  ).toBeVisible();
  await expect(
    page.getByText("No delivery records yet.", { exact: true }),
  ).toBeVisible();
  const detail = (await (
    await page.request.get(`/api/admin/jobs/${encodeURIComponent(run.id)}`, {
      maxRedirects: 0,
    })
  ).json()) as { deliveries: unknown[] };
  expect(detail.deliveries).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Job details", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("native-job-policy.png"),
    fullPage: true,
  });
});

test("administrator records a manual payment, sees the balance move, and voids it", async ({
  page,
  rehearsal,
}, testInfo) => {
  const rivalBalance = async () => {
    const data = (await (
      await page.request.get(`/api/admin/payments?season=${rehearsal.season}`, {
        maxRedirects: 0,
      })
    ).json()) as PaymentsData;
    const row = data.players.find(
      (player) => player.user.username === "Rehearsal Rival",
    );
    assert(row, "Rehearsal Rival must have a balance row");
    return row;
  };
  // Mirrors the page's wording: negative owes the banker, positive is owed.
  const wording = (cents: number) => {
    const amount = `$${(Math.abs(cents) / 100).toFixed(2)}`;
    if (cents === 0) {
      return "Settled";
    }
    return cents < 0 ? `Owes ${amount}` : `You owe ${amount}`;
  };

  await page.goto(rehearsal.links.admin);
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  await page.locator("summary", { hasText: "Account" }).click();
  await page.getByRole("link", { name: "Payments", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  const before = await rivalBalance();
  assert(!before.banker, "The rehearsal pool starts without a banker");
  const balances = page.getByRole("table", {
    name: `${rehearsal.season} season balances`,
    exact: true,
  });
  // The fifth data cell is Balance; a Venmo link column may follow it.
  const rival = balances.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: /^Rehearsal Rival\b/ }),
  });
  await expect(rival.getByRole("cell").nth(4)).toHaveText(
    wording(before.balanceCents),
  );

  await page.getByRole("combobox", { name: "Player", exact: true }).click();
  await page
    .getByRole("option", { name: "Rehearsal Rival", exact: true })
    .click();
  await page.getByLabel("Amount in dollars", { exact: true }).fill("25");
  await page
    .getByLabel("Date paid", { exact: true })
    .fill(`${rehearsal.season}-10-09`);
  await page.getByLabel("Note (optional)", { exact: true }).fill("Venmo");
  const recorded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/payments" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  expect((await recorded).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText(
    "Recorded $25.00 received.",
  );
  await expect(rival.getByRole("cell").nth(4)).toHaveText(
    wording(before.balanceCents + 2500),
  );
  expect((await rivalBalance()).paidInCents).toBe(before.paidInCents + 2500);

  const history = page.getByRole("table", {
    name: `${rehearsal.season} season payment history`,
    exact: true,
  });
  const entry = history.getByRole("row").filter({ hasText: "Venmo" });
  await expect(entry).toContainText("Approved");
  await entry
    .getByRole("button", {
      name: `Void $25.00 received from Rehearsal Rival on Oct 9, ${rehearsal.season}`,
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "stops counting toward balances",
  );
  await page.getByRole("button", { name: "Confirm void", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Payment voided.");
  await expect(rival.getByRole("cell").nth(4)).toHaveText(
    wording(before.balanceCents),
  );
  await expect(entry).toContainText("Voided");
  await expect(entry.getByRole("button")).toHaveCount(0);
  expect(await rivalBalance()).toEqual(before);

  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 900 });
    // Wide tables scroll inside their own region; nothing else may overflow.
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("main *"))
          .filter(
            (element) =>
              !element.closest(".table-scroll") &&
              element.getBoundingClientRect().right > window.innerWidth + 0.5,
          )
          .map(
            (element) =>
              `${element.tagName.toLowerCase()}.${element.className}: ${element.textContent.slice(0, 40)}`,
          ),
      ),
      `Payments page fits at ${width}px`,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          (document.scrollingElement?.scrollWidth ?? Infinity) <=
          window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`payments-${width}.png`),
      fullPage: true,
    });
  }
});

// Invented names and IDs only; shaped like a Venmo statement export.
function venmoStatement(season: number) {
  const header =
    ",ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer";
  const row = (id: string, at: string, note: string, amount: string) =>
    `,${id},${season}-09-${at},Payment,Complete,${note},Jordan Synthetic,Rehearsal Banker,${amount},,0,,0,,,Venmo balance,,,,Venmo,,`;
  return [
    "Account Statement - (@rehearsal-banker) ,,,,,,,,,,,,,,,,,,,,,",
    "Account Activity,,,,,,,,,,,,,,,,,,,,,",
    header,
    row("9100000000000000001", "10T18:22:11", "pickem week 1", "+ $5.00"),
    row("9100000000000000002", "11T19:05:42", "Tacos and the game", "+ $7.50"),
  ].join("\n");
}

test("administrator imports a Venmo statement, reviews it, and sees the balance", async ({
  page,
  rehearsal,
}, testInfo) => {
  const season = rehearsal.season;
  const playerBalance = async () => {
    const data = (await (
      await page.request.get(`/api/admin/payments?season=${season}`, {
        maxRedirects: 0,
      })
    ).json()) as PaymentsData;
    const row = data.players.find(
      (player) => player.user.username === "Rehearsal Player",
    );
    assert(row, "Rehearsal Player must have a balance row");
    return row;
  };
  const wording = (cents: number) => {
    const amount = `$${(Math.abs(cents) / 100).toFixed(2)}`;
    if (cents === 0) {
      return "Settled";
    }
    return cents < 0 ? `Owes ${amount}` : `You owe ${amount}`;
  };

  await page.goto(rehearsal.links.admin);
  await expect(
    page.getByRole("heading", { name: "Make your picks", exact: true }),
  ).toBeVisible();
  await page.goto(`/admin/payments?season=${season}`);
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  const before = await playerBalance();

  await page.locator("summary", { hasText: "Venmo accounts" }).click();
  const account = page.getByRole("form", {
    name: "Venmo for Rehearsal Player",
    exact: true,
  });
  await account
    .getByLabel("Venmo username", { exact: true })
    .fill("@rehearsal-player");
  await account
    .getByLabel("Venmo names, one per line", { exact: true })
    .fill("Jordan Synthetic");
  await account
    .getByRole("button", { name: "Save Venmo for Rehearsal Player" })
    .click();
  // The saved form remounts with the server's values and confirms in place.
  await expect(account.getByRole("status")).toHaveText("Saved.");

  await page
    .getByLabel("Keywords, separated by commas", { exact: true })
    .fill("pickem");
  await page
    .getByRole("button", { name: "Save keywords", exact: true })
    .click();
  await expect(
    page.getByText("Keywords saved.", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Statement CSV", { exact: true }).setInputFiles({
    name: "venmo-statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(venmoStatement(season)),
  });
  const imported = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/payments/import" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Import statement", exact: true })
    .click();
  expect((await imported).status()).toBe(200);
  await expect(page.getByText(/^Import finished: /)).toHaveText(
    /^Import finished: 1 approved, 1 needs review, 0 already imported, \d+ skipped\.$/,
  );

  await expect(
    page.getByRole("heading", { name: "Needs review (1)", exact: true }),
  ).toBeVisible();
  const queue = page.getByRole("list", { name: "Payments to review" });
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue).toContainText("Tacos and the game");
  const description = `$7.50 received from Jordan Synthetic on Sep 11, ${season}`;
  await expect(
    queue.getByRole("combobox", { name: `Player for ${description}` }),
  ).toHaveText("Rehearsal Player");
  await expect(
    queue.getByRole("combobox", { name: `Season for ${description}` }),
  ).toHaveText(`${season} season`);
  await queue
    .getByRole("button", { name: `Approve ${description}`, exact: true })
    .click();
  await expect(
    page.getByText("Payment approved.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs review (0)", exact: true }),
  ).toBeVisible();

  const after = await playerBalance();
  expect(after.paidInCents).toBe(before.paidInCents + 1250);
  expect(after.balanceCents).toBe(before.balanceCents + 1250);
  const balances = page.getByRole("table", {
    name: `${season} season balances`,
    exact: true,
  });
  const player = balances.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: /^Rehearsal Player\b/ }),
  });
  await expect(player.getByRole("cell").nth(4)).toHaveText(
    wording(after.balanceCents),
  );
  if (after.balanceCents !== 0) {
    const txn = after.balanceCents < 0 ? "charge" : "pay";
    const amount = (Math.abs(after.balanceCents) / 100).toFixed(2);
    await expect(player.getByRole("link")).toHaveAttribute(
      "href",
      `https://venmo.com/?txn=${txn}&audience=private&recipients=rehearsal-player&amount=${amount}&note=Pick%27em%20${season}%20pickem`,
    );
  }

  const history = page.getByRole("table", {
    name: `${season} season payment history`,
    exact: true,
  });
  for (const note of ["pickem week 1", "Tacos and the game"]) {
    const row = history.getByRole("row").filter({ hasText: note });
    await expect(row).toContainText("Venmo: Jordan Synthetic");
    await expect(row).toContainText("Approved");
    await expect(row.getByRole("button", { name: /^Reopen / })).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("payments-venmo.png"),
    fullPage: true,
  });
});
