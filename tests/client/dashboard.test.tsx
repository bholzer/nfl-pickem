import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/app";
import { SessionProvider } from "../../src/client/api";
import { DashboardPage } from "../../src/client/dashboard";
import { saveDraft } from "../../src/client/drafts";
import type {
  DashboardData,
  DashboardWeek,
  Game,
  PickDetail,
} from "../../src/shared/contracts";
import { network } from "../setup-network";

const now = Date.parse("2026-09-27T18:00:00Z");
const user = {
  id: 1,
  discordId: "100000000000000001",
  username: "Alice",
  admin: false,
};

function game(id: string, status: string, minutes: number): Game {
  return {
    id,
    name: `Matchup ${id}`,
    date: new Date(now + minutes * 60_000).toISOString(),
    neutralSite: false,
    status,
    statusDetail:
      status === "STATUS_HALFTIME" ? "Halftime" : status.replace("STATUS_", ""),
    awayTeam: {
      id: `${id}-away`,
      name: `Away ${id}`,
      abbreviation: "AWY",
      logo: "",
      score: null,
    },
    homeTeam: {
      id: `${id}-home`,
      name: `Home ${id}`,
      abbreviation: "HME",
      logo: "",
      score: null,
    },
    winnerId: status === "STATUS_FINAL" ? `${id}-away` : null,
  };
}

function week(games: Game[]): DashboardWeek {
  const picks: PickDetail[] = games.map((item) => ({
    competitionId: item.id,
    selectedTeamId: item.awayTeam.id,
    winningTeamId: item.winnerId,
    correct: item.winnerId === item.awayTeam.id,
    game: item,
  }));
  return {
    scoreboard: { season: 2026, week: 4, games },
    submission: {
      id: 81,
      userId: user.id,
      season: 2026,
      week: 4,
      picks: Object.fromEntries(
        picks.map((pick) => [pick.competitionId, pick.selectedTeamId]),
      ),
      tiebreaker: 42,
      createdAt: "2026-09-20T12:00:00Z",
      updatedAt: "2026-09-20T12:00:00Z",
    },
    locked: true,
    earliestGameTime: games[0]?.date ?? null,
    picks,
    standing: {
      user,
      rank: 1,
      correctPicks: picks.filter((pick) => pick.correct).length,
      remainingCount: picks.filter((pick) => !pick.winningTeamId).length,
      tiebreaker: null,
      tiebreakerDiff: null,
      contender: true,
      winner: false,
    },
    playerCount: 2,
    action: { kind: "locked", eligibleGames: 0, deadline: null },
  };
}

function dashboard(current: DashboardWeek): DashboardData {
  return {
    season: 2026,
    phase: "regular",
    current,
    previous: null,
    checkedAt: new Date(now).toISOString(),
  };
}

