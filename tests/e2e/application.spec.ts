import assert from "node:assert/strict";
import type {
  JobRun,
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
