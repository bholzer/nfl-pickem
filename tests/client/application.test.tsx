import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse, delay } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { App } from "../../src/client/app";
import type {
  JobRun,
  SessionData,
  SubmissionDetail,
  WeekData,
} from "../../src/shared/contracts";
import { network } from "../setup-network";

const user = {
  id: 1,
  discordId: "100000000000000001",
  username: "Alice",
  admin: false,
};
const session: SessionData = { user, csrfToken: "test-csrf" };
const submission = {
  id: 81,
  userId: 1,
  season: 2026,
  week: 4,
  picks: { game1: "away" },
  tiebreaker: 42,
  createdAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:00:00Z",
};
const game = {
  id: "game1",
  name: "Bears at Packers",
  date: "2099-09-14T20:00:00Z",
  neutralSite: false,
  status: "STATUS_SCHEDULED",
  statusDetail: "Scheduled",
  awayTeam: {
    id: "away",
    name: "Chicago Bears",
    abbreviation: "CHI",
    logo: "",
    score: null,
  },
  homeTeam: {
    id: "home",
    name: "Green Bay Packers",
    abbreviation: "GB",
    logo: "",
    score: null,
  },
  winnerId: null,
};
const weekData: WeekData = {
  scoreboard: { season: 2026, week: 4, games: [game] },
  submission: null,
  locked: false,
  earliestGameTime: game.date,
};
const detail: SubmissionDetail = {
  submission: { ...submission, user },
  scoreboard: weekData.scoreboard,
  correctPicks: 1,
  picks: [
    {
      competitionId: "game1",
      selectedTeamId: "away",
      winningTeamId: "away",
      correct: true,
      game,
    },
  ],
  summary: "Alice\nWeek 4\nCHI\nTiebreaker: 42",
  verificationHash: "a".repeat(64),
};
const job: JobRun = {
  id: "run-first",
  type: "deliver_hashes",
  season: 2026,
  week: 4,
  status: "errored",
  plannedAt: null,
  createdAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:01:00Z",
  error: "Recipient blocked the bot",
  source: "manual",
  params: { type: "deliver_hashes", season: 2026, week: 4, runId: "run-first" },
  startedAt: "2026-09-01T12:00:01Z",
  finishedAt: "2026-09-01T12:01:00Z",
  parentId: null,
};
let media: EventTarget & {
  matches: boolean;
  media: string;
  onchange: null;
  addListener: Mock;
  removeListener: Mock;
};

