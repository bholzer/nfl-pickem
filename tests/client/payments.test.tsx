import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/app";
import { venmoLink, venmoNote } from "../../src/client/payments-venmo";
import type {
  ManualPaymentInput,
  PaymentApprovalInput,
  PaymentEntry,
  PaymentPlayerBalance,
  PaymentsData,
  VenmoAccount,
  VenmoAccountInput,
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
    venmoName: null,
    venmoTransactionId: null,
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
    venmoAccounts: accounts,
    keywords,
  };
}

async function recordWrite(request: Request) {
  const url = new URL(request.url);
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  writes.push({
    method: request.method,
    path: url.pathname + url.search,
    body,
    csrf: request.headers.get("X-CSRF-Token"),
  });
  return body;
}

function setStatus(id: number, change: Partial<PaymentEntry>) {
  stored = stored.map((item) =>
    item.id === id ? { ...item, ...change } : item,
  );
  return HttpResponse.json(payments(stored));
}

// Stands in for the server's review, Venmo identity and import endpoints.
function venmoHandlers() {
  const base = "http://localhost/api/admin/payments";
  return [
    http.post(`${base}/:id/approve`, async ({ params, request }) => {
      const body = (await recordWrite(request)) as PaymentApprovalInput;
      return setStatus(Number(params.id), { ...body, status: "approved" });
    }),
    http.post(`${base}/:id/ignore`, async ({ params, request }) => {
      await recordWrite(request);
      return setStatus(Number(params.id), { status: "ignored" });
    }),
    http.post(`${base}/:id/reopen`, async ({ params, request }) => {
      await recordWrite(request);
      return setStatus(Number(params.id), { status: "pending" });
    }),
    http.put(`${base}/venmo/:userId`, async ({ params, request }) => {
      const body = (await recordWrite(request)) as VenmoAccountInput;
      const userId = Number(params.userId);
      const taken = body.displayNames.find((name) =>
        accounts.some(
          (account) =>
            account.userId !== userId && account.displayNames.includes(name),
        ),
      );
      if (taken || body.username === "ab") {
        return HttpResponse.json(
          {
            error: "Invalid Venmo account",
            fields: taken
              ? { displayNames: `${taken} already belongs to another player` }
              : { username: "Use 5 to 30 letters, digits, - or _" },
          },
          { status: 422 },
        );
      }
      accounts = [
        ...accounts.filter((account) => account.userId !== userId),
        { userId, ...body },
      ];
      return HttpResponse.json(payments(stored));
    }),
    http.put(`${base}/keywords`, async ({ request }) => {
      const body = (await recordWrite(request)) as { keywords: string[] };
      keywords = body.keywords.map((keyword) => keyword.toLowerCase());
      return HttpResponse.json(payments(stored));
    }),
    http.post(`${base}/import`, async ({ request }) => {
      await recordWrite(request);
      stored = [
        ...stored,
        entry({
          id: 50,
          userId: null,
          amountCents: 1500,
          source: "venmo_csv",
          status: "pending",
          venmoName: "New Sender",
          note: "Imported note",
          paidAt: "2026-10-09T12:00:00.000Z",
        }),
      ];
      return HttpResponse.json({
        data: payments(stored),
        result: { approved: 12, pending: 3, duplicates: 20, skipped: 5 },
      });
    }),
  ];
}

