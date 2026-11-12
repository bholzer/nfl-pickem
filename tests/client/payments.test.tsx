import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/app";
import type {
  ManualPaymentInput,
  PaymentEntry,
  PaymentPlayerBalance,
  PaymentsData,
} from "../../src/shared/contracts";
import { network } from "../setup-network";

const admin = {
  id: 1,
  discordId: "100000000000000001",
  username: "Alice",
  admin: true,
};
const users = [
  { id: 1, username: "Alice" },
  { id: 2, username: "Bob" },
  { id: 3, username: "Cara" },
  { id: 4, username: "Dan" },
];
// Fees and winnings are fixed; only approved entries move a balance.
const ledger: Record<number, { fees: number; winnings: number }> = {
  1: { fees: 1000, winnings: 0 },
  2: { fees: 1500, winnings: 0 },
  3: { fees: 1000, winnings: 3000 },
  4: { fees: 500, winnings: 0 },
};

function entry(overrides: Partial<PaymentEntry> & { id: number }) {
  const value: PaymentEntry = {
    season: 2026,
    userId: 4,
    direction: "in",
    amountCents: 500,
    source: "manual",
    status: "approved",
    note: null,
    paidAt: "2026-10-04T12:00:00.000Z",
    createdAt: "2026-10-04T12:00:00.000Z",
    voidedAt: null,
    ...overrides,
  };
  return value;
}

function player(
  user: (typeof users)[number],
  entries: PaymentEntry[],
): PaymentPlayerBalance {
  const id = user.id;
  const sum = (direction: "in" | "out") =>
    entries
      .filter(
        (item) =>
          item.userId === id &&
          item.status === "approved" &&
          item.direction === direction,
      )
      .reduce((total, item) => total + item.amountCents, 0);
  const { fees, winnings } = ledger[id] ?? { fees: 0, winnings: 0 };
  const paidIn = sum("in");
  const paidOut = sum("out");
  const banker = id === bankerUserId;
  return {
    user,
    banker,
    feesCents: fees,
    winningsCents: winnings,
    paidInCents: paidIn,
    paidOutCents: paidOut,
    balanceCents: banker ? 0 : paidIn - fees + winnings - paidOut,
  };
}

function payments(entries: PaymentEntry[]): PaymentsData {
  const players = users.map((member) => player(member, entries));
  const approved = entries.filter((item) => item.status === "approved");
  const total = (direction: "in" | "out") =>
    approved
      .filter((item) => item.direction === direction)
      .reduce((sum, item) => sum + item.amountCents, 0);
  return {
    season: 2026,
    bankerUserId,
    players,
    entries: [...entries].sort((a, b) => b.paidAt.localeCompare(a.paidAt)),
    users,
    summary: {
      collectedCents: total("in"),
      paidOutCents: total("out"),
      owedToBankerCents: players
        .filter((row) => row.balanceCents < 0)
        .reduce((sum, row) => sum - row.balanceCents, 0),
      owedByBankerCents: players
        .filter((row) => row.balanceCents > 0)
        .reduce((sum, row) => sum + row.balanceCents, 0),
      unawardedCents: 500,
    },
  };
}

let stored: PaymentEntry[];
let bankerUserId: number | null;
let writes: {
  method: string;
  path: string;
  body: unknown;
  csrf: string | null;
}[];