function mount(path: string, authenticated: SessionData = session) {
  network.use(
    http.get("http://localhost/api/session", () =>
      HttpResponse.json(authenticated),
    ),
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  network.use(
    http.get("http://localhost/api/seasons", () =>
      HttpResponse.json({ currentSeason: 2026, seasons: [2026, 2025] }),
    ),
  );
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  media = Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("authentication and navigation", () => {
  it("preserves protected destination and period through sign-in", async () => {
    mount("/submissions/new?season=2025&week=7", {
      user: null,
      csrfToken: null,
    });
    const signin = await screen.findByRole("link", {
      name: "Sign in with Discord",
    });
    const href = signin.getAttribute("href");
    if (href === null) {
      throw new Error("Sign-in link has no destination");
    }
    const target = new URL(href, "http://localhost");
    expect(target.pathname).toBe("/auth/discord");
    expect(target.searchParams.get("return_to")).toBe(
      "/submissions/new?season=2025&week=7",
    );
    expect(
      screen.queryByRole("button", { name: "Submit picks" }),
    ).not.toBeInTheDocument();
  });
  it("denies member access to administration without loading admin data", async () => {
    const adminRequest = vi.fn(() => HttpResponse.json({ runs: [] }));
    network.use(http.get("http://localhost/api/admin/jobs", adminRequest));
    mount("/admin/jobs");
    expect(
      await screen.findByRole("heading", { name: "Access denied" }),
    ).toBeVisible();
    expect(adminRequest).not.toHaveBeenCalled();
  });
  it("returns an expired session to sign-in instead of retaining private content", async () => {
    network.use(
      http.get("http://localhost/api/submissions", () =>
        HttpResponse.json({ error: "Session expired" }, { status: 401 }),
      ),
    );
    mount("/submissions");
    const link = await screen.findByRole("link", {
      name: "Sign in with Discord",
    });
    const href = link.getAttribute("href");
    if (href === null) {
      throw new Error("Sign-in link has no destination");
    }
    expect(
      new URL(href, "http://localhost").searchParams.get("return_to"),
    ).toBe("/submissions");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("shows a server authorization rejection rather than rendering protected data", async () => {
    network.use(
      http.get("http://localhost/api/admin/jobs", () =>
        HttpResponse.json(
          { error: "Administrator permission was revoked" },
          { status: 403 },
        ),
      ),
    );
    mount("/admin/jobs", { ...session, user: { ...user, admin: true } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Administrator permission was revoked",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("signs out with CSRF and removes private navigation", async () => {
    network.use(
      http.get("http://localhost/api/submissions", () =>
        HttpResponse.json({ submissions: [] }),
      ),
      http.delete("http://localhost/logout", ({ request }) =>
        request.headers.get("X-CSRF-Token") === "test-csrf" &&
        request.credentials === "same-origin"
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json({ error: "CSRF rejected" }, { status: 403 }),
      ),
    );
    mount("/submissions");
    await userEvent.click(await screen.findByText("Account"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign out" }),
    );
    expect(
      await screen.findByRole("link", { name: "Sign in with Discord" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();
  });
  it("resolves personal detail by ID despite a conflicting URL period and pins editing to its stored season", async () => {
    network.use(
      http.get("http://localhost/api/submissions/81", () =>
        HttpResponse.json(detail),
      ),
      http.get("http://localhost/api/weeks/4", () =>
        HttpResponse.json({ ...weekData, submission }),
      ),
    );
    mount("/submissions/81?season=2025&week=7");
    expect(await screen.findByText(detail.verificationHash)).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "Edit picks" }));
    expect(
      await screen.findByRole("radio", {
        name: "Chicago Bears for Bears at Packers",
      }),
    ).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Week" })).toHaveTextContent(
      "Week 4",
    );
    expect(screen.getByRole("combobox", { name: "Season" })).toHaveTextContent(
      "2026 season",
    );
  });
  it("keeps a missing or inaccessible detail as a not-found error instead of opening another week's picks", async () => {
    network.use(
      http.get("http://localhost/api/submissions/999", () =>
        HttpResponse.json({ error: "Submission not found" }, { status: 404 }),
      ),
    );
    mount("/submissions/999?season=2025&week=4");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Submission not found",
    );
    expect(
      screen.queryByRole("button", { name: "Submit picks" }),
    ).not.toBeInTheDocument();
  });
  it("does not replace a newly selected season with an old delayed standings response", async () => {
    network.use(
      http.get("http://localhost/api/standings", async ({ request }) => {
        const week = Number(new URL(request.url).searchParams.get("week"));
        const season = Number(new URL(request.url).searchParams.get("season"));
        if (season === 2025) {
          await delay(120);
        }
        return HttpResponse.json({
          scoreboard: { season, week, games: [] },
          standings: [
            {
              user: { id: user.id, username: `Player season ${season}` },
              correctPicks: week,
              remainingCount: 0,
              tiebreaker: null,
              tiebreakerDiff: null,
              contender: true,
              winner: false,
              rank: 1,
            },
          ],
          showTiebreaker: false,
        });
      }),
    );
    mount("/standings?season=2025&week=4");
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Season" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "2026 season" }),
    );
    expect(
      await screen.findByRole("rowheader", { name: /^Player season 2026\b/ }),
    ).toBeVisible();
    await act(() => delay(160));
    expect(
      screen.queryByRole("rowheader", { name: /^Player season 2025\b/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Season" })).toHaveTextContent(
      "2026 season",
    );
    expect(screen.getByRole("combobox", { name: "Week" })).toHaveTextContent(
      "Week 4",
    );
  });
});

describe("picks and standings", () => {
  it("validates incomplete picks then saves chosen teams and numeric tiebreaker to the selected week", async () => {
    network.use(
      http.get("http://localhost/api/weeks/4", () =>
        HttpResponse.json(weekData),
      ),
      http.put("http://localhost/api/submissions/4", async ({ request }) => {
        const body = await request.json();
        if (
          JSON.stringify(body) !==
            JSON.stringify({ picks: { game1: "home" }, tiebreaker: 37 }) ||
          request.headers.get("X-CSRF-Token") !== "test-csrf" ||
          new URL(request.url).searchParams.get("season") !== "2026"
        ) {
          return HttpResponse.json({ error: "Invalid save" }, { status: 422 });
        }
        return HttpResponse.json({
          submission: {
            ...submission,
            picks: { game1: "home" },
            tiebreaker: 37,
          },
        });
      }),
      http.get("http://localhost/api/submissions/81", () =>
        HttpResponse.json({
          ...detail,
          submission: { ...detail.submission, tiebreaker: 37 },
          picks: [
            { ...detail.picks[0], selectedTeamId: "home", correct: false },
          ],
        }),
      ),
    );
    mount("/submissions/new?season=2026&week=4");
    await userEvent.click(
      await screen.findByRole("button", { name: "Submit picks" }),
    );
    expect(screen.getByRole("alert")).toBeVisible();
    expect(
      screen.getByRole("radio", { name: "Chicago Bears for Bears at Packers" }),
    ).toHaveFocus();
    await userEvent.click(
      screen.getByRole("radio", {
        name: "Green Bay Packers for Bears at Packers",
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Monday night tiebreaker"),
      "37",
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit picks" }));
    expect(
      await screen.findByRole("heading", { name: "Your picks" }),
    ).toBeVisible();
    expect(screen.getByText("37", { selector: "dd" })).toBeVisible();
  });
  it("resets same-week picks across seasons and saves only to the selected season", async () => {
    network.use(
      http.get("http://localhost/api/weeks/4", ({ request }) => {
        const season = Number(new URL(request.url).searchParams.get("season"));
        return HttpResponse.json({
          ...weekData,
          scoreboard: { ...weekData.scoreboard, season },
          submission:
            season === 2025 ? { ...submission, season, tiebreaker: 11 } : null,
        });
      }),
      http.put("http://localhost/api/submissions/4", async ({ request }) => {
        const body: unknown = await request.json();
        if (
          new URL(request.url).searchParams.get("season") !== "2026" ||
          JSON.stringify(body) !==
            JSON.stringify({ picks: { game1: "home" }, tiebreaker: 37 })
        ) {
          return HttpResponse.json(
            { error: "Wrong season or stale picks" },
            { status: 422 },
          );
        }
        return HttpResponse.json({
          submission: {
            ...submission,
            picks: { game1: "home" },
            tiebreaker: 37,
          },
        });
      }),
      http.get("http://localhost/api/submissions/81", () =>
        HttpResponse.json({
          ...detail,
          submission: { ...detail.submission, tiebreaker: 37 },
        }),
      ),
    );
    mount("/submissions/new?season=2025&week=4");
    expect(
      await screen.findByRole("radio", {
        name: "Chicago Bears for Bears at Packers",
      }),
    ).toBeChecked();
    expect(screen.getByLabelText("Monday night tiebreaker")).toHaveValue(11);
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Season" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "2026 season" }),
    );
    expect(
      await screen.findByRole("button", { name: "Submit picks" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("radio", { name: "Chicago Bears for Bears at Packers" }),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Monday night tiebreaker")).toHaveValue(null);
    await userEvent.click(
      screen.getByRole("radio", {
        name: "Green Bay Packers for Bears at Packers",
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Monday night tiebreaker"),
      "37",
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit picks" }));
    expect(
      await screen.findByRole("heading", { name: "Your picks" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Edit picks" })).toHaveAttribute(
      "href",
      "/submissions/new?season=2026&week=4",
    );
  });
  it("preserves form selections on server validation, then locks on a kickoff conflict", async () => {
    let status = 422;
    network.use(
      http.get("http://localhost/api/weeks/4", () =>
        HttpResponse.json(weekData),
      ),
      http.put("http://localhost/api/submissions/4", () =>
        HttpResponse.json(
          status === 422
            ? {
                error: "Invalid tiebreaker",
                fields: { tiebreaker: "Choose a whole number" },
              }
            : { error: "Games have started" },
          { status },
        ),
      ),
    );
    mount("/submissions/new?season=2026&week=4");
    await userEvent.click(
      await screen.findByRole("radio", {
        name: "Chicago Bears for Bears at Packers",
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Monday night tiebreaker"),
      "42",
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit picks" }));
    expect(
      await screen.findByText("tiebreaker: Choose a whole number"),
    ).toBeVisible();
    expect(
      screen.getByRole("radio", { name: "Chicago Bears for Bears at Packers" }),
    ).toBeChecked();
    status = 409;
    await userEvent.click(screen.getByRole("button", { name: "Submit picks" }));
    expect(await screen.findByText("Games have started")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Submit picks" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Chicago Bears for Bears at Packers" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Monday night tiebreaker")).toBeDisabled();
  });
  it("allows late initial picks only for remaining games but locks existing submissions", async () => {
    const started = {
      ...game,
      id: "started",
      name: "Earlier game",
      status: "STATUS_FINAL",
    };
    network.use(
      http.get("http://localhost/api/weeks/4", () =>
        HttpResponse.json({
          ...weekData,
          locked: true,
          scoreboard: { season: 2026, week: 4, games: [started, game] },
        }),
      ),
    );
    const view = mount("/submissions/new?season=2026&week=4");
    expect(
      await screen.findByRole("radio", {
        name: "Chicago Bears for Earlier game",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: "Chicago Bears for Bears at Packers" }),
    ).toBeEnabled();
    view.unmount();
    network.use(
      http.get("http://localhost/api/weeks/4", () =>
        HttpResponse.json({ ...weekData, locked: true, submission }),
      ),
    );
    mount("/submissions/new?season=2026&week=4");
    expect(
      await screen.findByRole("radio", {
        name: "Chicago Bears for Bears at Packers",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Update picks" }),
    ).not.toBeInTheDocument();
  });
  it("displays server ranks, winner and nullable tiebreaker differences without fabricating zero", async () => {
    network.use(
      http.get("http://localhost/api/standings", () =>
        HttpResponse.json({
          scoreboard: weekData.scoreboard,
          showTiebreaker: true,
          standings: [
            {
              user: { id: user.id, username: user.username },
              correctPicks: 12,
              remainingCount: 0,
              tiebreaker: 42,
              tiebreakerDiff: 2,
              contender: true,
              winner: true,
              rank: 1,
            },
            {
              user: { id: 2, username: "Bob" },
              correctPicks: 12,
              remainingCount: 0,
              tiebreaker: 45,
              tiebreakerDiff: null,
              contender: true,
              winner: false,
              rank: 2,
            },
          ],
        }),
      ),
    );
    mount("/standings?season=2026&week=4");
    const alice = await screen.findByRole("row", { name: /Alice/ });
    expect(within(alice).getByText("Winner")).toBeVisible();
    expect(within(alice).getByRole("cell", { name: "42" })).toBeVisible();
    const bob = screen.getByRole("row", { name: /Bob/ });
    expect(
      within(bob).getByRole("cell", { name: "Not available" }),
    ).toBeVisible();
    expect(within(bob).getByText("Contender")).toBeVisible();
  });
});

it("follows system theme until explicitly overridden and can return to system", async () => {
  mount("/sign_in", { user: null, csrfToken: null });
  const theme = screen.getByRole("combobox", { name: "Theme" });
  act(() => {
    media.matches = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement).toHaveClass("dark");
  await userEvent.click(theme);
  await userEvent.click(await screen.findByRole("option", { name: "Light" }));
  expect(localStorage.getItem("theme")).toBe("light");
  act(() => {
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement).not.toHaveClass("dark");
  await userEvent.click(theme);
  await userEvent.click(
    await screen.findByRole("option", { name: "System theme" }),
  );
  expect(document.documentElement).toHaveClass("dark");
});

describe("job operations", () => {
  it("enqueues selected type/season/week, pauses delivery and executes selected-job controls", async () => {
    let runs = [job];
    let paused = false;
    network.use(
      http.get("http://localhost/api/admin/jobs", () =>
        HttpResponse.json({ runs, paused, schedules: [], hasMore: false }),
      ),
      http.post("http://localhost/api/admin/jobs", async ({ request }) => {
        const body = (await request.json()) as {
          type: string;
          season: number;
          week: number;
        };
        if (
          body.type !== "deliver_standings" ||
          body.week !== 7 ||
          body.season !== 2025 ||
          request.headers.get("X-CSRF-Token") !== "test-csrf"
        ) {
          return HttpResponse.json({ error: "Wrong enqueue" }, { status: 422 });
        }
        runs = [
          ...runs,
          {
            ...job,
            id: "run-new",
            type: "deliver_standings",
            season: 2025,
            week: 7,
            status: "queued",
            error: null,
          },
        ];
        return HttpResponse.json({ run: runs[1] }, { status: 201 });
      }),
      http.put("http://localhost/api/admin/jobs/pause", async ({ request }) => {
        paused = ((await request.json()) as { paused: boolean }).paused;
        return HttpResponse.json({ paused });
      }),
      http.post(
        "http://localhost/api/admin/jobs/actions",
        async ({ request }) => {
          const body = (await request.json()) as {
            ids: string[];
            action: string;
          };
          if (body.action !== "retry" || body.ids.join() !== job.id) {
            return HttpResponse.json(
              { error: "Wrong selection" },
              { status: 422 },
            );
          }
          runs = runs.map((run) =>
            run.id === job.id ? { ...run, status: "queued", error: null } : run,
          );
          return HttpResponse.json({ runs: [runs[0]] });
        },
      ),
    );
    mount("/admin/jobs", { ...session, user: { ...user, admin: true } });
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Job type" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Deliver standings" }),
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Job season" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "2025 season" }),
    );
    await userEvent.type(screen.getByLabelText("Job week"), "7");
    await userEvent.click(screen.getByRole("button", { name: "Enqueue job" }));
    expect(await screen.findByRole("link", { name: /run-new/ })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Pause all delivery" }),
    );
    expect(
      await screen.findByRole("button", { name: "Resume all delivery" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("checkbox", { name: `Select job ${job.id}` }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Retry selected" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText("Recipient blocked the bot"),
      ).not.toBeInTheDocument();
    });
  });
  it("keeps partial bulk retry results and retries only the unprocessed selection", async () => {
    const second = { ...job, id: "run-second" };
    const child = {
      ...job,
      id: "run-child",
      parentId: job.id,
      status: "queued",
      error: null,
    };
    let first = true;
    network.use(
      http.get("http://localhost/api/admin/jobs", () =>
        HttpResponse.json({
          runs: [job, second],
          paused: false,
          schedules: [],
          hasMore: false,
        }),
      ),
      http.post(
        "http://localhost/api/admin/jobs/actions",
        async ({ request }) => {
          const body = (await request.json()) as {
            ids: string[];
            action: string;
          };
          if (first) {
            first = false;
            return HttpResponse.json(
              {
                runs: [child],
                failedId: second.id,
                error: "Workflow creation failed",
              },
              { status: 503 },
            );
          }
          if (
            body.action !== "retry" ||
            JSON.stringify(body.ids) !== JSON.stringify([second.id])
          ) {
            return HttpResponse.json(
              { error: "This job already has a replacement" },
              { status: 409 },
            );
          }
          return HttpResponse.json({
            runs: [{ ...child, id: "run-second-child", parentId: second.id }],
          });
        },
      ),
    );
    mount("/admin/jobs?status=errored", {
      ...session,
      user: { ...user, admin: true },
    });
    await userEvent.click(
      await screen.findByRole("checkbox", { name: `Select job ${job.id}` }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: `Select job ${second.id}` }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Retry selected" }),
    );
    expect(
      await screen.findByRole("link", { name: "View job run-child" }),
    ).toHaveAttribute("href", "/admin/jobs/run-child");
    expect(
      await screen.findByRole("checkbox", { name: `Select job ${job.id}` }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: `Select job ${second.id}` }),
    ).toBeChecked();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry selected" }),
    );
    expect(
      await screen.findByRole("link", { name: "View job run-second-child" }),
    ).toHaveAttribute("href", "/admin/jobs/run-second-child");
    expect(
      await screen.findByRole("checkbox", { name: `Select job ${second.id}` }),
    ).not.toBeChecked();
  });
  it("follows retry child runs and exposes delivery errors and parent navigation", async () => {
    const child = {
      ...job,
      id: "run-child",
      parentId: job.id,
      status: "running",
      error: null,
    };
    network.use(
      http.get("http://localhost/api/admin/jobs/run-first", () =>
        HttpResponse.json({
          run: job,
          deliveries: [
            {
              key: "dm:recipient",
              status: "failed",
              error: "Cannot message this user",
              updatedAt: job.updatedAt,
            },
          ],
        }),
      ),
      http.post(
        "http://localhost/api/admin/jobs/run-first/action",
        async ({ request }) =>
          ((await request.json()) as { action: string }).action === "retry"
            ? HttpResponse.json({ run: child })
            : HttpResponse.json({ error: "Wrong action" }, { status: 422 }),
      ),
      http.get("http://localhost/api/admin/jobs/run-child", () =>
        HttpResponse.json({ run: child, deliveries: [] }),
      ),
    );
    mount("/admin/jobs/run-first", {
      ...session,
      user: { ...user, admin: true },
    });
    expect(await screen.findByText("Cannot message this user")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("run-child", { selector: "dd" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "run-first" })).toHaveAttribute(
      "href",
      "/admin/jobs/run-first?season=2026&week=4",
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  });
  it("paginates with a stable run cursor and resets pagination when filtering seasons", async () => {
    network.use(
      http.get("http://localhost/api/admin/jobs", ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get("season") === "2025") {
          if (query.has("before")) {
            return HttpResponse.json(
              { error: "Stale pagination cursor" },
              { status: 422 },
            );
          }
          return HttpResponse.json({
            runs: [{ ...job, id: "filtered-run", season: 2025 }],
            paused: false,
            schedules: [],
            hasMore: false,
          });
        }
        if (query.has("before") && query.get("before") !== job.id) {
          return HttpResponse.json(
            { error: "Invalid cursor" },
            { status: 422 },
          );
        }
        return HttpResponse.json({
          runs: [query.has("before") ? { ...job, id: "older-run" } : job],
          paused: false,
          schedules: [],
          hasMore: !query.has("before"),
        });
      }),
    );
    mount("/admin/jobs", { ...session, user: { ...user, admin: true } });
    await userEvent.click(
      await screen.findByRole("button", { name: "Older jobs" }),
    );
    expect(
      await screen.findByRole("link", { name: /older-run/ }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter season" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "2025 season" }),
    );
    expect(
      await screen.findByRole("link", { name: /filtered-run/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Newest jobs" }),
    ).not.toBeInTheDocument();
  });
});