let stored: PaymentEntry[];
let bankerUserId: number | null;
let accounts: VenmoAccount[];
let keywords: string[];
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
      venmoName: "Robert B",
      venmoTransactionId: "4000000000000000003",
      note: "Pick'em week 5 🏈 and the lunch I owe you from Sunday",
      paidAt: "2026-10-07T12:00:00.000Z",
    }),
    entry({
      id: 4,
      userId: 3,
      direction: "out",
      amountCents: 1000,
      source: "venmo_csv",
      status: "pending",
      venmoName: "Cara Example",
      venmoTransactionId: "4000000000000000004",
      note: "Dinner",
      paidAt: "2026-10-08T12:00:00.000Z",
    }),
  ];
  writes = [];
  bankerUserId = 1;
  accounts = [
    { userId: 2, username: "bob-venmo", displayNames: ["Bobby Example"] },
    { userId: 3, username: null, displayNames: ["Cara Example"] },
  ];
  keywords = ["pickem"];
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
    ...venmoHandlers(),
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

  it("labels history entries and keeps pending entries in the queue", async () => {
    stored = [
      ...stored,
      entry({
        id: 5,
        userId: null,
        amountCents: 1200,
        source: "venmo_csv",
        status: "ignored",
        venmoName: "Zed Stranger",
        note: "Rent",
        paidAt: "2026-10-03T12:00:00.000Z",
      }),
      entry({
        id: 6,
        userId: 2,
        amountCents: 500,
        source: "venmo_csv",
        venmoName: "Bobby Example",
        note: "pickem",
        paidAt: "2026-10-02T12:00:00.000Z",
      }),
    ];
    mount("/admin/payments?season=2026");
    const history = await screen.findByRole("table", {
      name: "2026 season payment history",
    });
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(
        /^Oct 5, 2026Bob.*\$20\.00Manual.*DuplicateVoided$/,
      ),
      expect.stringMatching(/^Oct 4, 2026Dan.*Venmo @danApproved.*Void/),
      expect.stringMatching(
        /^Oct 3, 2026UnmatchedVenmo: Zed Stranger.*\$12\.00Venmo CSVRentIgnored/,
      ),
      expect.stringMatching(
        /^Oct 2, 2026BobVenmo: Bobby Example.*Venmo CSVpickemApproved/,
      ),
    ]);
    const row = (name: RegExp) => within(history).getByRole("row", { name });
    const voided = row(/^Oct 5, 2026 Bob/);
    const manual = row(/^Oct 4, 2026 Dan/);
    const ignored = row(/^Oct 3, 2026 Unmatched/);
    const venmo = row(/^Oct 2, 2026 Bob/);
    expect(within(voided).getByText("Duplicate")).toHaveClass("ledger-voided");
    expect(within(voided).getByText("$20.00")).toHaveClass("ledger-voided");
    expect(within(voided).getByText("Voided")).not.toHaveClass("ledger-voided");
    expect(within(voided).queryByRole("button")).toBeNull();
    const buttons = (item: HTMLElement) =>
      within(item)
        .queryAllByRole("button")
        .map((button) => button.textContent);
    expect(buttons(manual)).toEqual([
      "Void $5.00 received from Dan on Oct 4, 2026",
    ]);
    expect(within(ignored).getByText("Rent")).toHaveClass("ledger-ignored");
    expect(within(ignored).getByText("Ignored")).toHaveClass("badge");
    expect(buttons(ignored)).toEqual([
      "Reopen $12.00 received from an unmatched sender on Oct 3, 2026",
    ]);
    expect(buttons(venmo)).toEqual([
      "Reopen $5.00 received from Bob on Oct 2, 2026",
      "Void $5.00 received from Bob on Oct 2, 2026",
    ]);
    expect(within(history).queryByText(/Pending review/)).toBeNull();
    expect(within(history).queryByText(/Robert B|Cara Example/)).toBeNull();
  });

  it("reopens an imported entry into the review queue", async () => {
    stored = [
      entry({
        id: 6,
        userId: 2,
        amountCents: 500,
        source: "venmo_csv",
        venmoName: "Bobby Example",
        note: "pickem",
      }),
    ];
    mount("/admin/payments?season=2026");
    const table = await balances();
    expect(balanceRow(table, "Bob")).toHaveTextContent("Owes $10.00");
    expect(
      screen.getByRole("heading", { name: "Needs review (0)" }),
    ).toBeVisible();
    expect(screen.getByText("No imported payments need review.")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Reopen $5.00 received from Bob on Oct 4, 2026",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Payment returned to review.",
    );
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/admin/payments/6/reopen",
        body: null,
        csrf: "test-csrf",
      },
    ]);
    expect(
      await screen.findByRole("heading", { name: "Needs review (1)" }),
    ).toBeVisible();
    expect(balanceRow(table, "Bob")).toHaveTextContent("Owes $15.00");
    expect(
      screen.getByText("No payments recorded for the 2026 season yet."),
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

function reviewItem(name: RegExp) {
  const list = screen.getByRole("list", { name: "Payments to review" });
  return within(list)
    .getAllByRole("listitem")
    .find((item) => name.test(item.textContent)) as HTMLElement;
}

describe("Venmo review queue", () => {
  it("shows each pending payment in full with a pre-selected player", async () => {
    mount("/admin/payments?season=2026");
    expect(
      await screen.findByRole("heading", { name: "Needs review (2)" }),
    ).toBeVisible();
    const unmatched = reviewItem(/Robert B/);
    expect(unmatched).toHaveTextContent("Received from Robert B$7.00");
    expect(unmatched).toHaveTextContent("Oct 7, 2026 · Venmo email");
    expect(
      within(unmatched).getByText(
        "Pick'em week 5 🏈 and the lunch I owe you from Sunday",
      ),
    ).toBeVisible();
    const description = "$7.00 received from Robert B on Oct 7, 2026";
    expect(
      within(unmatched).getByRole("combobox", {
        name: `Player for ${description}`,
      }),
    ).toHaveTextContent("Choose player");
    expect(
      within(unmatched).getByRole("combobox", {
        name: `Season for ${description}`,
      }),
    ).toHaveTextContent("2026 season");
    expect(
      within(unmatched).getByRole("button", { name: `Approve ${description}` }),
    ).toBeDisabled();
    expect(
      within(unmatched).getByRole("button", { name: `Ignore ${description}` }),
    ).toBeEnabled();

    const matched = reviewItem(/Cara Example/);
    expect(matched).toHaveTextContent("Paid to Cara Example$10.00");
    expect(
      within(matched).getByRole("combobox", { name: /^Player for / }),
    ).toHaveTextContent("Cara");
    expect(
      within(matched).getByRole("button", { name: /^Approve / }),
    ).toBeEnabled();
  });

  it("approves with the chosen player and season, then ignores", async () => {
    mount("/admin/payments?season=2026");
    await screen.findByRole("heading", { name: "Needs review (2)" });
    const description = "$7.00 received from Robert B on Oct 7, 2026";
    await choose(`Player for ${description}`, "Bob");
    await choose(`Season for ${description}`, "2025 season");
    await userEvent.click(
      screen.getByRole("button", { name: `Approve ${description}` }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Payment approved.",
    );
    expect(
      await screen.findByRole("heading", { name: "Needs review (1)" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Ignore $10.00 paid to Cara Example on Oct 8, 2026",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Payment ignored.",
    );
    expect(
      await screen.findByRole("heading", { name: "Needs review (0)" }),
    ).toBeVisible();
    expect(screen.getByText("No imported payments need review.")).toBeVisible();
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/admin/payments/3/approve",
        body: { userId: 2, season: 2025 },
        csrf: "test-csrf",
      },
      {
        method: "POST",
        path: "/api/admin/payments/4/ignore",
        body: null,
        csrf: "test-csrf",
      },
    ]);
  });

  it("explains a conflict from the server beside the queue", async () => {
    network.use(
      http.post("http://localhost/api/admin/payments/:id/ignore", () =>
        HttpResponse.json(
          { error: "Only a pending payment can be ignored" },
          { status: 409 },
        ),
      ),
    );
    mount("/admin/payments?season=2026");
    await screen.findByRole("heading", { name: "Needs review (2)" });
    await userEvent.click(
      screen.getByRole("button", {
        name: "Ignore $10.00 paid to Cara Example on Oct 8, 2026",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a pending payment can be ignored",
    );
  });
});

describe("Venmo setup", () => {
  async function openAccounts() {
    await balances();
    const summary = screen.getByText("Venmo accounts", { exact: false });
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await userEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
  }

  it("saves a player's Venmo username and names", async () => {
    mount("/admin/payments?season=2026");
    await openAccounts();
    expect(screen.getByText("(2 of 4 set up)")).toBeVisible();
    const bob = screen.getByRole("form", { name: "Venmo for Bob" });
    expect(within(bob).getByLabelText("Venmo username")).toHaveValue(
      "bob-venmo",
    );
    expect(within(bob).getByLabelText("Venmo names, one per line")).toHaveValue(
      "Bobby Example",
    );
    const dan = screen.getByRole("form", { name: "Venmo for Dan" });
    await userEvent.type(
      within(dan).getByLabelText("Venmo username"),
      " @dan-the-man ",
    );
    await userEvent.type(
      within(dan).getByLabelText("Venmo names, one per line"),
      "Dan Example{Enter}{Enter} Danny E ",
    );
    await userEvent.click(
      within(dan).getByRole("button", { name: "Save Venmo for Dan" }),
    );
    expect(
      await within(
        screen.getByRole("form", { name: "Venmo for Dan" }),
      ).findByRole("status"),
    ).toHaveTextContent("Saved.");
    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/api/admin/payments/venmo/4?season=2026",
        body: {
          username: "dan-the-man",
          displayNames: ["Dan Example", "Danny E"],
        },
        csrf: "test-csrf",
      },
    ]);
    expect(await screen.findByText("(3 of 4 set up)")).toBeVisible();
  });

  it("shows field errors beside the Venmo account fields", async () => {
    mount("/admin/payments?season=2026");
    await openAccounts();
    const cara = () => screen.getByRole("form", { name: "Venmo for Cara" });
    const names = within(cara()).getByLabelText("Venmo names, one per line");
    await userEvent.clear(names);
    await userEvent.type(names, "A{Enter}B{Enter}C{Enter}D{Enter}E{Enter}F");
    await userEvent.click(
      within(cara()).getByRole("button", { name: "Save Venmo for Cara" }),
    );
    expect(names).toHaveAccessibleDescription("Enter up to 5 names.");
    expect(writes).toEqual([]);

    await userEvent.clear(names);
    await userEvent.type(names, "Bobby Example");
    await userEvent.click(
      within(cara()).getByRole("button", { name: "Save Venmo for Cara" }),
    );
    expect(await within(cara()).findByRole("alert")).toHaveTextContent(
      "Invalid Venmo account",
    );
    expect(names).toHaveAttribute("aria-invalid", "true");
    expect(names).toHaveAccessibleDescription(
      "Bobby Example already belongs to another player",
    );

    const username = within(cara()).getByLabelText("Venmo username");
    await userEvent.clear(names);
    await userEvent.type(names, "Cara Example");
    await userEvent.type(username, "ab");
    await userEvent.click(
      within(cara()).getByRole("button", { name: "Save Venmo for Cara" }),
    );
    expect(
      await within(cara()).findByText("Use 5 to 30 letters, digits, - or _"),
    ).toBeVisible();
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(names).not.toHaveAttribute("aria-invalid");
    // Another player's form does not inherit Cara's error.
    expect(
      within(screen.getByRole("form", { name: "Venmo for Dan" })).queryByRole(
        "alert",
      ),
    ).toBeNull();
  });

  it("saves the keyword list and explains the approval rule", async () => {
    mount("/admin/payments?season=2026");
    await balances();
    expect(
      screen.getByText(
        /approved automatically only when its note contains a keyword and its Venmo name belongs to a player/,
      ),
    ).toBeVisible();
    const input = screen.getByLabelText("Keywords, separated by commas");
    expect(input).toHaveValue("pickem");
    await userEvent.clear(input);
    await userEvent.type(input, "pickem, NFL pool,, ");
    await userEvent.click(
      screen.getByRole("button", { name: "Save keywords" }),
    );
    expect(await screen.findByText("Keywords saved.")).toBeVisible();
    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/api/admin/payments/keywords?season=2026",
        body: { keywords: ["pickem", "NFL pool"] },
        csrf: "test-csrf",
      },
    ]);
  });

  it("imports a statement and reports the counts in words", async () => {
    mount("/admin/payments?season=2026");
    await balances();
    const csv = "Account Statement\n,ID,Datetime\n,4000,2026-09-10T18:22:11\n";
    const submit = screen.getByRole("button", { name: "Import statement" });
    expect(submit).toBeDisabled();
    await userEvent.upload(
      screen.getByLabelText("Statement CSV"),
      new File([csv], "statement.csv", { type: "text/csv" }),
    );
    await userEvent.click(submit);
    expect(
      await screen.findByText(
        "Import finished: 12 approved, 3 need review, 20 already imported, 5 skipped.",
      ),
    ).toHaveAttribute("role", "status");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/admin/payments/import?season=2026",
        body: { csv },
        csrf: "test-csrf",
      },
    ]);
    expect(
      await screen.findByRole("heading", { name: "Needs review (3)" }),
    ).toBeVisible();
    expect(reviewItem(/New Sender/)).toHaveTextContent("Imported note");
  });

  it("rejects a statement over 2 MB before uploading it", async () => {
    mount("/admin/payments?season=2026");
    await balances();
    const input = screen.getByLabelText("Statement CSV");
    await userEvent.upload(
      input,
      new File(["x".repeat(2 * 1024 * 1024 + 1)], "big.csv", {
        type: "text/csv",
      }),
    );
    expect(input).toHaveAccessibleDescription(/larger than 2 MB/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("button", { name: "Import statement" }),
    ).toBeDisabled();
    expect(writes).toEqual([]);
  });
});

