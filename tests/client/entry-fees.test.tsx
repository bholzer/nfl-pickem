import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/app";
import type { SeasonEntryFees } from "../../src/shared/contracts";
import { network } from "../setup-network";

const admin = {
  id: 1,
  discordId: "100000000000000001",
  username: "Alice",
  admin: true,
};

function fees(season: number, overrides: Record<number, number> = {}) {
  const data: SeasonEntryFees = {
    season,
    defaultFeeCents: 500,
    weeks: Array.from({ length: 18 }, (_, index) => {
      const week = index + 1;
      const configured = overrides[week];
      return {
        week,
        feeCents: configured ?? 500,
        configured: configured !== undefined,
      };
    }),
  };
  return data;
}

let stored: Record<number, number>;
let writes: { body: unknown; csrf: string | null }[];

beforeEach(() => {
  stored = { 2: 1000 };
  writes = [];
  network.use(
    http.get("http://localhost/api/session", () =>
      HttpResponse.json({ user: admin, csrfToken: "test-csrf" }),
    ),
    http.get("http://localhost/api/seasons", () =>
      HttpResponse.json({ currentSeason: 2026, seasons: [2026, 2025] }),
    ),
    http.get("http://localhost/api/admin/entry-fees", ({ request }) =>
      HttpResponse.json(
        fees(Number(new URL(request.url).searchParams.get("season")), stored),
      ),
    ),
    http.put("http://localhost/api/admin/entry-fees", async ({ request }) => {
      const body = (await request.json()) as {
        season: number;
        week: number;
        feeCents: number;
      };
      writes.push({ body, csrf: request.headers.get("X-CSRF-Token") });
      // Stands in for any server-side rejection the input constraints let through.
      if (body.feeCents === 999) {
        return HttpResponse.json(
          {
            error: "Invalid entry fee",
            fields: { feeCents: "Fee must be whole cents from 0 to 100000" },
          },
          { status: 422 },
        );
      }
      stored = { ...stored, [body.week]: body.feeCents };
      return HttpResponse.json(fees(body.season, stored));
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

describe("entry fee administration page", () => {
  it("shows every week's fee and saves a dollar amount as whole cents with CSRF", async () => {
    mount("/admin/entry-fees?season=2026");
    const table = await screen.findByRole("table", {
      name: "2026 season entry fees",
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Entry fees" }),
    ).toBeVisible();
    expect(screen.getByText(/default of \$5\.00/)).toBeVisible();
    expect(within(table).getAllByRole("row")).toHaveLength(19);
    const weekTwo = within(table).getByRole("row", { name: /^Week 2 / });
    expect(
      within(weekTwo).getByRole("spinbutton", {
        name: "Week 2 fee in dollars",
      }),
    ).toHaveValue(10);
    expect(weekTwo).toHaveTextContent("Configured");
    const weekOne = within(table).getByRole("row", { name: /^Week 1 / });
    expect(weekOne).toHaveTextContent("Default");

    const amount = within(weekOne).getByRole("spinbutton", {
      name: "Week 1 fee in dollars",
    });
    await userEvent.clear(amount);
    await userEvent.type(amount, "7.50");
    await userEvent.click(
      within(weekOne).getByRole("button", { name: "Save Week 1 fee" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Week 1 entry fee set to $7.50.",
    );
    expect(writes).toEqual([
      { body: { season: 2026, week: 1, feeCents: 750 }, csrf: "test-csrf" },
    ]);
    expect(
      await within(table).findByRole("row", { name: /^Week 1 .*Configured/ }),
    ).toBeVisible();
  });

  it("shows a server validation failure without changing the table", async () => {
    mount("/admin/entry-fees?season=2026");
    const table = await screen.findByRole("table", {
      name: "2026 season entry fees",
    });
    const weekThree = within(table).getByRole("row", { name: /^Week 3 / });
    const amount = within(weekThree).getByRole("spinbutton", {
      name: "Week 3 fee in dollars",
    });
    await userEvent.clear(amount);
    await userEvent.type(amount, "9.99");
    await userEvent.click(
      within(weekThree).getByRole("button", { name: "Save Week 3 fee" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid entry fee");
    expect(alert).toHaveTextContent("feeCents: Fee must be whole cents");
    expect(writes.map((write) => write.body)).toEqual([
      { season: 2026, week: 3, feeCents: 999 },
    ]);
    expect(weekThree).toHaveTextContent("Default");
  });

  it("denies members without requesting fee data", async () => {
    const request = vi.fn(() => HttpResponse.json(fees(2026)));
    network.use(
      http.get("http://localhost/api/session", () =>
        HttpResponse.json({
          user: { ...admin, admin: false },
          csrfToken: "test-csrf",
        }),
      ),
      http.get("http://localhost/api/admin/entry-fees", request),
    );
    mount("/admin/entry-fees");
    expect(
      await screen.findByRole("heading", { name: "Access denied" }),
    ).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });
});