beforeEach(() => {
  stored = [
    entry({ id: 1, userId: 4, amountCents: 500, note: "Venmo @dan" }),
    entry({
      id: 2,
      userId: 2,
      amountCents: 2000,
      status: "voided",
      note: "Duplicate",
      paidAt: "2026-10-05T12:00:00.000Z",
      voidedAt: "2026-10-06T12:00:00.000Z",
    }),
    entry({
      id: 3,
      userId: null,
      amountCents: 700,
      source: "venmo_email",
      status: "pending",
      paidAt: "2026-10-07T12:00:00.000Z",
    }),
  ];
  writes = [];
  bankerUserId = 1;
  network.use(
    http.put(
      "http://localhost/api/admin/payments/banker",
      async ({ request }) => {
        const body = (await request.json()) as { userId: number | null };
        const url = new URL(request.url);
        writes.push({
          method: "PUT",
          path: url.pathname + url.search,
          body,
          csrf: request.headers.get("X-CSRF-Token"),
        });
        bankerUserId = body.userId;
        return HttpResponse.json(payments(stored));
      },
    ),
    http.get("http://localhost/api/session", () =>
      HttpResponse.json({ user: admin, csrfToken: "test-csrf" }),
    ),
    http.get("http://localhost/api/seasons", () =>
      HttpResponse.json({ currentSeason: 2026, seasons: [2026, 2025] }),
    ),
    http.get("http://localhost/api/admin/payments", () =>
      HttpResponse.json(payments(stored)),
    ),
    http.post("http://localhost/api/admin/payments", async ({ request }) => {
      const body = (await request.json()) as ManualPaymentInput;
      writes.push({
        method: "POST",
        path: "/api/admin/payments",
        body,
        csrf: request.headers.get("X-CSRF-Token"),
      });
      // Stands in for any server-side rejection the input constraints let through.
      if (body.amountCents === 999_999) {
        return HttpResponse.json(
          {
            error: "Invalid payment",
            fields: {
              amountCents: "Amount must be whole cents from 1 to 1000000",
            },
          },
          { status: 422 },
        );
      }
      stored = [
        ...stored,
        entry({ ...body, id: stored.length + 1, createdAt: body.paidAt }),
      ];
      return HttpResponse.json(payments(stored));
    }),
    http.post(
      "http://localhost/api/admin/payments/:id/void",
      ({ params, request }) => {
        const id = Number(params.id);
        writes.push({
          method: "POST",
          path: `/api/admin/payments/${id}/void`,
          body: null,
          csrf: request.headers.get("X-CSRF-Token"),
        });
        stored = stored.map((item) =>
          item.id === id
            ? { ...item, status: "voided", voidedAt: "2026-10-08T12:00:00Z" }
            : item,
        );
        return HttpResponse.json(payments(stored));
      },
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
afterEach(() => vi.unstubAllGlobals());

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function balances() {
  return screen.findByRole("table", { name: "2026 season balances" });
}

function balanceRow(table: HTMLElement, name: string) {
  return within(table).getByRole("row", { name: new RegExp(`^${name}\\b`) });
}

async function choose(combobox: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: combobox }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("payments ledger page", () => {
  it("states every balance in words and orders debtors before creditors", async () => {
    mount("/admin/payments?season=2026");
    const table = await balances();
    expect(
      screen.getByRole("heading", { level: 1, name: "Payments" }),
    ).toBeVisible();
    // The voided $20 from Bob does not count: he still owes his full fees.
    expect(balanceRow(table, "Bob")).toHaveTextContent("Owes $15.00");
    expect(balanceRow(table, "Cara")).toHaveTextContent("You owe $20.00");
    expect(balanceRow(table, "Dan")).toHaveTextContent("Settled");
    const banker = balanceRow(table, "Alice");
    expect(banker).toHaveTextContent("Banker");
    expect(banker).toHaveTextContent("Settled");
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent.trim()),
    ).toEqual(["Bob", "Cara", "Alice Banker", "Dan"]);

    const summary = screen.getByRole("region", { name: "Pool money" });
    expect(summary).toHaveTextContent("Collected$5.00");
    expect(summary).toHaveTextContent("Owed to you$15.00");
    expect(summary).toHaveTextContent("You owe$20.00");
    expect(summary).toHaveTextContent("Unawarded pots$5.00");
    expect(summary).toHaveTextContent("held by the banker");
    expect(screen.getByRole("combobox", { name: "Banker" })).toHaveTextContent(
      "Alice",
    );
  });

  it("shows voided, pending and unmatched entries without a void action", async () => {
    mount("/admin/payments?season=2026");
    const history = await screen.findByRole("table", {
      name: "2026 season payment history",
    });
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(
        /^Oct 7, 2026Unmatched.*\$7\.00Venmo email.*Pending review$/,
      ),
      expect.stringMatching(
        /^Oct 5, 2026Bob.*\$20\.00Manual.*DuplicateVoided$/,
      ),
      expect.stringMatching(/^Oct 4, 2026Dan.*Venmo @danApproved.*Void/),
    ]);
    const row = (name: RegExp) => within(history).getByRole("row", { name });
    const pending = row(/^Oct 7, 2026 Unmatched/);
    const voided = row(/^Oct 5, 2026 Bob/);
    const approved = row(/^Oct 4, 2026 Dan/);
    expect(within(voided).getByText("Duplicate")).toHaveClass("ledger-voided");
    expect(within(voided).getByText("$20.00")).toHaveClass("ledger-voided");
    expect(within(voided).getByText("Voided")).not.toHaveClass("ledger-voided");
    expect(within(voided).queryByRole("button")).toBeNull();
    expect(within(pending).queryByRole("button")).toBeNull();
    expect(
      within(approved).getByRole("button", {
        name: "Void $5.00 received from Dan on Oct 4, 2026",
      }),
    ).toBeVisible();
  });

  it("records a manual payment as whole cents with CSRF and updates the balance", async () => {
    mount("/admin/payments?season=2026");
    const table = await balances();
    await choose("Player", "Bob");
    await choose("Direction", "Received from player");
    await userEvent.type(screen.getByLabelText("Amount in dollars"), "12.50");
    const date = screen.getByLabelText("Date paid");
    expect(date).toHaveValue(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
      }).format(new Date()),
    );
    await userEvent.clear(date);
    await userEvent.type(date, "2026-10-09");
    await userEvent.type(screen.getByLabelText("Note (optional)"), " Venmo ");
    await userEvent.click(
      screen.getByRole("button", { name: "Record payment" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Recorded $12.50 received.",
    );
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/admin/payments",
        body: {
          season: 2026,
          userId: 2,
          direction: "in",
          amountCents: 1250,
          paidAt: "2026-10-09T12:00:00.000Z",
          note: "Venmo",
        },
        csrf: "test-csrf",
      },
    ]);
    expect(
      await within(table).findByRole("row", { name: /^Bob .*Owes \$2\.50/ }),
    ).toBeVisible();
    expect(screen.getByLabelText("Amount in dollars")).toHaveValue(null);
    expect(screen.getByRole("combobox", { name: "Player" })).toHaveTextContent(
      "Choose a player",
    );
  });

  it("requires a player and shows server field errors beside the field", async () => {
    mount("/admin/payments?season=2026");
    await balances();
    const amount = screen.getByLabelText("Amount in dollars");
    await userEvent.type(amount, "9999.99");
    await userEvent.click(
      screen.getByRole("button", { name: "Record payment" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Player" }),
    ).toHaveAccessibleDescription("Choose a player");
    expect(writes).toEqual([]);

    await choose("Player", "Cara");
    await choose("Direction", "Paid to player");
    await userEvent.click(
      screen.getByRole("button", { name: "Record payment" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid payment",
    );
    expect(amount).toHaveAttribute("aria-invalid", "true");
    expect(amount).toHaveAccessibleDescription(
      "Amount must be whole cents from 1 to 1000000",
    );
    expect(writes.map((write) => write.body)).toEqual([
      expect.objectContaining({
        userId: 3,
        direction: "out",
        amountCents: 999_999,
      }),
    ]);
  });

  it("voids an approved entry only after confirmation", async () => {
    mount("/admin/payments?season=2026");
    const table = await balances();
    expect(balanceRow(table, "Dan")).toHaveTextContent("Settled");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Void $5.00 received from Dan on Oct 4, 2026",
      }),
    );
    const confirmation = screen.getByRole("alert");
    expect(confirmation).toHaveTextContent(
      "Void $5.00 received from Dan on Oct 4, 2026?",
    );
    expect(
      within(confirmation).getByRole("button", { name: "Confirm void" }),
    ).toHaveFocus();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Keep entry" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writes).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Void $5.00 received from Dan on Oct 4, 2026",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm void" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Payment voided.",
    );
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/admin/payments/1/void",
        body: null,
        csrf: "test-csrf",
      },
    ]);
    expect(
      await within(table).findByRole("row", { name: /^Dan .*Owes \$5\.00/ }),
    ).toBeVisible();
    const history = screen.getByRole("table", {
      name: "2026 season payment history",
    });
    expect(within(history).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves the banker choice, including none", async () => {
    mount("/admin/payments?season=2026");
    const table = await balances();
    await choose("Banker", "None");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Banker cleared.",
    );
    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/api/admin/payments/banker?season=2026",
        body: { userId: null },
        csrf: "test-csrf",
      },
    ]);
    expect(
      await within(table).findByRole("row", { name: /^Alice .*Owes \$10\.00/ }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Banker" })).toHaveTextContent(
      "None",
    );
  });

  it("denies members without requesting payment data", async () => {
    const request = vi.fn(() => HttpResponse.json(payments([])));
    network.use(
      http.get("http://localhost/api/session", () =>
        HttpResponse.json({
          user: { ...admin, admin: false },
          csrfToken: "test-csrf",
        }),
      ),
      http.get("http://localhost/api/admin/payments", request),
    );
    mount("/admin/payments");
    expect(
      await screen.findByRole("heading", { name: "Access denied" }),
    ).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });
});
