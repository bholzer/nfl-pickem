import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/app";
import type { SeasonData } from "../../src/shared/contracts";
import { network } from "../setup-network";

const user = {
  id: 1,
  discordId: "100000000000000001",
  username: "Alice",
  admin: false,
};
const alice = { id: 1, username: "Alice" };
const bob = { id: 2, username: "Bob" };
const season: SeasonData = {
  season: 2026,
  phase: "in_progress",
  inProgressWeek: 3,
  weeks: [
    {
      week: 1,
      status: "final",
      playerCount: 2,
      winners: [alice],
      entryFeeCents: 2000,
      potCents: 4000,
    },
    {
      week: 2,
      status: "incomplete",
      playerCount: 2,
      winners: [],
      entryFeeCents: 500,
      potCents: 1000,
    },
    {
      week: 3,
      status: "in_progress",
      playerCount: 1,
      winners: [],
      entryFeeCents: 500,
      potCents: 500,
    },
  ],
  players: [
    {
      user: alice,
      rank: 1,
      correctPicks: 20,
      decidedPicks: 30,
      accuracy: 2 / 3,
      weeklyWins: 1,
      weeksPlayed: 3,
      bestWeek: { week: 1, correctPicks: 12 },
      worstWeek: { week: 1, correctPicks: 12 },
      averageCorrect: 12,
      feesPaidCents: 3000,
      winningsCents: 4000,
      netCents: 1000,
    },
    {
      user: bob,
      rank: 2,
      correctPicks: 0,
      decidedPicks: 0,
      accuracy: null,
      weeklyWins: 0,
      weeksPlayed: 1,
      bestWeek: null,
      worstWeek: null,
      averageCorrect: null,
      feesPaidCents: 2000,
      winningsCents: 0,
      netCents: -2000,
    },
  ],
  checkedAt: "2026-10-04T12:00:00.000Z",
};
const empty: SeasonData = {
  season: 2025,
  phase: "complete",
  inProgressWeek: null,
  weeks: [],
  players: [],
  checkedAt: "2026-10-04T12:00:00.000Z",
};
let requests: URL[];

beforeEach(() => {
  requests = [];
  network.use(
    http.get("http://localhost/api/session", () =>
      HttpResponse.json({ user, csrfToken: "csrf" }),
    ),
    http.get("http://localhost/api/seasons", () =>
      HttpResponse.json({ currentSeason: 2026, seasons: [2026, 2025] }),
    ),
    http.get("http://localhost/api/season", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json(
        url.searchParams.get("season") === "2025" ? empty : season,
      );
    }),
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
afterEach(() => vi.unstubAllGlobals());

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("season page", () => {
  it("renders server totals, labels live weeks, and keeps the week for other navigation", async () => {
    mount("/season?season=2026&week=3");
    const table = await screen.findByRole("table", {
      name: "2026 season standings",
    });
    expect(requests.map((url) => url.search)).toEqual(["?season=2026"]);
    expect(
      screen.getByRole("heading", { level: 1, name: "Season" }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Season standings" }),
    ).toHaveAttribute("tabindex", "0");

    const [aliceRow, bobRow] = within(table).getAllByRole("row").slice(1);
    if (!aliceRow || !bobRow) {
      throw new Error("Season rows are missing");
    }
    expect(within(aliceRow).getByRole("rowheader")).toHaveTextContent(
      "Alice You",
    );
    expect(aliceRow).toHaveAttribute("data-current-user", "true");
    expect(
      within(aliceRow)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "1",
      "20/30",
      "1",
      "+$10.00",
      "3",
      "66.7%",
      "12 (Wk 1)",
      "12 (Wk 1)",
      "12.0",
    ]);
    expect(bobRow).not.toHaveAttribute("data-current-user");
    expect(
      within(bobRow)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["2", "0/0", "0", "-$20.00", "1", "—", "—", "—", "—"]);

    // jsdom applies no media queries, so the phone roster renders beside the
    // table; it must carry the same formatted figures in the same order.
    const roster = screen.getByRole("list", { name: "Season standings" });
    const [aliceItem, bobItem] = within(roster).getAllByRole("listitem");
    if (!aliceItem || !bobItem) {
      throw new Error("Season roster items are missing");
    }
    expect(aliceItem).toHaveAttribute("data-current-user", "true");
    expect(aliceItem).toHaveTextContent(
      "1Alice YouCorrect 20/30Wins1P/L+$10.00Played3Accuracy66.7%Best12 (Wk 1)Worst12 (Wk 1)Avg12.0",
    );
    expect(
      within(aliceItem)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Wins", "P/L", "Played", "Accuracy", "Best", "Worst", "Avg"]);
    expect(
      within(aliceItem)
        .getAllByRole("definition")
        .map((definition) => definition.textContent),
    ).toEqual(["1", "+$10.00", "3", "66.7%", "12 (Wk 1)", "12 (Wk 1)", "12.0"]);
    expect(bobItem).not.toHaveAttribute("data-current-user");
    expect(bobItem).toHaveTextContent(
      "2Bob Correct 0/0Wins0P/L-$20.00Played1Accuracy—Best—Worst—Avg—",
    );

    const strip = screen.getByRole("region", {
      name: "Your season at a glance",
    });
    expect(strip).toHaveTextContent("Your place#1of 2 players");
    expect(strip).toHaveTextContent("Correct20/30");
    expect(strip).toHaveTextContent("Weekly wins1");
    expect(strip).toHaveTextContent("P/L+$10.00");
    expect(screen.getByText("Season in progress")).toBeVisible();
    expect(screen.getByText("1 week final · Week 3 in progress")).toBeVisible();

    const weeks = screen.getByRole("region", { name: "Weekly results" });
    expect(
      within(weeks).getByText("Final · 2 players · Pot $40.00"),
    ).toBeVisible();
    expect(
      within(weeks).getByText("Incomplete · 2 players · Pot $10.00"),
    ).toBeVisible();
    expect(
      within(weeks).getByText("In progress · 1 player · Pot $5.00"),
    ).toBeVisible();
    expect(within(weeks).getByText("Winner: Alice")).toBeVisible();
    expect(
      within(weeks).getByRole("link", { name: "View standings for Week 2" }),
    ).toHaveAttribute("href", "/standings?season=2026&week=2");

    const navigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    expect(
      within(navigation).getByRole("link", { name: "Standings" }),
    ).toHaveAttribute("href", "/standings?season=2026&week=3");
    expect(
      within(navigation).getByRole("link", { name: "Season" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("refetches when the season changes and offers picks for an empty season", async () => {
    mount("/season");
    await screen.findByRole("table", { name: "2026 season standings" });
    expect(requests.map((url) => url.search)).toEqual([""]);
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Season" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "2025 season" }),
    );
    expect(
      await screen.findByRole("heading", { name: "No picks this season yet" }),
    ).toBeVisible();
    expect(requests.map((url) => url.search)).toEqual(["", "?season=2025"]);
    expect(
      screen.getByRole("link", { name: "Make your picks" }),
    ).toHaveAttribute("href", "/submissions/new?season=2025");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("explains a missing personal record without inventing a place", async () => {
    network.use(
      http.get("http://localhost/api/season", () =>
        HttpResponse.json({
          ...season,
          players: season.players.filter((player) => player.user.id !== 1),
        }),
      ),
    );
    mount("/season");
    expect(
      await screen.findByText("You haven't submitted picks this season."),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Your season at a glance" }),
    ).not.toBeInTheDocument();
  });
});