describe("Venmo request and pay links", () => {
  it("links only non-banker players with a username and a balance", async () => {
    accounts = [
      ...accounts.filter((account) => account.userId !== 3),
      { userId: 3, username: "cara-c", displayNames: [] },
      { userId: 1, username: "alice-bank", displayNames: [] },
      { userId: 4, username: "dan-d", displayNames: [] },
    ];
    mount("/admin/payments?season=2026");
    const table = await balances();
    const request = within(balanceRow(table, "Bob")).getByRole("link", {
      name: "Request $15.00 from Bob on Venmo (opens in a new tab)",
    });
    expect(request).toHaveAttribute(
      "href",
      "https://venmo.com/?txn=charge&audience=private&recipients=bob-venmo&amount=15.00&note=Pick%27em%202026%20pickem",
    );
    expect(request).toHaveAttribute("target", "_blank");
    expect(request).toHaveAttribute("rel", "noopener noreferrer");
    expect(request).toHaveClass("text-link");
    expect(
      within(balanceRow(table, "Cara")).getByRole("link", {
        name: "Pay $20.00 to Cara on Venmo (opens in a new tab)",
      }),
    ).toHaveAttribute(
      "href",
      "https://venmo.com/?txn=pay&audience=private&recipients=cara-c&amount=20.00&note=Pick%27em%202026%20pickem",
    );
    // Settled players and the banker have nothing to request or pay.
    expect(within(balanceRow(table, "Dan")).queryByRole("link")).toBeNull();
    expect(within(balanceRow(table, "Alice")).queryByRole("link")).toBeNull();
  });

  it("omits the Venmo column when nobody can be linked", async () => {
    accounts = accounts.map((account) => ({ ...account, username: null }));
    mount("/admin/payments?season=2026");
    const table = await balances();
    expect(within(table).queryByRole("link")).toBeNull();
    expect(
      within(table).queryByRole("columnheader", { name: "Venmo" }),
    ).toBeNull();
  });
});