function mount(data: DashboardData, fullApp = false) {
  network.use(
    http.get("http://localhost/api/dashboard", () => HttpResponse.json(data)),
  );
  return render(
    <MemoryRouter initialEntries={["/"]}>
      {fullApp ? (
        <App />
      ) : (
        <SessionProvider>
          <DashboardPage />
        </SessionProvider>
      )}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  localStorage.clear();
  network.use(
    http.get("http://localhost/api/session", () =>
      HttpResponse.json({ user, csrfToken: "csrf" }),
    ),
    http.get("http://localhost/api/seasons", () =>
      HttpResponse.json({ currentSeason: 2026, seasons: [2026] }),
    ),
  );
  vi.stubGlobal("matchMedia", () =>
    Object.assign(new EventTarget(), {
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("personal weekly dashboard", () => {
  it("separates live, next kickoff, newest finals, and changed or missing games", async () => {
    const current = week([
      game("live", "STATUS_IN_PROGRESS", -20),
      game("half", "STATUS_HALFTIME", -30),
      game("old", "STATUS_FINAL", -180),
      game("final-b", "STATUS_FINAL", -120),
      game("final-a", "STATUS_FINAL", -120),
      game("new", "STATUS_FINAL", -60),
      game("next-a", "STATUS_SCHEDULED", 30),
      game("next-b", "STATUS_SCHEDULED", 30),
      game("later", "STATUS_SCHEDULED", 90),
      game("delayed", "STATUS_DELAYED", -10),
      game("postponed", "STATUS_POSTPONED", -10),
      game("cancelled", "STATUS_CANCELED", -10),
      game("unknown", "STATUS_UNKNOWN", -10),
      game("stale", "STATUS_SCHEDULED", -10),
    ]);
    current.picks.push({
      competitionId: "missing",
      selectedTeamId: "unavailable-team",
      winningTeamId: null,
      correct: false,
      game: null,
    });
    mount(dashboard(current));
    const live = await screen.findByRole("region", { name: "Live now" });
    expect(within(live).getAllByRole("listitem")).toHaveLength(2);
    expect(within(live).getByText("Halftime")).toBeVisible();
    const next = screen.getByRole("region", { name: "Next kickoff" });
    expect(within(next).getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.queryByRole("heading", { name: "Matchup later" }),
    ).not.toBeInTheDocument();
    const finals = screen.getByRole("region", { name: "Recent finals" });
    expect(
      within(finals)
        .getAllByRole("listitem")
        .map((row) => within(row).getByRole("heading").textContent),
    ).toEqual(["Matchup new", "Matchup final-a", "Matchup final-b"]);
    const other = screen.getByRole("region", { name: "Other game statuses" });
    expect(within(other).getAllByRole("listitem")).toHaveLength(6);
    expect(
      within(other).getByText("Your pick: unavailable-team"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View all your picks" }),
    ).toHaveAttribute("href", "/submissions/81");
    expect(screen.queryByText("Final weekly result")).not.toBeInTheDocument();
  });

  it("keeps the weekly result pending after every personal pick finishes until the whole board is final", async () => {
    const current = week([game("picked", "STATUS_FINAL", -60)]);
    current.scoreboard.games.push(game("unpicked", "STATUS_SCHEDULED", 60));
    mount(dashboard(current));
    expect(await screen.findByText("Weekly result pending")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Next kickoff" }),
    ).not.toBeInTheDocument();
    const final = {
      ...current,
      scoreboard: {
        ...current.scoreboard,
        games: current.scoreboard.games.map((item) => ({
          ...item,
          status: "STATUS_FINAL",
        })),
      },
    };
    network.use(
      http.get("http://localhost/api/dashboard", () =>
        HttpResponse.json(dashboard(final)),
      ),
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Final weekly result")).toBeVisible();
  });

  it("opens Home without redirecting and continues a device draft into the current period", async () => {
    const current = week([game("scheduled", "STATUS_SCHEDULED", 60)]);
    current.submission = null;
    current.standing = null;
    current.picks = [];
    current.locked = false;
    current.action = {
      kind: "make",
      eligibleGames: 1,
      deadline: current.earliestGameTime,
    };
    saveDraft(
      user.id,
      current,
      { picks: { scheduled: "scheduled-home" }, tiebreaker: "41" },
      now,
    );
    network.use(
      http.get("http://localhost/api/weeks/4", () =>
        HttpResponse.json(current),
      ),
    );
    mount(dashboard(current), true);
    expect(
      await screen.findByRole("heading", { name: "Your week" }),
    ).toBeVisible();
    const continuePicks = await screen.findByRole("link", {
      name: "Continue picks",
    });
    expect(
      screen.getByText("Draft saved on this device · Not submitted"),
    ).toBeVisible();
    expect(continuePicks).toHaveAttribute(
      "href",
      "/submissions/new?season=2026&week=4",
    );
    await userEvent.setup().click(continuePicks);
    expect(
      await screen.findByRole("heading", { name: "Make your picks" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("radio", { name: /Home scheduled/ }),
    ).toBeChecked();
  });

  it("expires pending edits on return after kickoff, retaining stale results on failure but not after auth denial", async () => {
    const current = week([game("boundary", "STATUS_SCHEDULED", 1)]);
    current.locked = false;
    current.action = {
      kind: "review",
      eligibleGames: 1,
      deadline: current.earliestGameTime,
    };
    saveDraft(
      user.id,
      current,
      { picks: { boundary: "boundary-home" }, tiebreaker: "43" },
      now,
    );
    mount(dashboard(current));
    expect(
      await screen.findByRole("link", { name: "Continue editing" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Submitted · Changes saved on this device, not submitted",
      ),
    ).toBeVisible();
    let finishRequest: ((response: Response) => void) | undefined;
    network.use(
      http.get(
        "http://localhost/api/dashboard",
        () =>
          new Promise<Response>((resolve) => {
            finishRequest = resolve;
          }),
      ),
    );
    vi.setSystemTime(now + 61_000);
    fireEvent.focus(window);
    await waitFor(() => {
      expect(finishRequest).toBeTypeOf("function");
    });
    expect(
      screen.queryByRole("link", { name: "Continue editing" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Submitted · Picks locked")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Matchup boundary" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    finishRequest?.(
      HttpResponse.json({ error: "Scoreboard unavailable" }, { status: 503 }),
    );
    expect(
      await screen.findByText(/Showing the last checked results/),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Matchup boundary" }),
    ).toBeInTheDocument();
    network.use(
      http.get("http://localhost/api/dashboard", () =>
        HttpResponse.json({ error: "Sign in again" }, { status: 401 }),
      ),
    );
    vi.setSystemTime(now + 63_000);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Sign in again")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Matchup boundary" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "View all your picks" }),
    ).not.toBeInTheDocument();
  });
});