describe("Venmo link builder", () => {
  it("adds the first keyword to the note unless the note already has it", () => {
    expect(venmoNote(2026, [])).toBe("Pick'em 2026");
    expect(venmoNote(2026, ["pickem", "pool"])).toBe("Pick'em 2026 pickem");
    expect(venmoNote(2026, ["PICK'EM"])).toBe("Pick'em 2026");
    expect(venmoNote(2027, ["2027"])).toBe("Pick'em 2027");
  });

  it("encodes the note strictly and formats whole-cent amounts", () => {
    const link = venmoLink({
      txn: "charge",
      username: "@Some_User-1",
      amountCents: -123456,
      note: "Pick'em 2026 🏈 (week 1)!",
    });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://venmo.com/");
    expect(link).toBe(
      "https://venmo.com/?txn=charge&audience=private&recipients=Some_User-1&amount=1234.56&note=Pick%27em%202026%20%F0%9F%8F%88%20%28week%201%29%21",
    );
    expect(url.searchParams.get("note")).toBe("Pick'em 2026 🏈 (week 1)!");
    expect(
      new URL(
        venmoLink({ txn: "pay", username: "x", amountCents: 5, note: "" }),
      ).searchParams.get("amount"),
    ).toBe("0.05");
    expect(
      new URL(
        venmoLink({ txn: "pay", username: "x", amountCents: 1000, note: "" }),
      ).searchParams.get("amount"),
    ).toBe("10.00");
  });
});
